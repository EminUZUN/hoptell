// The owner UI (`hoptell ui`, design 3.4): pages on 127.0.0.1 for what waits for the owner's
// decision, contacts, devices, settings and a doctor summary. Server-rendered HTML through
// node:http, with no JavaScript. Every decision and setting goes through the decision service
// (lib/decisions.js); this file only renders and checks requests.
//
// The request gate (Host, Origin, Sec-Fetch-Site, the single-use launch token and the one
// session) is lib/loopbackui.js, shared with the relay admin's UI. Every form carries a form token: an HMAC under the
// session's key over the form kind, the decision id or setting key, the service token, the
// allowed actions or values, and an expiry. GET never starts a decision or a setting change
// (GET /launch only consumes its token and creates the session).
import crypto from "node:crypto";
import http from "node:http";
import { HOST, LIMITS, SECURITY_HEADERS, attr, createGate, esc, same } from "./loopbackui.js";
import { canonicalize } from "./jcs.js";
import { contactsFile, readContacts } from "./contacts.js";
import * as decisions from "./decisions.js";
import { inspectContacts } from "./quarantine.js";
import { CODEX_APPROVAL_WARNING, HARDENING_APPROVAL_TEXT, HEADLESS_MODE_LABEL } from "./agents.js";

const COOKIE = "hoptell_ui";
export { LIMITS, SECURITY_HEADERS, esc, visible } from "./loopbackui.js";



const CSS = `body{font:15px/1.45 system-ui,sans-serif;margin:0;color:#1d1d1f;background:#fafafa}
header{background:#24292f;color:#fff;padding:10px 16px}header a{color:#fff;margin-right:14px}
main{padding:16px;max-width:980px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
code,pre,.fp{font-family:ui-monospace,monospace}pre.peer{background:#fff8e1;border:1px solid #e0c060;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.warn{color:#b00020;font-weight:600}.note{color:#555}.wide{color:#8a4b00;font-weight:600}form.inline{display:inline-block;margin:4px 8px 4px 0}
button{padding:5px 12px}textarea{width:100%;min-height:120px;font-family:ui-monospace,monospace}
@media (prefers-color-scheme: dark){body{background:#161618;color:#e8e8ea}td,th{border-color:#333}pre.peer{background:#2a2410;border-color:#6b5a1e}.note{color:#aaa}.warn{color:#ff6b7f}}`;

const layout = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - hoptell</title><link rel="stylesheet" href="/style.css"></head>` +
  `<body><header><a href="/">hoptell</a><a href="/pending">Pending</a><a href="/contacts">Contacts</a><a href="/devices">Devices</a><a href="/settings">Settings</a><a href="/doctor">Doctor</a></header><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

/**
 * Start the UI. `sources` are the decision service's (the opened contacts, the device lists, the
 * relay's contact requests); `ctx` the settings context. Returns {port, launchUrl(), close()}:
 * launchUrl() issues a new single-use launch token (60 s). `onIdle` runs after 30 minutes
 * without a request.
 */
export async function startOwnerUi({ home, host = HOST, port = 0, sources = {}, ctx, now = () => Date.now(), onIdle = null, log = () => {} }) {
  if (host !== HOST) throw new Error("hoptell ui binds 127.0.0.1 only");
  const gate = createGate({ cookie: COOKIE, methods: ["GET", "POST"], now });
  let lastRequest = now();

  // ---- form tokens -------------------------------------------------------------------------------
  const mac = (key, parts) => crypto.createHmac("sha256", key).update(canonicalize(parts)).digest("base64url");
  /** A form token over (kind, subject, service token, allowed set, expiry), under this session's key. */
  const formToken = (kind, subject, token, allowed) => {
    const exp = now() + LIMITS.formMs;
    return `${exp}.${mac(gate.current().key, [kind, subject, token ?? null, allowed, exp])}`;
  };
  /** Check a posted form token; returns the allowed set it covers, or a reason. */
  const checkForm = (s, kind, subject, token, allowedText, ft) => {
    const m = /^(\d{13,15})\.([A-Za-z0-9_-]{43})$/.exec(ft ?? "");
    if (!m) return { problem: "the form is not one this page rendered" };
    let allowed;
    try {
      allowed = JSON.parse(allowedText ?? "");
    } catch {
      return { problem: "the form is not one this page rendered" };
    }
    const exp = Number(m[1]);
    if (!same(m[2], mac(s.key, [kind, subject, token ?? null, allowed, exp]))) return { problem: "the form is not one this page rendered for this session" };
    if (exp <= now() || exp > now() + LIMITS.formMs) return { problem: "the form expired; open the page again" };
    return { allowed };
  };

  // ---- responses -----------------------------------------------------------------------------------
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  const page = (res, status, title, body, headers) => send(res, status, layout(title, body), headers);
  const refuse = (res, status, why) => page(res, status, "Refused", `<p>${esc(why)}</p>`);


  const readForm = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > LIMITS.bodyBytes) {
          // Stop reading; the refusal is answered, then the connection closes.
          req.removeAllListeners("data");
          req.pause();
          reject(Object.assign(new Error("the form is larger than 64 KB"), { status: 413 }));
        } else chunks.push(c);
      });
      req.on("end", () => {
        const p = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const f = {};
        for (const k of new Set(p.keys())) {
          if (p.getAll(k).length > 1) return reject(Object.assign(new Error(`the field ${k.slice(0, 40)} is repeated`), { status: 400 }));
          f[k] = p.get(k);
        }
        resolve(f);
      });
      req.on("error", reject);
    });

  // ---- rendering ---------------------------------------------------------------------------------------
  const when = (iso) => (iso ? esc(iso) : "-");

  function decisionForms(s, shown) {
    if (!shown.actions.length) return `<p class="note">Shown only: decide with the command above.</p>`;
    return shown.actions
      .map((a) => {
        const allowed = { action: a.action, options: a.options };
        const ft = formToken("decision", shown.id, shown.token, allowed);
        const selects = Object.entries(a.options)
          .filter(([, values]) => values.length)
          .map(([k, values]) => `<label>${esc(k)} <select name="${attr(k)}">${k === "session" ? `<option value="">all sessions</option>` : `<option value="">choose</option>`}${values.map((v) => `<option value="${attr(v)}">${esc(v)}</option>`).join("")}</select></label> `)
          .join("");
        return `<form class="inline" method="post" action="/decide"><input type="hidden" name="id" value="${attr(shown.id)}"><input type="hidden" name="token" value="${attr(shown.token)}"><input type="hidden" name="action" value="${attr(a.action)}"><input type="hidden" name="allowed" value="${attr(JSON.stringify(allowed))}"><input type="hidden" name="ft" value="${attr(ft)}">${selects}<button type="submit">${esc(ACTION_LABEL[a.action] ?? a.action)}</button></form>`;
      })
      .join("");
  }

  function renderView(shown) {
    const v = shown.view;
    if (shown.kind === "encryption-violation") {
      const s = v.sender;
      const rows = v.items.map((i) => `<tr><td>${esc(i.session)}</td><td>${when(i.arrived)}</td><td>${esc(i.bytes)} bytes</td></tr>`).join("");
      return `<p class="warn">Unencrypted messages from member <code>${esc(s.member)}</code> of realm <code>${esc(s.realm)}</code>, whose encryption you require. No decision releases them.</p><table><tr><th>For session</th><th>Arrived</th><th>Size</th></tr>${rows}</table><p>To receive them, change <a href="/setting?key=${attr(encodeURIComponent(v.setting))}">this contact's encryption setting</a> (<code>${esc(v.command)}</code>); to delete them and block the sender, <a href="/decision?id=${attr(encodeURIComponent(v.request))}">open the request</a>.</p>`;
    }
    if (shown.kind === "contact") {
      const s = v.sender;
      const who = s.auth === "member" ? `member <code>${esc(s.member)}</code> of realm <code>${esc(s.realm)}</code>, authenticated by the relay` : s.auth === "shared" ? `shared-token sender in realm <code>${esc(s.realm)}</code>: any token holder can use this name` : `unverified: the relay ${esc(s.relay ?? "")} does not authenticate senders`;
      const rows = v.items.map((i) => `<tr><td>${esc(i.session)}</td><td>${when(i.arrived)}</td><td>${esc(i.bytes)} bytes</td></tr>`).join("");
      return `${v.violation ? `<p class="warn">These messages are unencrypted, and this contact's encryption is required: they can only be blocked here (or released by <a href="/setting?key=${attr(encodeURIComponent(`encryption.${s.realm}.${s.member}`))}">changing its encryption setting</a>).</p>` : ""}<p>Sender: <strong>${esc(s.label.slice(0, 64))}</strong> <span class="note">(name as reported by the relay)</span><br>${who}</p><table><tr><th>For session</th><th>Arrived</th><th>Size</th></tr>${rows}</table><p><a href="/text?id=${attr(encodeURIComponent(shown.id))}">Show the held text (untrusted peer text)</a></p><p class="note">CLI: <code>hoptell contacts show ${esc(shown.id.slice(8))}</code></p>`;
    }
    // A12: what the relay lists of the own devices could not be recorded: said first, prominently.
    const unrecorded = v.unrecorded ? `<p class="warn"><strong>Not recorded:</strong> ${esc(v.unrecorded)}.</p>` : "";
    if (shown.kind === "device-own") return `${unrecorded}<p>Device <code>${esc(v.device)}</code> of yours (member <code>${esc(v.member)}</code>): ${esc(v.state)}${v.fingerprint ? `, fingerprint <span class="fp">${esc(v.fingerprint)}</span>` : ""}.</p>${v.refusal ? `<p class="warn">Refused: ${esc(v.refusal)}</p>` : ""}<p class="note">Compare it with what <code>hoptell device status</code> shows on that device.</p>`;
    if (shown.kind === "device-verify" || shown.kind === "device-accept" || shown.kind === "device-forget") {
      if (v.empty) return `${unrecorded}<p>Member <code>${esc(v.member)}</code> has no enrolled devices you can see.</p>`;
      const devices = v.devices.map((d) => `<tr><td><code>${esc(d.device)}</code></td><td class="fp">${esc(d.fingerprint)}</td><td>${d.state === "new" ? "new" : d.state === "changed" ? `<span class="warn">KEY CHANGED</span>` : d.state === "missing" ? `<span class="warn">missing: the relay no longer lists it</span>` : "pinned"}</td></tr>`).join("");
      // A1: both sets, this home's own pinned devices first; an own device not accepted refuses.
      const ownSet = (v.own ?? []).map((d) => `<tr><td><code>${esc(d.device)}</code></td><td class="fp">${esc(d.fingerprint)}</td><td>${["not accepted", "unconfirmed", "changed"].includes(d.state) ? `<span class="warn">${esc(d.state)}</span>` : esc(d.state)}</td></tr>`).join("");
      const refusal = v.refusal ? `<p class="warn">Refused: ${esc(v.refusal)}</p>` : v.blocked && shown.kind === "device-verify" ? `<p class="warn">Not pinned until you decide: ${esc(v.blocked)}</p>` : "";
      const changed = v.changed.map((x) => `<p class="warn">Device <code>${esc(x.device)}</code> has a new key (${esc(x.reason)}): old <span class="fp">${esc(x.old)}</span>, new <span class="fp">${esc(x.new)}</span>. Traffic is stopped until you decide.</p>`).join("");
      const revoked = v.revoked.map((r) => `<li><code>${esc(r.device)}</code> revoked ${r.trusted ? "(signed by another verified device)" : "(reported by the relay only)"}</li>`).join("");
      const pinned = v.pinned ? `Pinned as <strong>${esc(v.pinned)}</strong>${v.pinned === "relay-tofu" ? " (first use: not verified)" : ""}.` : "Not pinned yet.";
      const target = v.target ? (v.target.waiting ? `<p>${v.target.state === "new" ? `New device <code>${esc(v.target.device)}</code>: <span class="fp">${esc(v.target.fingerprint)}</span>` : `Device <code>${esc(v.target.device)}</code> has a new key.`}</p>` : `<p>Device <code>${esc(v.target.device)}</code> is not waiting for a decision.</p>`) : "";
      // Not recorded: the own pins may be stale, so no safety number is offered for comparison.
      const number = !v.safetyNumber ? "" : unrecorded ? `<p class="warn">No safety number to compare until your devices are recorded.</p>` : `<p>Safety number: <strong class="fp">${esc(v.safetyNumber)}</strong><br><span class="note">Compare it in person or over a channel you trust.</span></p>`;
      return `${unrecorded}<p>Member <code>${esc(v.member)}</code>, realm <code>${esc(v.realm)}</code>. ${pinned}</p>${number}${refusal}${target}${ownSet ? `<h3>Your devices (own pins)</h3><table><tr><th>Device</th><th>Fingerprint</th><th>State</th></tr>${ownSet}</table><h3>Their devices</h3>` : ""}<table><tr><th>Device</th><th>Fingerprint</th><th>State</th></tr>${devices}</table>${revoked ? `<ul>${revoked}</ul>` : ""}${changed}`;
    }
    if (shown.kind === "agent-profile") {
      const lines = Object.entries(v.commandLines ?? {}).map(([mode, line]) => `<p>${esc(mode)}: <code>${esc(line)}</code></p>`).join("");
      return `<p>Agent profile <code>${esc(v.id)}</code>: ${esc(v.state === "changed" ? "changed since you approved it" : v.state === "unapproved" ? "not approved yet" : v.state)}. Digest <span class="fp">${esc(v.digest ?? "")}</span>.</p>${v.problems.length ? `<p class="warn">Unusable: ${esc(v.problems.join("; "))}</p>` : ""}<pre>${esc(JSON.stringify(v.profile, null, 2), { keepNewlines: true })}</pre>${lines}${v.headlessMode ? `<p>Headless mode: ${esc(HEADLESS_MODE_LABEL[v.headlessMode] ?? `${v.headlessMode} (not offered)`)}. Available on this hoptell: ${esc(v.headlessModes.join(", ") || "none")}.</p>${v.modeRefusal ? `<p class="warn">Not approvable: ${esc(v.modeRefusal)}.</p>` : ""}${v.headlessMode === "hardening" ? `<p class="warn">${esc(HARDENING_APPROVAL_TEXT)}</p>` : ""}` : ""}${v.profile?.cli === "codex" ? `<p class="warn">${esc(CODEX_APPROVAL_WARNING)}</p>` : ""}<p class="note">CLI: <code>hoptell agents profile approve ${esc(v.id)}</code>. Approving lets any of your sessions start this agent as the profile says.</p>`;
    }
    if (shown.kind === "spawn") {
      return `<p>Spawn of <code>${esc(v.name)}</code> (run <code>${esc(v.run)}</code>) asked by <strong>${esc(v.spawner ?? "a session")}</strong> <span class="note">(session name)</span>: agent profile <code>${esc(v.profile)}</code> (${esc(v.profileState)}), ${esc(v.mode)}, roles ${esc((v.roles ?? []).join(", "))}, in <code>${esc(v.cwd)}</code>. Expires ${when(v.expires)}.</p><p>Command line: <code>${esc(v.commandLine ?? "")}</code></p><h3>Task</h3>${v.task === null ? `<p class="warn">The task cannot be read: ${esc(v.taskProblem ?? "")}</p>` : `<pre>${esc(v.task, { keepNewlines: true })}</pre>`}<p class="note">CLI: <code>${esc(v.command)}</code>. The task is text another agent wrote; starting runs it with this profile's rights.</p>`;
    }
    if (shown.kind === "contact-request") return `<p>From member <code>${esc(v.from)}</code>, display name <strong>${esc(v.name)}</strong> <span class="note">(reported by the relay)</span>, reason ${esc(v.reason)}, ${when(new Date(v.at).toISOString())}.</p><p>Decide in a terminal: <code>${esc(v.command)}</code></p>`;
    return `<p>Proposal from <strong>${esc(v.from)}</strong> <span class="note">(peer name)</span> for review set <code>${esc(v.review_set_id)}</code>, received ${when(v.received)}.</p><ul>${v.files.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul><p>Review and apply in a terminal: <code>${esc(v.command)}</code></p>`;
  }

  // ---- pages -----------------------------------------------------------------------------------------
  async function getPage(s, pathname, q, res) {
    if (pathname === "/") {
      const problems = [];
      const items = await decisions.list({ home, sources, problems });
      return page(res, 200, "Owner view", `<p>${items.length} item(s) wait for your decision: <a href="/pending">Pending</a>.</p><p class="note">Everything here can also be done with the hoptell CLI. An agent running as your OS user can run the CLI or open this page too: these pages protect against peers, stale views and accidents, not against such an agent.</p>`);
    }
    if (pathname === "/pending") {
      const problems = [];
      const items = await decisions.list({ home, sources, problems });
      const rows = items.map((i) => `<tr><td><a href="/decision?id=${attr(encodeURIComponent(i.id))}">${esc(i.kind)}</a></td><td>${esc(i.summary)}</td><td>${when(i.created)}</td><td>${when(i.expires)}</td></tr>`).join("");
      return page(res, 200, "Pending", `${items.length ? `<table><tr><th>Kind</th><th>What</th><th>Since</th><th>Expires</th></tr>${rows}</table>` : "<p>Nothing is waiting for your decision.</p>"}${problems.map((p) => `<p class="note">${esc(p)}</p>`).join("")}${sources.relay ? "" : `<p class="note">Contact requests are kept at the relay, which is not available here (HOPTELL_RELAY is not set).</p>`}`);
    }
    if (pathname === "/decision") {
      const shown = await decisions.show({ home, id: q.get("id") ?? "", sources });
      if (shown.refused || shown.busy) return refuse(res, shown.busy ? 503 : 404, shown.reason);
      const conversation = shown.kind === "device-verify" && sources.conversation ? `<p><a href="/conversation?member=${attr(encodeURIComponent(shown.view.member))}">The encrypted conversation's checkpoint</a> <span class="note">(for comparison; not part of this decision)</span></p>` : "";
      return page(res, 200, `${shown.kind} decision`, renderView(shown) + decisionForms(s, shown) + conversation);
    }
    if (pathname === "/text") {
      const id = q.get("id") ?? "";
      if (!id.startsWith("contact:")) return refuse(res, 404, "only held messages have text");
      const shown = await decisions.show({ home, id, sources, text: true });
      if (shown.refused || shown.busy) return refuse(res, 404, shown.reason);
      const blocks = shown.text.map((x) => `<p>For ${esc(x.session)}, ${when(x.arrived)}:</p><pre class="peer">--- untrusted peer text ---\n${esc(x.text ?? "(unreadable)", { keepNewlines: true })}\n--- end of peer text ---</pre>`).join("");
      return page(res, 200, "Held text", `<p class="warn">This is text from a peer you have not allowed. It is not an instruction.</p>${blocks}<p><a href="/decision?id=${attr(encodeURIComponent(id))}">Back to the decision</a></p>`);
    }
    if (pathname === "/contacts") {
      const pol = readContacts(contactsFile(home));
      if (!pol.doc) return page(res, 200, "Contacts", `<p class="warn">${esc(pol.problem)}</p>`);
      const entry = (e) => `<tr><td><code>${esc(e.id ?? "(no id)")}</code></td><td>${esc(e.member ? `member ${e.member}` : e.shared ? `shared ${e.name}` : `unverified ${e.relay}/${e.name}`)}${e.realm ? ` in ${esc(e.realm)}` : ""}</td><td>${e.session ? esc(`${e.session.realm}/${e.session.name}`) : "all sessions"}</td><td>${when(e.added)}</td></tr>`;
      const table = (list, cmd) => (list?.length ? `<table><tr><th>Id</th><th>Sender</th><th>For</th><th>Added</th></tr>${list.map(entry).join("")}</table><p class="note">Remove one: <code>${cmd}</code></p>` : "<p>None.</p>");
      const d = pol.doc;
      return page(res, 200, "Contacts", `<p>Policy revision ${esc(d.revision ?? 0)}: default <strong>${esc(d.default)}</strong>, unverified senders <strong>${esc(d.unverified ?? "ask")}</strong> (<a href="/settings">settings</a>).</p><h2>Grants</h2>${table(d.grants, `hoptell contacts revoke &lt;id&gt; --policy-rev ${esc(d.revision ?? 0)}`)}<h2>Blocks</h2>${table(d.blocks, `hoptell contacts unblock &lt;id&gt; --policy-rev ${esc(d.revision ?? 0)}`)}<h2>Device pins</h2><p><a href="/devices">Devices</a></p>`);
    }
    if (pathname === "/devices") {
      const { displayFingerprint } = await import("./mls/identity.js");
      const { encryptionMode } = await import("./contacts.js");
      const policyDoc = readContacts(contactsFile(home)).doc;
      const pins = policyDoc?.pins ?? [];
      // Fingerprints from the pinned key bytes, never from text the relay sent.
      const rows = pins
        .map((p) => {
          const devs = p.devices.map((d) => `<code>${esc(d.device)}</code> <span class="fp">${esc(displayFingerprint({ realm: p.realm, member: p.member, device: d.device, key: Buffer.from(d.key, "base64") }))}</span>`).join("<br>");
          const enc = encryptionMode(policyDoc, p.realm, p.member);
          const encCell = ctx.experimental ? `<td><a href="/setting?key=${attr(encodeURIComponent(`encryption.${p.realm}.${p.member}`))}">${esc(enc)}</a>${sources.conversation ? `<br><a href="/conversation?member=${attr(encodeURIComponent(p.member))}">conversation checkpoint</a>` : ""}</td>` : "";
          return `<tr><td><a href="/decision?id=${attr(encodeURIComponent(`device-verify:${p.member}`))}"><code>${esc(p.member)}</code></a></td><td>${p.how === "relay-tofu" ? "relay-tofu (not verified)" : `verified ${esc(p.how)}`}</td><td>${devs}</td>${encCell}</tr>`;
        })
        .join("");
      const problems = [];
      // This member's own devices (3.2 v2.2, A1): the relay's list judged against this home's own
      // pins (never the other way round), as hoptell device list shows it.
      let own = "";
      if (sources.devices?.own) {
        try {
          const { ownOf, evaluateOwn, settleAwaiting } = await import("./mls/own.js");
          const { list, thisDevice } = await sources.devices.own();
          // A12: what the relay's list proves (a registration, a valid rotation of an own pin) is
          // recorded before it is shown, on every look, as the CLI does (it writes only then).
          let ownDoc = policyDoc;
          let unrecorded = "";
          if (policyDoc?.own?.[list.realm]) {
            const { openContacts } = await import("./quarantine.js");
            const contacts = sources.contacts ?? (await openContacts(home, { notify: false }));
            // A failed write never hides the list: shown with the problem noted.
            try {
              if (await settleAwaiting(contacts, list)) ownDoc = contacts.currentPolicy().doc;
            } catch (e) {
              unrecorded = `<p class="warn"><strong>Not recorded:</strong> your devices could not be recorded in your contacts (${esc(e.message)}); shown as the relay lists them now, against the pins kept here.</p>`;
            }
          }
          const entry = ownOf(ownDoc, list.realm);
          if (!entry) own = `<h2>Your devices</h2><p class="warn">No own device is recorded in this home for realm <code>${esc(list.realm)}</code>: <code>hoptell device enroll</code></p>`;
          else {
            const ev = evaluateOwn(entry, list.realm, list.devices);
            const fpOf = (d) => displayFingerprint({ realm: list.realm, member: entry.member, device: d.device, key: Buffer.isBuffer(d.key) ? d.key : Buffer.from(d.key, "base64") });
            const missing = new Set(ev.missing.map((d) => d.device));
            const awaiting = new Set(ev.awaiting.map((d) => d.device));
            const changed = new Set(ev.changed.map((d) => d.device));
            // A12: a validated rotation not recorded (the write failed): the pinned key is stale.
            const rotated = new Set(ev.rotated.map((d) => d.device));
            const stateOf = (d) => (d.device === thisDevice ? "this device" : rotated.has(d.device) ? `<span class="warn">not recorded: the relay serves a rotated key</span>` : "accepted");
            const rows = [
              ...entry.devices.map((d) => `<tr><td><code>${esc(d.device)}</code></td><td class="fp">${esc(fpOf(d))}</td><td>${stateOf(d)}${missing.has(d.device) ? " (the relay no longer lists it)" : ""}${awaiting.has(d.device) ? " (awaiting its registration at the relay)" : ""}${changed.has(d.device) ? " (KEY CHANGED: sending is stopped)" : ""}</td></tr>`),
              ...ev.unaccepted.map((d) => `<tr><td><code>${esc(d.device)}</code></td><td class="fp">${esc(d.fingerprint)}</td><td><a class="warn" href="/decision?id=${attr(encodeURIComponent(`device-own:${d.device}`))}">${d.unconfirmed ? "unconfirmed (pinned on the relay's word by an older hoptell)" : "listed by the relay, not accepted by you"}: check it</a></td></tr>`),
              ...entry.unconfirmed.filter((u) => !ev.unaccepted.some((d) => d.device === u.device)).map((u) => `<tr><td><code>${esc(u.device)}</code></td><td class="fp">${esc(fpOf(u))}</td><td>unconfirmed, not listed now (conversations holding it are stopped)</td></tr>`),
              ...list.devices.filter((d) => d.revoked).map((d) => `<tr><td><code>${esc(d.device)}</code></td><td></td><td>revoked ${d.revoked.at ? when(new Date(d.revoked.at).toISOString()) : ""} by ${d.revoked.by === "admin" ? "the relay admin" : `device ${esc(d.revoked.device ?? "?")}`}</td></tr>`),
            ].join("");
            own = `<h2>Your devices</h2>${unrecorded}<p>Member <code>${esc(entry.member)}</code>, realm <code>${esc(list.realm)}</code>, from this home's own pins.</p><table><tr><th>Device</th><th>Fingerprint</th><th>State</th></tr>${rows}</table>`;
          }
        } catch (e) {
          problems.push(`your devices: ${e.message}`);
        }
      }
      const waiting = sources.devices ? await decisions.list({ home, kinds: ["device-accept"], sources, problems }) : [];
      const w = waiting.map((i) => `<li><a href="/decision?id=${attr(encodeURIComponent(i.id))}" class="warn">${esc(i.summary)}</a></li>`).join("");
      return page(res, 200, "Devices", `${sources.devices ? "" : `<p class="note">The relay's device lists are not available (experimental device keys off, or no relay): only the pins kept here are shown.</p>`}${w ? `<h2>Waiting for you</h2><ul>${w}</ul>` : ""}${problems.map((p) => `<p class="note">${esc(p)}</p>`).join("")}${own}<h2>Pinned contacts</h2>${rows ? `<table><tr><th>Member</th><th>Provenance</th><th>Devices</th>${ctx.experimental ? "<th>Encryption</th>" : ""}</tr>${rows}</table>` : "<p>No pins.</p>"}`);
    }
    if (pathname === "/conversation") {
      // The encrypted conversation's checkpoint (3.3), for comparing histories out of band: shown
      // for comparison only, it decides nothing.
      const member = q.get("member") ?? "";
      if (!/^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.test(member)) return refuse(res, 404, "not a member id");
      if (!sources.conversation) return page(res, 200, "Conversation checkpoint", `<p class="note">Encrypted conversations are not available here (experimental encrypted messages off, or no relay profile).</p>`);
      const cp = await sources.conversation.checkpoint(member);
      if (!cp) return page(res, 200, "Conversation checkpoint", `<p>This device has no encrypted conversation with <code>${esc(member)}</code> yet.</p>`);
      return page(res, 200, "Conversation checkpoint", `<p>Encrypted conversation with <code>${esc(member)}</code>: realm <code>${esc(cp.realm)}</code>, group <code>${esc(cp.group)}</code>, generation ${esc(cp.generation)}, epoch ${esc(cp.epoch)}.</p><p>Checkpoint: <strong class="fp">${esc(cp.digits)}</strong></p>${cp.fork ? `<p class="warn">A fork was detected at epoch ${esc(cp.fork.epoch)}; the next message replaces the group.</p>` : ""}<p class="note">Compare it with the other owner's (<code>hoptell contacts verify &lt;your member id&gt; --conversation</code>) at the same generation and epoch. Different numbers mean your histories differ. Device safety numbers identify devices; this compares histories.</p><p><a href="/decision?id=${attr(encodeURIComponent(`device-verify:${member}`))}">Verify this contact's devices</a></p>`);
    }
    if (pathname === "/settings") {
      const rows = (await decisions.settings.list({ home, ctx })).map((r) => `<tr><td>${r.writable ? `<a href="/setting?key=${attr(encodeURIComponent(r.key))}">${esc(r.key)}</a>` : esc(r.key)}</td><td><code>${esc(r.value || "(not set)")}</code>${r.note ? ` <span class="note">(${esc(r.note)})</span>` : ""}</td><td>${esc(r.source)}${r.writable ? "" : " <span class=\"note\">(not writable here)</span>"}</td><td>${esc(r.effect)}${r.restart.length ? `<br><span class="warn">running with an older value: ${esc(r.restart.join(", "))}</span>` : ""}</td></tr>`);
      return page(res, 200, "Settings", `<table><tr><th>Setting</th><th>Value</th><th>Source</th><th>Takes effect</th></tr>${rows.join("")}</table><p class="note">Environment variables win over the settings file: a key set in the environment is changed there. Sessions listed are those with a hook registration; others are not known here.</p>`);
    }
    if (pathname === "/setting") return settingPage(s, q.get("key") ?? "", res);
    if (pathname === "/doctor") {
      const r = inspectContacts(home);
      return page(res, 200, "Doctor summary", `<table><tr><td>Contacts</td><td>${esc(r.mode)}${r.markerProblem ? ` <span class="warn">${esc(r.markerProblem)}</span>` : ""}</td></tr><tr><td>Policy</td><td>${r.policyProblem ? `<span class="warn">${esc(r.policyProblem)}</span>` : `revision ${esc(r.policy?.revision ?? 0)}`}</td></tr><tr><td>Waiting</td><td>${esc(r.requests.length)} request(s)</td></tr><tr><td>Decisions in progress</td><td>${esc(r.journals)}</td></tr></table><p class="note">The full check: <code>hoptell doctor</code></p>`);
    }
    return refuse(res, 404, "no such page");
  }

  /** What else decides a setting: its note (with a link to the related setting) and the value in force. */
  function provenance(k) {
    const note = k.note ? `<p class="note">Note: ${esc(k.note)}${k.related ? ` (<a href="/setting?key=${attr(encodeURIComponent(k.related))}">${esc(k.related)}</a>)` : ""}.</p>` : "";
    const effective = k.effective ? `<p>In force: <strong>${esc(k.effective.value)}</strong>, ${esc(k.effective.why)}.${k.effective.value !== k.value ? " This contact's own flag does not turn it off." : ""}</p>` : "";
    return note + effective;
  }

  function settingPage(s, key, res, { notice = "" } = {}) {
    const k = decisions.settings.show({ home, ctx, key });
    if (!k) return refuse(res, 404, "no such setting");
    if (!k.writable) return page(res, 200, k.key, `<p><code>${esc(k.value ?? "(not set)")}</code> from ${esc(k.source)}: not writable here.</p>`);
    const head = `${notice}<p>Current value: <code>${esc(k.value)}</code> (${esc(k.source)}); takes effect: ${esc(k.effect)}.</p>${provenance(k)}`;
    if (k.allowed.enum) {
      const forms = k.allowed.enum
        .filter((v) => v !== k.value)
        .map((v) => {
          const allowed = { values: [v] };
          return `<form class="inline" method="post" action="/setting"><input type="hidden" name="key" value="${attr(k.key)}"><input type="hidden" name="token" value="${attr(k.token)}"><input type="hidden" name="value" value="${attr(v)}"><input type="hidden" name="allowed" value="${attr(JSON.stringify(allowed))}"><input type="hidden" name="ft" value="${attr(formToken("setting", k.key, k.token, allowed))}"><button type="submit">Set to ${esc(v === "" ? "(none)" : v)}</button>${k.widening.includes(v) ? ' <span class="wide">widens access</span>' : ""}</form>`;
        })
        .join("");
      return page(res, 200, k.key, head + forms);
    }
    const allowed = { form: k.allowed.form };
    return page(res, 200, k.key, `${head}<form method="post" action="/setting/review"><input type="hidden" name="key" value="${attr(k.key)}"><input type="hidden" name="token" value="${attr(k.token)}"><input type="hidden" name="allowed" value="${attr(JSON.stringify(allowed))}"><input type="hidden" name="ft" value="${attr(formToken("setting-review", k.key, k.token, allowed))}"><textarea name="value">${esc(k.value, { keepNewlines: true })}</textarea><p><button type="submit">Review the change</button></p></form>${k.allowed.form === "roots" ? `<p class="note">A JSON list of {"id": "app", "path": "/absolute/folder"}.</p>` : ""}`);
  }

  async function postPage(s, pathname, f, res) {
    if (pathname === "/decide") {
      const c = checkForm(s, "decision", f.id, f.token, f.allowed, f.ft);
      if (c.problem) return refuse(res, 403, c.problem);
      // Only what the form token covers: its action, and options within its allowed values.
      const a = c.allowed;
      if (f.action !== a?.action) return refuse(res, 403, "that action is not one this form offered");
      const options = {};
      for (const k of ["session", "how"]) {
        if (f[k] === undefined || f[k] === "") continue;
        if (!Array.isArray(a.options?.[k]) || !a.options[k].includes(f[k])) return refuse(res, 403, `that ${k} is not one this form offered`);
        options[k] = f[k];
      }
      const extra = Object.keys(f).filter((k) => !["id", "token", "action", "allowed", "ft", "session", "how"].includes(k));
      if (extra.length) return refuse(res, 400, "the form has fields it should not have");
      if (a.options?.how && !options.how) return refuse(res, 403, "choose how you compared");
      const r = await decisions.decide({ home, id: f.id, action: f.action, token: f.token, options, sources });
      if (r.done) return page(res, 200, "Done", `<p>${esc(doneText(f.action, r.effects))}</p><p><a href="/pending">Back to Pending</a></p>`);
      if (r.stale) {
        const shown = await decisions.show({ home, id: f.id, sources });
        if (shown.refused || shown.busy) return refuse(res, 409, `It changed since it was shown, and is no longer available: ${shown.reason}`);
        return page(res, 409, "Changed since it was shown", `<p class="warn">Nothing was done: it changed since you looked. Here is what it is now.</p>${renderView(shown)}${decisionForms(s, shown)}`);
      }
      if (r.busy) return refuse(res, 503, "Another hoptell process is busy with it; try again.");
      return refuse(res, 409, r.reason);
    }
    if (pathname === "/setting/review") {
      const c = checkForm(s, "setting-review", f.key, f.token, f.allowed, f.ft);
      if (c.problem) return refuse(res, 403, c.problem);
      const k = decisions.settings.show({ home, ctx, key: f.key });
      if (!k || !k.allowed.form || c.allowed?.form !== k.allowed.form) return refuse(res, 403, "that setting is not one this form offered");
      const value = String(f.value ?? "").replace(/\r\n/g, "\n").trim();
      const allowed = { values: [value] };
      const wide = decisions.settings.widens({ home, ctx, key: f.key, value });
      return page(res, 200, `Confirm ${k.key}`, `<p>From <code>${esc(k.value)}</code></p><p>to <code>${esc(value, { keepNewlines: true })}</code></p>${wide ? '<p class="wide">This change widens access.</p>' : ""}<form method="post" action="/setting"><input type="hidden" name="key" value="${attr(k.key)}"><input type="hidden" name="token" value="${attr(f.token)}"><input type="hidden" name="value" value="${attr(value)}"><input type="hidden" name="allowed" value="${attr(JSON.stringify(allowed))}"><input type="hidden" name="ft" value="${attr(formToken("setting", k.key, f.token, allowed))}"><button type="submit">Confirm</button></form>`);
    }
    if (pathname === "/setting") {
      const c = checkForm(s, "setting", f.key, f.token, f.allowed, f.ft);
      if (c.problem) return refuse(res, 403, c.problem);
      if (!Array.isArray(c.allowed?.values) || !c.allowed.values.includes(f.value)) return refuse(res, 403, "that value is not one this form offered");
      const r = await decisions.settings.set({ home, ctx, key: f.key, value: f.value, token: f.token, sources });
      if (r.done) {
        const now = decisions.settings.show({ home, ctx, key: f.key });
        return page(res, 200, "Saved", `<p>${esc(f.key)} is now <code>${esc(f.value)}</code>.${r.restart.length ? ` Restart these sessions to use it: ${esc(r.restart.join(", "))}.` : ""}</p>${now ? provenance(now) : ""}<p><a href="/settings">Back to Settings</a></p>`);
      }
      if (r.stale) return settingPage(s, f.key, res, { notice: '<p class="warn">Nothing was saved: the file changed since it was shown.</p>' });
      if (r.busy) return refuse(res, 503, "Another hoptell process is busy with the settings; try again.");
      return refuse(res, 409, r.reason);
    }
    return refuse(res, 404, "no such form");
  }

  // ---- requests --------------------------------------------------------------------------------------
  async function handle(req, res) {
    lastRequest = now();
    const c = gate.check(req);
    if (c.status) return refuse(res, c.status, c.why);
    const { url } = c;
    if (req.method === "GET" && url.pathname === "/launch") {
      const l = gate.launch(req, url, "hoptell ui");
      if (l.status) return refuse(res, l.status, l.why);
      return send(res, 303, "", { Location: "/", "Set-Cookie": l.cookie });
    }
    if (req.method === "GET" && url.pathname === "/style.css") return send(res, 200, CSS, { "Content-Type": "text/css; charset=utf-8" });
    const s = gate.sessionOf(req);
    if (!s) return refuse(res, 403, "no session: open the launch link that hoptell ui printed");
    if (req.method === "GET") return getPage(s, url.pathname, url.searchParams, res);
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "send a form");
    if (Number(req.headers["content-length"] ?? 0) > LIMITS.bodyBytes) return refuse(res, 413, "the form is larger than 64 KB");
    let f;
    try {
      f = await readForm(req);
    } catch (e) {
      res.on("finish", () => req.destroy());
      return page(res, e.status ?? 400, "Refused", `<p>${esc(e.message)}</p>`, { Connection: "close" });
    }
    return postPage(s, url.pathname, f, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`ui: ${e.message}`);
      if (!res.headersSent) refuse(res, 500, "something went wrong; see the terminal running hoptell ui");
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  gate.setPort(server.address().port);
  const origin = gate.origin();
  const idle = setInterval(() => {
    if (now() - lastRequest > LIMITS.idleExitMs) onIdle?.();
  }, 60_000);
  idle.unref();
  return {
    port: server.address().port,
    origin,
    /** A new single-use launch link (60 s); the previous unused one stops working. */
    launchUrl: () => gate.launchUrl(),
    close() {
      clearInterval(idle);
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

const ACTION_LABEL = { allow: "Allow (adds a grant)", "allow-once": "Allow once (only these messages)", block: "Block (deletes them; blocks the sender)", verify: "I compared it: verify", accept: "Accept this key", forget: "Forget this missing device", approve: "Approve this profile", start: "Start this agent", discard: "Discard this spawn" };

function doneText(action, e) {
  if (action === "block") return "Blocked; its messages were deleted.";
  if (action === "allow" || action === "allow-once") return `Released ${e.steps} message(s)${action === "allow" ? " and added a grant" : ""}.${e.waiting ? " Some wait for room in a full inbox and are released when there is room." : ""}`;
  return `Recorded: ${e.decisions.map((x) => `${x.decision} ${x.device}`).join("; ")}.`;
}

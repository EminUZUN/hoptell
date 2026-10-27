// The relay admin's read-only UI (design 4.4, "UI"): served on the relay host's loopback by the CLI
// process, reading through the admin socket. It has no POST route and changes nothing; grants
// entries are not shown.
//
// Page protection is design 3.4's, shared with the owner UI (lib/loopbackui.js): one origin
// (http://127.0.0.1:<port>) with an exact Host check, Sec-Fetch-Site, a single-use launch token
// (60 s) that opens the one HttpOnly, SameSite=Strict session, no JavaScript, the strict CSP and
// security headers, and every value escaped with control and bidi characters made visible.
import http from "node:http";
import { adminRequest } from "./admin.js";
import { HOST, SECURITY_HEADERS, createGate, esc as escText } from "./loopbackui.js";
import { iconFor, iconLinks } from "./icons.js";

const esc = (v) => escText(v ?? "-");
const iso = (t) => (Number.isSafeInteger(t) ? new Date(t).toISOString() : "-");
const STYLE = "body{font:14px system-ui,sans-serif;margin:16px;color:#111;background:#fff}nav a{margin-right:12px}table{border-collapse:collapse;margin-top:8px}td,th{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}pre{background:#f4f4f4;padding:8px;overflow:auto}.warn{color:#a00}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}td,th{border-color:#444}pre{background:#222}.warn{color:#f77}}";
const PAGES = ["status", "members", "devices", "policy", "grants", "revocations", "metrics", "store", "audit"];
const COOKIE = "hoptell_relay_admin";


function table(head, rows) {
  return `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}
const more = (page, next, extra = "") => (next ? `<p><a href="/${page}?cursor=${encodeURIComponent(next)}${extra}">next page</a></p>` : "");

/** One page's body from the relay's answers. */
async function render(stateDir, name, q) {
  const call = (op, args = {}) => adminRequest(stateDir, op, args, { timeoutMs: 30_000 });
  const cursor = q.get("cursor") ?? undefined;
  switch (name) {
    case "status": {
      const s = await call("status");
      return table(["field", "value"], [["realm", s.realm], ["version", s.version], ["running", s.running], ["auth", s.auth], ["capabilities", (s.caps ?? []).join(", ")], ["uptime (s)", s.uptimeSeconds], ["e2ee (experimental)", s.flags.e2ee], ["store instance", s.instance], ["restore", s.restore ? `${s.restore.id} at ${s.restore.phase}` : "none"]]);
    }
    case "members": {
      const r = await call("members", { cursor });
      return table(["name", "id", "token", "linked", "broker", "devices", "suspended", "sessions", "queued"], r.rows.map((m) => [m.name, m.id, m.tokenPresent ? `present (${m.tokenFormat})` : "none", m.linked.map((l) => `${l.issuer} ${l.subject}`).join("; "), m.brokerFamilies, m.devices, m.suspended, m.sessions, m.quota?.queued])) + more(name, r.next);
    }
    case "devices": {
      const r = await call("devices", { cursor });
      return table(["member", "device", "fingerprint", "enrolled", "revoked", "suspended", "Key packages: available / reserved / used"], r.rows.map((d) => [d.name ?? d.member, d.device, d.fingerprint, iso(d.enrolled), d.revoked ? `${iso(d.revoked.at)} by ${d.revoked.by}` : "", d.suspended ? "yes" : "", `${d.keyPackages.available}/${d.keyPackages.reserved}/${d.keyPackages.burned}`])) + more(name, r.next);
    }
    case "policy": {
      const p = await call("policy");
      let check = "";
      if (q.get("from") && q.get("to")) {
        try {
          const c = await call("policy_check", { from: q.get("from"), to: q.get("to") });
          check = `<p>${esc(c.from)} to ${esc(c.to)}: <b>${esc(c.action)}</b> by ${esc(c.rule === "default" ? "the default" : c.rule === "no policy" ? "no policy" : `rule ${c.rule}`)} <span class="${c.certain ? "" : "warn"}">(a static check by member ids${c.certain ? "" : "; a signed-in session's provider groups can match other rules"})</span></p>`;
        } catch (e) {
          check = `<p class="warn">${esc(e.message)}</p>`;
        }
      }
      const form = `<form method="get" action="/policy"><input name="from" placeholder="from member"> <input name="to" placeholder="to member"> <button>check</button></form>`;
      return table(["field", "value"], [["file", p.file], ["revision", p.revision], ["file check", p.fileResult], ["in force", p.loaded ? `default ${p.loaded.defaultAction}, ${p.loaded.rules.length} rules` : (p.error ?? "none")]]) + (p.loaded ? table(["#", "action", "from", "to"], p.loaded.rules.map((r, i) => [i, r.action, r.from, r.to])) : "") + form + check;
    }
    case "grants": {
      const r = await call("grants", { cursor });
      return `<p>Only summaries are shown here. Use hoptell relay admin to read grant entries; each read is recorded in the audit log.</p>${table(["member", "default", "visible", "entries", "revision", "updated", "pending"], r.rows.map((g) => [g.name ?? g.member, g.default, g.visible, g.entries, g.revision, iso(g.updated), g.pending ? "held until re-published" : ""]))}${more(name, r.next)}`;
    }
    case "revocations": {
      const r = await call("revocations", { cursor });
      return table(["time", "kind", "member", "device", "by"], r.rows.map((x) => [iso(x.at), x.kind, x.name ?? x.member, x.device ?? "", x.actor])) + more(name, r.next);
    }
    case "metrics":
    case "store":
      return `<pre>${esc(JSON.stringify(await call(name), null, 2))}</pre>`;
    case "audit": {
      const r = await call("audit", { cursor });
      const chain = r.chain ? `<p class="${r.chain.ok ? "" : "warn"}">${esc(r.chain.ok ? `hash chain verified (${r.chain.rows} rows)` : `hash chain broken at seq ${r.chain.brokenAt}`)}</p>` : "";
      return chain + table(["seq", "time", "actor", "action", "target", "state", "result", "detail"], r.rows.map((x) => [x.seq, iso(x.time), x.actor, x.action, x.target, x.state, x.result, JSON.stringify(x.detail)])) + more(name, r.next);
    }
  }
  return "";
}

/**
 * Serve the UI for the relay of `stateDir` on 127.0.0.1:`port` (0: any free port). Returns
 * {port, launchUrl(), close()}: launchUrl() issues a new single-use launch link (60 s).
 */
export function startAdminUi({ stateDir, port = 0, now = () => Date.now() }) {
  const gate = createGate({ cookie: COOKIE, methods: ["GET", "HEAD"], now });
  const send = (res, code, body, extra = {}) => res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", ...extra }).end(body);
  const pageOf = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css">${iconLinks()}</head><body><nav>${PAGES.map((p) => `<a href="/${p === "status" ? "" : p}">${p}</a>`).join("")}</nav><h1>${esc(title)}</h1>${body}<p>Read only: changes are made with hoptell relay admin on this host.</p></body></html>`;
  const server = http.createServer(async (req, res) => {
    const c = gate.check(req);
    if (c.status) return send(res, c.status, pageOf("Refused", `<p>${esc(c.why)}</p>`));
    const { url } = c;
    if (url.pathname === "/launch") {
      const l = gate.launch(req, url, "hoptell relay admin ui");
      if (l.status) return send(res, l.status, pageOf("Refused", `<p>${esc(l.why)}</p>`));
      return send(res, 303, "", { Location: "/", "Set-Cookie": l.cookie });
    }
    if (url.pathname === "/style.css") return send(res, 200, STYLE, { "Content-Type": "text/css; charset=utf-8" });
    const icon = iconFor(url.pathname);
    if (icon) return send(res, 200, icon.body, icon.headers);
    if (!gate.sessionOf(req)) return send(res, 403, pageOf("Refused", "<p>Open the launch link that hoptell relay admin ui printed.</p>"));
    const name = url.pathname === "/" ? "status" : url.pathname.slice(1);
    if (!PAGES.includes(name)) return send(res, 404, pageOf("not found", ""));
    let body;
    try {
      body = await render(stateDir, name, url.searchParams);
    } catch (e) {
      body = `<p class="warn">${esc(e.code === "not_running" ? "The relay is not running." : e.message)}</p>`;
    }
    send(res, 200, req.method === "HEAD" ? "" : pageOf(`relay admin: ${name}`, body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      gate.setPort(server.address().port);
      resolve({ port: server.address().port, launchUrl: () => gate.launchUrl(), close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

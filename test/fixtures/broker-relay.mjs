// The relay side of broker mode for tests (design 1.7): a relay with broker sign-in at the test
// provider, the browser (it follows redirects), the CLI's legs, and a TCP proxy that can drop the
// answer of a committed refresh.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "../../lib/client.js";
import { createBroker } from "../../lib/broker.js";
import { discoveryDocument } from "../../lib/oidc.js";
import { startRelay } from "../../lib/relay.js";
import { startProvider } from "./oidc-provider.mjs";

export const REALM = "d".repeat(32);
export const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const b64u = (b) => Buffer.from(b).toString("base64url");
export const tmp = (t, p = "hoptell-broker-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
export const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

/**
 * A relay with broker sign-in at the test provider. `issuer` overrides the broker issuer's
 * settings; `members` the members list. Returns helpers for the browser and the CLI.
 */
export async function setup(t, { issuer = {}, members = null, provider = {}, stateDir = null, port = null, extra = [], p = null, fault = null, publicPort = null, now = undefined } = {}) {
  p ??= await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" }, "other-client": { secret: "other-secret" } }, ...provider });
  if (!provider.keep) t.after(() => p.close());
  port ??= await freePort();
  const base = `http://127.0.0.1:${publicPort ?? port}`; // the public origin (a proxy's, when given)
  const icfg = { issuer: p.issuer, mode: "broker", id: "idp", publicBaseUrl: base, client: { clientId: "hoptell-broker", clientSecret: "broker-secret" }, scopes: ["openid"], reverifyAfterSeconds: 86_400, familyIdleSeconds: 2_592_000, familyMaxSeconds: 7_776_000, accessTokenSeconds: 900, requireReauthentication: false, ...issuer };
  const cfg = { maxRevocationDelaySeconds: 300, maxTokenLifetimeSeconds: null, issuers: [icfg, ...extra.map((e) => ({ ...icfg, publicBaseUrl: base, ...e }))] };
  stateDir ??= tmp(t);
  const logs = [];
  const broker = await createBroker({ issuers: cfg.issuers, stateDir, log: (...a) => logs.push(a.join(" ")), fault, ...(now ? { now } : {}) });
  const mem = members ?? [{ name: "alice", id: ALICE, oidc: [{ issuer: p.issuer, subject: "user-1" }] }];
  const relay = await startRelay({ host: "127.0.0.1", port, members: mem, realm: { id: REALM }, oidc: { verifier: null, config: cfg, discovery: discoveryDocument(cfg, REALM), broker }, log: () => {} });
  const close = async () => {
    broker.close();
    await relay.close();
  };
  t.after(close);
  return { p, port, base, url: `ws://127.0.0.1:${port}`, relay, broker, stateDir, cfg, logs, close, members: mem };
}

/** The CLI's side of the first leg: PKCE, state and a loopback redirect (not listened on). */
export function cliRequest({ redirect = "http://127.0.0.1:49152/callback" } = {}) {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  return { verifier, challenge, state, redirect };
}
export const authorizeUrl = (s, req, id = "idp", params = null) => {
  const u = new URL(`${s.base}/oidc/${id}/authorize`);
  const p = params ?? { response_type: "code", client_id: "hoptell-cli", redirect_uri: req.redirect, code_challenge: req.challenge, code_challenge_method: "S256", state: req.state };
  for (const [k, v] of Array.isArray(p) ? p : Object.entries(p)) u.searchParams.append(k, v);
  return u.href;
};

/** The browser: follows redirects until the CLI's loopback redirect (returned, not fetched) or a page. */
export async function browse(url, { stopAt = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/callback\?/ } = {}) {
  let at = url;
  for (let i = 0; i < 10; i++) {
    if (stopAt.test(at) && i > 0) return { cli: new URL(at) };
    const r = await fetchAgain(at, { redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      at = new URL(r.headers.get("location"), at).href;
      continue;
    }
    return { status: r.status, text: await r.text(), headers: r.headers };
  }
  throw new Error("too many redirects");
}

/** The whole first leg: returns {code, state, req} as the CLI's loopback receives them. */
export async function signInBrowser(s, req = cliRequest()) {
  const r = await browse(authorizeUrl(s, req));
  if (!r.cli) throw Object.assign(new Error(`no redirect to the CLI (${r.status}): ${r.text?.slice(0, 300)}`), { page: r });
  return { code: r.cli.searchParams.get("code"), state: r.cli.searchParams.get("state"), req };
}
// After a relay restart on the same port, a pooled connection to the old server fails once.
export const fetchAgain = async (url, opts) => {
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (!["UND_ERR_SOCKET", "ECONNRESET"].includes(e.cause?.code)) throw e;
    return fetch(url, opts);
  }
};
export const post = async (s, endpoint, form, id = "idp") => {
  const r = await fetchAgain(`${s.base}/oidc/${id}/${endpoint}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body, headers: r.headers };
};
export const redeem = (s, { code, req }, extra = {}) => post(s, "token", { grant_type: "authorization_code", code, redirect_uri: req.redirect, code_verifier: req.verifier, client_id: "hoptell-cli", ...extra });
export const refresh = (s, token) => post(s, "token", { grant_type: "refresh_token", refresh_token: token, client_id: "hoptell-cli" });
export const familiesOf = (s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, "broker", "families.json"), "utf8")).families;

/** A connection with a broker access token: {welcome, error, code}. */
export const hello = (s, token, issuer = "idp") =>
  new Promise((resolve) => {
    const c = new RelayClient({ url: s.url, signIn: async () => ({ kind: "broker", issuer, token, expiresAt: Date.now() + 600_000 }), name: "alice-x", mode: "send", reconnect: false });
    c.on("ready", () => resolve({ welcome: true, member: c.member, client: c }));
    c.on("fatal", (e) => resolve({ welcome: false, error: e, hello: c.helloError?.code }));
    c.start();
  });


/**
 * A TCP proxy to `port`. `dropTokenAnswers` (a count): the answer to that many POSTs to a broker
 * token endpoint is not passed on (the relay committed; the client's connection is reset).
 * `answerBusy` (a count): that many token POSTs get an explicit 503 temporarily_unavailable from
 * the proxy itself (nothing reaches the relay). `posts` counts the token POSTs that reached the
 * relay.
 */
export async function proxyTo(t, port, { listenPort = 0 } = {}) {
  const state = { dropTokenAnswers: 0, answerBusy: 0, posts: 0 };
  const server = net.createServer((down) => {
    const up = net.connect(port, "127.0.0.1");
    let drop = false;
    down.on("data", (d) => {
      if (/^POST \/oidc\/[a-z0-9-]+\/token /.test(d.toString("latin1"))) {
        if (state.answerBusy > 0) {
          state.answerBusy--;
          const body = JSON.stringify({ error: "temporarily_unavailable" });
          down.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
          return up.destroy();
        }
        state.posts++;
        if (state.dropTokenAnswers > 0) {
          state.dropTokenAnswers--;
          drop = true;
        }
      }
      up.write(d);
    });
    up.on("data", (d) => {
      if (drop && /^HTTP\/1\.1 /.test(d.toString("latin1"))) {
        drop = false;
        return down.destroy(); // the relay answered; the client never sees it
      }
      down.write(d);
    });
    const end = () => (up.destroy(), down.destroy());
    up.on("error", end).on("close", end);
    down.on("error", end).on("close", end);
  });
  await new Promise((r) => server.listen(listenPort, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { port: server.address().port, state, close: () => new Promise((r) => server.close(r)) };
}

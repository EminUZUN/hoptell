// The hosted-mode test world (design 4.5): a relay with a host and hosted members, the scripted
// provider and the hosted endpoint on 127.0.0.1 behind a test proxy header setup.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RelayClient } from "../lib/client.js";
import { createAccess } from "../lib/access.js";
import { startRelay } from "../lib/relay.js";
import { checkHostedConfig, startHosted, tenantKey } from "../lib/hosted.js";
import { createTenants } from "../lib/hostedtenants.js";
import { link, linkTable } from "../lib/hostedlinks.js";
import { createOwnerPage } from "../lib/hostedowner.js";
import { createVerifier } from "../lib/oidc.js";
import { serveEngine } from "../lib/mcp.js";
import { contactsFile } from "../lib/contacts.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";
import { AUTHORITY, HANNA, HUGO, REALM, RESOURCE, oidcConfigFor, proxyFetch } from "./hosted-helpers.js";

export const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const tok = (n) => crypto.createHash("sha256").update(`token-${n}`).digest("hex");
export const MEMBERS = [
  { name: "bob", id: BOB, token: tok("bob") },
  { name: HANNA.name, id: HANNA.id, custody: "hosted", host: "h1" },
  { name: HUGO.name, id: HUGO.id, custody: "hosted", host: "h1" },
];
export const HOSTS = [{ id: "h1", token: tok("host-h1") }];

export async function hostedWorld(t, { policy = null, limits = {}, tenantOptions = {}, owner = false, clock = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-t-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const access = createAccess({ stateDir: path.join(dir, "relay"), policy });
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: MEMBERS, hosts: HOSTS, realm: { id: REALM }, access, log: () => {}, sweepMs: 100_000 });
  t.after(() => relay.close());
  const provider = await startProvider({ audience: RESOURCE, clients: { "owner-client": { redirect: `https://${AUTHORITY}/owner/callback` } } });
  t.after(() => provider.close());
  const config = checkHostedConfig({ version: 1, authority: AUTHORITY, realm: REALM, hostId: "h1", relay: `ws://127.0.0.1:${relay.port}`, trustedProxies: "127.0.0.1", oidc: oidcConfigFor(dir, provider), limits, ...(owner ? { owner: { issuer: provider.issuer, clientId: "owner-client" } } : {}) });
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  await link(state, { issuer: provider.issuer, subject: "hanna-sub", member: HANNA });
  await link(state, { issuer: provider.issuer, subject: "hugo-sub", member: HUGO });
  const logs = [];
  const log = (...a) => logs.push(a.join(" "));
  const tenants = createTenants({ config, stateDir: state, hostToken: tok("host-h1"), log, ...(typeof tenantOptions === "function" ? tenantOptions(state) : tenantOptions) });
  t.after(() => tenants.close());
  const ownerPage = owner ? createOwnerPage({ config, stateDir: state, links: linkTable(state), tenants, storage: tenants.storage, log, ...(clock ? { now: () => clock.t } : {}) }) : null;
  const h = await startHosted({ config, stateDir: state, verifier: await createVerifier(config.oidc), tenants, owner: ownerPage, serve: (e, tr, o) => serveEngine(e, tr, { front: "hosted", ...o }), log });
  t.after(() => h.close());
  const homeOf = (m) => path.join(state, "tenants", tenantKey(REALM, m.id));
  /** Allow bob in a tenant's contacts (the owner's decision; gate 3 runs at the host). */
  const allowBob = (m) => {
    const f = contactsFile(homeOf(m));
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    doc.grants.push({ member: BOB, realm: REALM });
    doc.revision++;
    fs.writeFileSync(f, JSON.stringify(doc), { mode: 0o600 });
  };
  const token = (sub, o = {}) => provider.issue({ sub, client: "client-a", scope: "openid hoptell.mcp", ...o });
  const connect = async (sub, o = {}) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch: proxyFetch(h.port), requestInit: { headers: { authorization: `Bearer ${await token(sub, o)}` } } });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    return { client, transport };
  };
  const bobs = [];
  t.after(() => bobs.forEach((c) => c.close()));
  const bob = async (name = "bob") => {
    const c = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, token: tok("bob"), name, reconnect: false });
    bobs.push(c);
    const got = [];
    c.on("message", (m, confirm) => (got.push(m), confirm({ released: true })));
    await c.start().ready(5000);
    return Object.assign(c, { got });
  };
  /** An owner-page request through the proxy: {status, headers, text, cookies}. */
  const page = async (method, p, { cookie = "", body = null, headers = {} } = {}) => {
    const r = await proxyFetch(h.port)(`https://${AUTHORITY}${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== null ? { "content-type": "application/x-www-form-urlencoded", origin: `https://${AUTHORITY}` } : {}), ...headers }, body: body === null ? undefined : new URLSearchParams(body).toString() });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, cookies: r.headers.get("set-cookie") ?? "" };
  };
  /** Sign in on the owner page as `sub`: the login, the provider's redirect, the callback. Returns the session cookie or the refusal. */
  const ownerLogin = async (sub, { tamper = null } = {}) => {
    const start = await page("GET", "/owner/login");
    const loginCookie = /__Host-hoptell-login=([^;]+)/.exec(start.cookies)?.[1];
    provider.signIn = { sub, name: sub, groups: [] };
    const back = await fetch(start.headers.get("location"), { redirect: "manual" });
    const cb = new URL(back.headers.get("location"));
    if (tamper) tamper(cb);
    const done = await page("GET", cb.pathname + cb.search, { cookie: loginCookie ? `__Host-hoptell-login=${loginCookie}` : "" });
    const session = /__Host-hoptell-owner=([A-Za-z0-9_-]{43})/.exec(done.cookies)?.[1];
    return { status: done.status, cookie: session ? `__Host-hoptell-owner=${session}` : null, loginCookie, callback: cb, done };
  };
  return { dir, state, relay, access, provider, config, tenants, h, logs, homeOf, allowBob, token, connect, bob, port: h.port, page, ownerLogin, ownerPage };
}

// Shared pieces of the hosted-mode tests (design 4.5): the public authority, the scripted
// provider's configuration and a fetch that goes through the "proxy" (Host and X-Forwarded-Proto).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { loadOidcConfig } from "../lib/oidc.js";

export const AUTHORITY = "mcp.example.test";
export const RESOURCE = `https://${AUTHORITY}/mcp`;
export const REALM = "e".repeat(32);
export const HANNA = { id: "m_hhhhhhhhhhhhhhhhhhhhhhhhhh", name: "hanna" };
export const HUGO = { id: "m_iiiiiiiiiiiiiiiiiiiiiiiiii", name: "hugo" };

/** Write a 1.6 issuer configuration for `provider` and load it as the relay would. */
export function oidcConfigFor(dir, provider, extra = {}, top = {}) {
  const file = path.join(dir, "oidc.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...top, issuers: [{ issuer: provider.issuer, audience: RESOURCE, ...extra }] }), { mode: 0o600 });
  return loadOidcConfig(file);
}

/**
 * A fetch that sends to the local server but keeps the public Host and adds the proxy's
 * X-Forwarded-Proto (fetch itself cannot set Host): the client sees `https://<authority>`.
 */
export function proxyFetch(port, { proto = "https", host = AUTHORITY, extra = {} } = {}) {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const headers = { ...Object.fromEntries(new Headers(init.headers ?? {}).entries()), host, "x-forwarded-proto": proto, ...extra };
      const req = http.request({ host: "127.0.0.1", port, method: init.method ?? "GET", path: url.pathname + url.search, headers }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const nobody = [204, 304].includes(res.statusCode) || init.method === "HEAD";
        resolve(new Response(nobody ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
      });
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => req.destroy(new DOMException("aborted", "AbortError")), { once: true });
      if (init.body) req.end(init.body);
      else req.end();
    });
}


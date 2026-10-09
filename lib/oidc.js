// Relay side of signing in with an identity provider (design 1.6, resource mode): configuration,
// access-token validation against the issuer the client names (JWT with that issuer's JWKS under
// an explicit token profile, or RFC 7662 introspection for opaque tokens), and the public
// discovery document. The libraries load only when sign-in is configured.
import crypto from "node:crypto";
import fs from "node:fs";

const SAFE_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const SKEW_S = 60; // the one clock skew; the relay's deadline for a token is exp + SKEW_S
const FETCH_TIMEOUT_MS = 5000;
const FETCH_MAX_BYTES = 1024 * 1024;
const INTROSPECTION_CACHE_MAX = 1000;

/** A refusal of a token, with a fixed code and a message safe to show the client. */
export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "bad_token" | "unsupported_auth" | "unavailable"
  }
}

export const isLoopback = (u) => LOOPBACK.test(u);

/** HTTPS is required, except for loopback addresses (development and tests). */
const checkUrl = (u, what) => {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`${what} must be a URL`);
  }
  if (url.protocol !== "https:" && !LOOPBACK.test(u)) throw new Error(`${what} must use https`);
  return u; // the issuer identifier is compared exactly (OIDC Discovery 4.3): never rewritten
};
const secretFrom = (file, what) => {
  if (!file) return undefined;
  const st = fs.statSync(file);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${what} ${file} is readable by other users; chmod 600 it`);
  return fs.readFileSync(file, "utf8").trim();
};
const strings = (v, what) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${what} must be a list of strings`);
  return v;
};

/** Read and validate the relay's sign-in configuration. Throws with a fixed message. */
export function loadOidcConfig(file) {
  let doc;
  try {
    const st = fs.statSync(file);
    if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : e.message);
  }
  if (doc?.version !== 1) throw new Error(`${file}: version must be 1`);
  if (!Array.isArray(doc.issuers) || !doc.issuers.length) throw new Error(`${file}: issuers must be a non-empty list`);
  const int = (v, min, d) => (Number.isInteger(v) && v >= min ? v : d);
  const cfg = {
    maxRevocationDelaySeconds: int(doc.maxRevocationDelaySeconds, 10, 300),
    maxTokenLifetimeSeconds: doc.maxTokenLifetimeSeconds === undefined ? null : int(doc.maxTokenLifetimeSeconds, 60, null),
    issuers: doc.issuers.map((i, n) => {
      const where = `${file}: issuers[${n}]`;
      if (!["resource", "broker"].includes(i.mode ?? "resource")) throw new Error(`${where}: mode must be "resource" or "broker"`);
      if (i.mode === "broker") return brokerIssuer(i, where, int);
      if (typeof i.audience !== "string" || !i.audience) throw new Error(`${where}: audience is required`);
      if (!["jwt", "introspection"].includes(i.validation ?? "jwt")) throw new Error(`${where}: validation must be jwt or introspection`);
      if ((i.validation ?? "jwt") === "introspection" && !i.introspection) throw new Error(`${where}: validation "introspection" needs introspection settings`);
      if (!["rfc9068", "claims"].includes(i.profile ?? "rfc9068")) throw new Error(`${where}: profile must be rfc9068 or claims`);
      if (!["client_id", "azp"].includes(i.clientClaim ?? "client_id")) throw new Error(`${where}: clientClaim must be client_id or azp`);
      if (i.request?.resource !== undefined && i.request.resource !== null) {
        try {
          if (!new URL(i.request.resource).protocol) throw new Error();
        } catch {
          throw new Error(`${where}: request.resource must be an absolute URI (RFC 8707)`);
        }
      }
      const requiredClaims = i.requiredClaims ?? {};
      if (typeof requiredClaims !== "object" || Array.isArray(requiredClaims) || !Object.values(requiredClaims).every((v) => typeof v === "string")) throw new Error(`${where}: requiredClaims must map claim names to text`);
      if (((i.profile ?? "rfc9068") === "claims" || (i.validation ?? "jwt") === "introspection") && !Object.keys(requiredClaims).length) {
        throw new Error(`${where}: requiredClaims must name a claim that only access tokens carry (for example {"typ": "Bearer"} for Keycloak)`);
      }
      const algorithms = strings(i.algorithms, `${where}: algorithms`);
      if (algorithms.some((a) => !SAFE_ALGS.includes(a))) throw new Error(`${where}: algorithms must be asymmetric JWS algorithms (${SAFE_ALGS.join(", ")})`);
      const cli = i.cli
        ? {
            clientId: String(i.cli.clientId),
            scopes: strings(i.cli.scopes ?? ["openid"], `${where}: cli.scopes`),
            redirectPath: typeof i.cli.redirectPath === "string" && i.cli.redirectPath.startsWith("/") ? i.cli.redirectPath : "/callback",
            grants: strings(i.cli.grants ?? ["authorization_code"], `${where}: cli.grants`).filter((g) => ["authorization_code", "device_code"].includes(g)),
          }
        : null;
      return {
        issuer: checkUrl(i.issuer, `${where}: issuer`),
        mode: "resource",
        audience: i.audience,
        validation: i.validation ?? "jwt",
        profile: i.profile ?? "rfc9068",
        clientClaim: i.clientClaim ?? "client_id",
        request: { resource: i.request?.resource ?? null, audience: i.request?.audience ?? null },
        requiredClaims,
        requiredScopes: strings(i.requiredScopes, `${where}: requiredScopes`),
        allowedClients: i.allowedClients === undefined ? null : strings(i.allowedClients, `${where}: allowedClients`),
        algorithms: algorithms.length ? algorithms : ["RS256", "ES256", "PS256", "EdDSA"],
        claims: { name: i.claims?.name ?? "preferred_username", groups: i.claims?.groups ?? "groups" },
        introspection: i.introspection
          ? { clientId: String(i.introspection.clientId), clientSecret: secretFrom(i.introspection.clientSecretFile, `${where}: introspection secret`), requiredFields: [...new Set(["sub", "aud", "exp", ...strings(i.introspection.requiredFields, `${where}: introspection.requiredFields`)])] }
          : null,
        cli,
      };
    }),
  };
  const ids = cfg.issuers.filter((i) => i.mode === "broker").map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${file}: every broker issuer needs its own id`);
  return cfg;
}

/**
 * A broker issuer (design 1.7): the relay is an OpenID Connect client of the provider.
 * `publicBaseUrl` is the relay's public https origin, set by the operator (never derived from
 * request headers).
 */
function brokerIssuer(i, where, int) {
  if (typeof i.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(i.id)) throw new Error(`${where}: id must be 1-32 lowercase letters, digits or "-" (it names the relay's endpoints)`);
  let base;
  try {
    base = new URL(i.publicBaseUrl);
  } catch {
    throw new Error(`${where}: publicBaseUrl must be the relay's public URL (https://relay.example.com)`);
  }
  if ((base.protocol !== "https:" && !LOOPBACK.test(i.publicBaseUrl)) || base.pathname !== "/" || base.search || base.hash || base.username || i.publicBaseUrl.replace(/\/$/, "") !== base.origin) {
    throw new Error(`${where}: publicBaseUrl must be an https origin without a path (https://relay.example.com)`);
  }
  const c = i.client ?? {};
  if (typeof c.clientId !== "string" || !c.clientId) throw new Error(`${where}: client.clientId is required`);
  if (Boolean(c.clientSecretFile) === Boolean(c.privateKeyFile)) throw new Error(`${where}: client needs exactly one of clientSecretFile or privateKeyFile`);
  const scopes = strings(i.scopes ?? ["openid"], `${where}: scopes`);
  if (!scopes.includes("openid")) throw new Error(`${where}: scopes must include openid`);
  let privateKey;
  if (c.privateKeyFile) {
    const text = secretFrom(c.privateKeyFile, `${where}: private key`);
    try {
      const jwk = text.startsWith("{") ? JSON.parse(text) : null;
      privateKey = { key: jwk ? crypto.createPrivateKey({ key: jwk, format: "jwk" }) : crypto.createPrivateKey(text), ...(jwk?.kid ? { kid: jwk.kid } : {}) };
    } catch {
      throw new Error(`${where}: client.privateKeyFile must hold a private key (PEM or JWK)`);
    }
    const t = privateKey.key.asymmetricKeyType;
    const curve = privateKey.key.asymmetricKeyDetails?.namedCurve;
    if (!(t === "rsa" || t === "ed25519" || (t === "ec" && ["prime256v1", "secp384r1"].includes(curve)))) throw new Error(`${where}: client.privateKeyFile must be an RSA, P-256, P-384 or Ed25519 key`);
  }
  return {
    issuer: checkUrl(i.issuer, `${where}: issuer`),
    mode: "broker",
    id: i.id,
    publicBaseUrl: base.origin,
    client: { clientId: c.clientId, clientSecret: c.clientSecretFile ? secretFrom(c.clientSecretFile, `${where}: client secret`) : undefined, privateKey },
    scopes,
    reverifyAfterSeconds: int(i.reverifyAfterSeconds, 60, 86_400),
    familyIdleSeconds: int(i.familyIdleSeconds, 60, 2_592_000),
    familyMaxSeconds: int(i.familyMaxSeconds, 60, 7_776_000),
    accessTokenSeconds: int(i.accessTokenSeconds, 30, 900),
    requireReauthentication: i.requireReauthentication === true,
  };
}

/**
 * The provider configuration identity of a broker issuer (design 1.7): a digest of the exact
 * issuer, the provider client id, the CLI's client id and the mode. Not a secret.
 */
export const configIdentity = (i) => crypto.createHash("sha256").update(JSON.stringify([i.issuer, i.client.clientId, "hoptell-cli", "broker"])).digest("hex");

/** The public discovery document (GET /.well-known/hoptell): no secrets. */
export function discoveryDocument(cfg, realm) {
  return {
    hoptell: 1,
    realm: realm ?? null,
    issuers: cfg.issuers.map((i) =>
      i.mode === "broker"
        ? { issuer: i.issuer, mode: "broker", id: i.id, configId: configIdentity(i), endpoints: Object.fromEntries(["authorize", "token", "revoke"].map((e) => [e, `${i.publicBaseUrl}/oidc/${i.id}/${e}`])) }
        : { issuer: i.issuer, mode: i.mode, audience: i.audience, request: i.request, cli: i.cli },
    ),
  };
}

/**
 * A bounded fetch for discovery, JWKS and introspection: a timeout, a response size limit,
 * coalescing of identical GETs in flight, and a failure backoff per origin (1 s doubling to 60 s).
 */
export function boundedFetch({ timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_MAX_BYTES, now = () => Date.now() } = {}) {
  const inflight = new Map();
  const backoff = new Map(); // origin -> {until, delay}
  async function once(url, options) {
    const origin = new URL(url).origin;
    const b = backoff.get(origin);
    if (b && now() < b.until) throw new Error(`the identity provider failed recently; retrying after ${Math.ceil((b.until - now()) / 1000)} s`);
    try {
      const r = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const reader = r.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Error("the identity provider's response is too large");
          }
          chunks.push(value);
        }
      }
      if (r.status >= 500) throw new Error(`the identity provider answered ${r.status}`);
      backoff.delete(origin);
      return new Response(Buffer.concat(chunks), { status: r.status, statusText: r.statusText, headers: r.headers });
    } catch (e) {
      const delay = Math.min(60_000, (b?.delay ?? 500) * 2);
      backoff.set(origin, { until: now() + delay, delay });
      throw e;
    }
  }
  return (url, options = {}) => {
    const key = (options.method ?? "GET") === "GET" && !options.body ? String(url) : null;
    if (key && inflight.has(key)) return inflight.get(key).then((r) => r.clone());
    const p = once(String(url), options);
    if (key) {
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    return p.then((r) => r.clone());
  };
}

const str = (v) => typeof v === "string" && v.length > 0;
const num = (v) => typeof v === "number" && Number.isFinite(v);
const scopesOf = (c) => (typeof c.scope === "string" ? c.scope.split(" ") : Array.isArray(c.scp) && c.scp.every((x) => typeof x === "string") ? c.scp : typeof c.scp === "string" ? c.scp.split(" ") : []).filter(Boolean);
const digestOf = (t) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * A verifier for the configured issuers. `verify(issuer, token)` resolves to {issuer, subject,
 * name, groups, deadline (ms), client, opaque} or throws OidcError. The token is checked only
 * against `issuer`, which must be configured.
 */
export async function createVerifier(cfg, { log = () => {}, jwksCooldownMs = 30_000, fetcher = boundedFetch(), now = () => Date.now(), skewSeconds = SKEW_S } = {}) {
  const jose = await import("jose");
  const oidc = await import("openid-client");
  // Resource-mode issuers only: broker credentials are never tried as provider tokens.
  const byIssuer = new Map(cfg.issuers.filter((i) => i.mode === "resource").map((i) => [i.issuer, i]));
  const state = new Map(); // issuer -> Promise<{meta, jwks, config}>
  const cache = new Map(); // issuer|digest -> {result, until}

  function setup(i) {
    if (!state.has(i.issuer)) {
      const p = (async () => {
        const opts = { timeout: 5, [oidc.customFetch]: fetcher, ...(LOOPBACK.test(i.issuer) ? { execute: [oidc.allowInsecureRequests] } : {}) };
        let config;
        try {
          // openid-client checks that the document's issuer equals the configured one.
          config = await oidc.discovery(new URL(i.issuer), i.introspection?.clientId ?? "hoptell-relay", i.introspection?.clientSecret ? { client_secret: i.introspection.clientSecret } : undefined, i.introspection?.clientSecret ? oidc.ClientSecretBasic(i.introspection.clientSecret) : oidc.None(), opts);
        } catch (e) {
          log(`sign-in: ${i.issuer} is not reachable (${e.code ?? e.message})`);
          throw new OidcError("unavailable", `the identity provider ${i.issuer} is not reachable (${e.code ?? e.message})`);
        }
        const meta = config.serverMetadata();
        // Key-set fetch failures are marked at the fetch boundary (status, transport), so they are
        // never mistaken for a refusal of the token itself.
        const jwksFetch = async (url, o) => {
          let r;
          try {
            r = await fetcher(url, o);
          } catch (e) {
            throw Object.assign(new Error(`the key set could not be fetched (${e.cause?.code ?? e.message})`), { providerFault: true });
          }
          if (r.status !== 200) throw Object.assign(new Error(`the key set answered HTTP ${r.status}`), { providerFault: true });
          // A body that is not JSON (a proxy's error page, a truncated answer) is the provider's
          // fault too; only then does jose judge the keys and the token.
          const body = await r.text();
          try {
            JSON.parse(body);
          } catch {
            throw Object.assign(new Error("the key set is not valid JSON"), { providerFault: true });
          }
          return new Response(body, { status: 200, headers: r.headers });
        };
        const jwks = meta.jwks_uri ? jose.createRemoteJWKSet(new URL(meta.jwks_uri), { cooldownDuration: jwksCooldownMs, timeoutDuration: FETCH_TIMEOUT_MS, cacheMaxAge: 10 * 60_000, [jose.customFetch]: jwksFetch }) : null;
        return { meta, jwks, config: i.introspection && meta.introspection_endpoint ? config : null };
      })();
      state.set(i.issuer, p);
      p.catch(() => state.delete(i.issuer)); // a failed setup is tried again later (with backoff)
    }
    return state.get(i.issuer);
  }

  /** Checks common to both kinds of tokens; returns the identity. */
  function accept(i, c, { opaque }) {
    if (!str(c.sub) || c.sub.length > 255) throw new OidcError("bad_token", "the token has no valid subject");
    if (!num(c.exp)) throw new OidcError("bad_token", "the token has no valid expiry");
    if (c.exp * 1000 + skewSeconds * 1000 <= now()) throw new OidcError("bad_token", "the token expired");
    if (c.nbf !== undefined && (!num(c.nbf) || c.nbf * 1000 - skewSeconds * 1000 > now())) throw new OidcError("bad_token", "the token is not valid yet");
    if (c.nonce !== undefined) throw new OidcError("bad_token", "an ID token is not an access token");
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(i.audience)) throw new OidcError("bad_token", "the token is not for this relay");
    const scopes = scopesOf(c);
    for (const need of i.requiredScopes) if (!scopes.includes(need)) throw new OidcError("bad_token", `the token lacks the scope ${need}`);
    // The configured client claim is authoritative; the other one, if present, must agree.
    if (str(c.client_id) && str(c.azp) && c.client_id !== c.azp) throw new OidcError("bad_token", "the token names two different clients");
    const client = str(c[i.clientClaim]) ? c[i.clientClaim] : null;
    if (i.allowedClients && !i.allowedClients.includes(client)) throw new OidcError("bad_token", "the token was issued to a client this relay does not accept");
    if (cfg.maxTokenLifetimeSeconds) {
      // An enforceable bound: a real issue time, not in the future, before the expiry, within the maximum.
      if (!num(c.iat) || c.iat * 1000 > now() + skewSeconds * 1000 || c.exp <= c.iat || c.exp - c.iat > cfg.maxTokenLifetimeSeconds) {
        throw new OidcError("bad_token", `the token's lifetime is missing or longer than this relay accepts (${cfg.maxTokenLifetimeSeconds} s)`);
      }
    }
    const groups = c[i.claims.groups];
    return {
      issuer: i.issuer,
      subject: c.sub,
      name: str(c[i.claims.name]) ? c[i.claims.name] : null,
      groups: Array.isArray(groups) ? groups.filter(str).slice(0, 100) : [],
      deadline: (c.exp + skewSeconds) * 1000,
      lifetime: num(c.iat) ? c.exp - c.iat : null,
      client,
      opaque,
    };
  }

  async function verifyJwt(i, s, token) {
    let protectedHeader;
    let payload;
    try {
      ({ payload, protectedHeader } = await jose.jwtVerify(token, s.jwks, { issuer: i.issuer, algorithms: i.algorithms, clockTolerance: skewSeconds, requiredClaims: ["iss", "sub", "exp", "aud"] }));
    } catch (e) {
      // The provider's keys could not be fetched (network, timeout, a bad JWKS document): not the
      // token's fault, so the client may try again; every other jose error refuses the token.
      // ERR_JOSE_GENERIC: jose's error for a non-200 JWKS response (for example 429 or 404).
      const providerFault = e.providerFault || e.cause?.providerFault || ["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"].includes(e.code) || !String(e.code ?? "").startsWith("ERR_J");
      if (providerFault) throw new OidcError("unavailable", `the keys of ${i.issuer} could not be fetched (${e.code ?? e.message})`);
      throw new OidcError("bad_token", `the token was refused (${e.code ?? "invalid"})`);
    }
    if (i.profile === "rfc9068") {
      const typ = String(protectedHeader.typ ?? "").toLowerCase();
      if (typ !== "at+jwt" && typ !== "application/at+jwt") throw new OidcError("bad_token", "the token is not an RFC 9068 access token");
      for (const k of ["client_id", "jti"]) if (!str(payload[k])) throw new OidcError("bad_token", `the token lacks ${k}`);
      if (!num(payload.iat)) throw new OidcError("bad_token", "the token lacks iat");
    }
    for (const [k, v] of Object.entries(i.requiredClaims)) if (payload[k] !== v) throw new OidcError("bad_token", "the token is not an access token for this relay");
    return accept(i, payload, { opaque: false });
  }

  async function verifyOpaque(i, s, token) {
    if (!s.config) throw new OidcError("bad_token", "this issuer's tokens must be JWTs (no introspection is configured)");
    const key = `${i.issuer}|${digestOf(token)}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.result;
    let r;
    try {
      r = await oidc.tokenIntrospection(s.config, token);
    } catch (e) {
      throw new OidcError("unavailable", `introspection at ${i.issuer} failed (${e.code ?? e.message})`);
    }
    if (r.active !== true) throw new OidcError("bad_token", "the token is not active");
    for (const f of i.introspection.requiredFields) if (r[f] === undefined) throw new OidcError("bad_token", `the introspection response lacks ${f}`);
    if (r.iss !== undefined && r.iss !== i.issuer) throw new OidcError("bad_token", "the token belongs to another issuer");
    // The provider's access-token marker must be there (active alone does not prove an access token).
    for (const [k, v] of Object.entries(i.requiredClaims)) if (r[k] !== v) throw new OidcError("bad_token", "the introspected token is not an access token for this relay");
    if (!str(r.sub) || !num(r.exp) || !(str(r.aud) || Array.isArray(r.aud))) throw new OidcError("bad_token", "the introspection response lacks a valid sub, aud or exp");
    const checkedAt = now();
    const result = { ...accept(i, r, { opaque: true }), checkedAt };
    if (cache.size >= INTROSPECTION_CACHE_MAX) cache.delete(cache.keys().next().value);
    // Absolute: from the provider's answer, never restarted by a cache hit, reconnect or reauth.
    cache.set(key, { result, until: Math.min(checkedAt + cfg.maxRevocationDelaySeconds * 1000, r.exp * 1000) });
    return result;
  }

  /** Verify `token` as an access token of `issuer` (named by the client). */
  async function verify(issuer, token, { fresh = false } = {}) {
    const i = byIssuer.get(issuer);
    if (!i) throw new OidcError("unsupported_auth", "this relay does not accept sign-in with that issuer");
    if (typeof token !== "string" || !token || token.length > 16_384) throw new OidcError("bad_token", "missing or oversized token");
    const s = await setup(i);
    // The issuer's configured strategy decides; nothing is guessed from the token's shape.
    if (i.validation === "jwt") return verifyJwt(i, s, token);
    if (fresh) cache.delete(`${i.issuer}|${digestOf(token)}`);
    return verifyOpaque(i, s, token);
  }

  return { verify, issuers: [...byIssuer.keys()], skewSeconds };
}

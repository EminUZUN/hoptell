// A small OpenID Connect provider for tests (provider-neutral fixtures for design 1.6): discovery,
// rotating JWKS, authorization code with PKCE, refresh with rotation and reuse detection, client
// credentials, the device grant, RFC 7662 introspection and RFC 7009 revocation. Not for use
// outside tests: it signs in whichever user the test names.
import crypto from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";

const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (s) => b64url(crypto.createHash("sha256").update(s).digest());

/**
 * Start a provider. Options: `audience`, `lifetime` (access token seconds), `opaque` (opaque
 * access tokens, introspection only), `device` (offer the device grant), `refresh` (issue refresh
 * tokens), `pairwise` (subjects differ per client), `clients` ({id: {secret?, redirect?}}).
 * The test chooses who signs in: `provider.signIn = {sub, name, groups}`.
 */
export async function startProvider({ trailingSlash = false, audience = "hoptell-relay", lifetime = 300, opaque = false, device = true, refresh = true, pairwise = false, refreshDelayMs = 0, clients = {} } = {}) {
  let keys = [];
  const rotate = async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const kid = crypto.randomBytes(8).toString("hex");
    keys = [{ kid, publicKey, privateKey }, ...keys].slice(0, 2); // the previous key stays published once
    return kid;
  };
  await rotate();
  const codes = new Map();
  const refreshTokens = new Map(); // token -> {sub, client, scope, used}
  const opaqueTokens = new Map(); // token -> claims
  const deviceCodes = new Map();
  const revoked = new Set();
  let jwksFetches = 0;
  // Refresh grants: how many overlapped at most, and how many presented an already rotated token.
  const refreshes = { total: 0, inFlight: 0, maxInFlight: 0, reused: 0 };
  const provider = {
    refreshes,
    tokenRequests: [], // {grant, resource, audience} of every token request
    signIn: { sub: "user-1", name: "alice", groups: ["dev"] },
    issuer: null,
    rotate,
    get jwksFetches() {
      return jwksFetches;
    },
    revoke: (sub) => revoked.add(sub),
    /** Issue an access token directly (tests of the relay alone). */
    issue: (o = {}) => accessToken({ sub: provider.signIn.sub, client: "hoptell-cli", scope: "openid hoptell", groups: provider.signIn.groups, ...o }),
  };
  const subOf = (sub, client) => (pairwise ? sha256(`${client}|${sub}`).slice(0, 20) : sub);

  async function accessToken({ sub, client, scope, groups, aud = audience, exp = lifetime, typ = "at+jwt", alg = "ES256", key = keys[0], extra = {} }) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: subOf(sub, client), client_id: client, scope, groups, preferred_username: provider.signIn.name, jti: crypto.randomUUID(), ...extra };
    if (opaque) {
      const t = crypto.randomBytes(24).toString("hex");
      opaqueTokens.set(t, { typ: "Bearer", ...claims, iss: provider.issuer, aud, exp: now + exp, iat: now, active: true, rawSub: sub });
      return t;
    }
    return new SignJWT(claims).setProtectedHeader({ alg, kid: key.kid, typ }).setIssuer(provider.issuer).setAudience(aud).setIssuedAt(now).setExpirationTime(now + exp).sign(key.privateKey);
  }
  // `provider.idTokenTamper` (tests of the broker): {claims, issuer, audience, exp} replace the
  // ID token's own values.
  const idToken = (sub, client, nonce) => {
    const now = Math.floor(Date.now() / 1000);
    const t = provider.idTokenTamper ?? {};
    return new SignJWT({ sub: subOf(sub, client), ...(nonce ? { nonce } : {}), auth_time: now, preferred_username: provider.signIn.name, groups: provider.signIn.groups, ...(t.claims ?? {}) })
      .setProtectedHeader({ alg: "ES256", kid: keys[0].kid, typ: "JWT" })
      .setIssuer(t.issuer ?? provider.issuer)
      .setAudience(t.audience ?? client)
      .setIssuedAt(t.iat ?? now)
      .setExpirationTime(t.exp ?? now + 300)
      .sign(keys[0].privateKey)
      // `badSignature`: one bit of the signature changed, every claim intact.
      .then((jwt) => (t.badSignature ? jwt.slice(0, -2) + (jwt.at(-2) === "A" ? "B" : "A") + jwt.at(-1) : jwt));
  };
  async function tokens(sub, client, scope, nonce) {
    const out = { access_token: await accessToken({ sub, client, scope, groups: provider.signIn.groups }), token_type: "Bearer", expires_in: lifetime, scope };
    if (scope.split(" ").includes("openid")) out.id_token = await idToken(sub, client, nonce);
    if (refresh) {
      const r = crypto.randomBytes(24).toString("hex");
      refreshTokens.set(r, { sub, client, scope, used: false });
      out.refresh_token = r;
    }
    return out;
  }
  // `clients[id].jwk`: the client authenticates with private_key_jwt (RFC 7523), signed with the
  // private key of that public JWK; the assertion is verified before the request is served.
  const clientOk = (id, secret, viaJwt = false) => {
    const c = clients[id];
    if (!c) return false;
    if (c.jwk) return viaJwt;
    return c.secret === undefined || c.secret === secret;
  };
  provider.assertions = 0;
  const assertionClient = async (body) => {
    const a = body.get("client_assertion");
    if (!a || body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return null;
    for (const [id, c] of Object.entries(clients)) {
      if (!c.jwk) continue;
      try {
        await jwtVerify(a, await importJWK(c.jwk, c.jwk.alg), { issuer: id, subject: id, audience: [provider.issuer, `${provider.issuer}/token`] });
        provider.assertions++;
        return id;
      } catch {}
    }
    return null;
  };
  const authOf = (req, body) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(h.slice(6), "base64").toString().split(":").map(decodeURIComponent);
      return { id, secret };
    }
    return { id: body.get("client_id"), secret: body.get("client_secret") };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url.replace(/\/{2,}/g, "/"), "http://127.0.0.1"); // an issuer ending in "/" yields "//jwks"
    const json = (code, obj) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(obj));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw);
    try {
      if (url.pathname === "/.well-known/openid-configuration") {
        if (provider.slowMs) await new Promise((r) => setTimeout(r, provider.slowMs));
        return json(200, {
          issuer: provider.issuer,
          authorization_endpoint: `${provider.issuer}/authorize`,
          token_endpoint: `${provider.issuer}/token`,
          jwks_uri: `${provider.issuer}/jwks`,
          introspection_endpoint: `${provider.issuer}/introspect`,
          revocation_endpoint: `${provider.issuer}/revoke`,
          ...(device ? { device_authorization_endpoint: `${provider.issuer}/device` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", ...(device ? ["urn:ietf:params:oauth:grant-type:device_code"] : [])],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["ES256"],
          subject_types_supported: [pairwise ? "pairwise" : "public"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        });
      }
      if (url.pathname === "/jwks") {
        jwksFetches++;
        if (provider.slowMs) await new Promise((r) => setTimeout(r, provider.slowMs));
        if (provider.jwksDown) return json(provider.jwksDown === true ? 503 : provider.jwksDown, { error: "temporarily_unavailable" });
        if (provider.jwksBody) return res.writeHead(200, { "content-type": "text/html" }).end(provider.jwksBody);
        return json(200, { keys: await Promise.all(keys.map(async (k) => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: "ES256", use: "sig" }))) });
      }
      if (url.pathname === "/authorize") {
        // Signs in provider.signIn at once (the test is the user) and redirects with a code.
        const q = url.searchParams;
        provider.lastAuthorize = q; // tests: what the client asked for
        const client = clients[q.get("client_id")];
        if (!client || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
        const redirect = q.get("redirect_uri");
        if (client.redirect && !redirect.startsWith(client.redirect)) return json(400, { error: "invalid_redirect" });
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, { client: q.get("client_id"), redirect, challenge: q.get("code_challenge"), scope: q.get("scope") ?? "openid", nonce: q.get("nonce"), sub: provider.signIn.sub, resource: q.get("resource") });
        const to = new URL(redirect);
        to.searchParams.set("code", code);
        if (q.get("state")) to.searchParams.set("state", q.get("state"));
        to.searchParams.set("iss", provider.issuer);
        return res.writeHead(302, { location: to.href }).end();
      }
      if (url.pathname === "/device") {
        if (!device) return json(404, { error: "not_found" });
        const { id } = authOf(req, body);
        const dc = crypto.randomBytes(16).toString("hex");
        // PKCE on the device grant, checked when a challenge was sent (as Keycloak does).
        deviceCodes.set(dc, { client: id, scope: body.get("scope") ?? "openid", approved: false, sub: provider.signIn.sub, challenge: body.get("code_challenge") });
        provider.approveDevice = () => (deviceCodes.get(dc).approved = true);
        return json(200, { device_code: dc, user_code: "ABCD-EFGH", verification_uri: `${provider.issuer}/activate`, expires_in: 600, interval: 1 });
      }
      if (url.pathname === "/token") {
        const viaJwt = await assertionClient(body);
        const { id, secret } = viaJwt ? { id: viaJwt, secret: undefined } : authOf(req, body);
        if (!clientOk(id, secret, Boolean(viaJwt))) return json(401, { error: "invalid_client" });
        const grant = body.get("grant_type");
        provider.tokenRequests.push({ grant, resource: body.get("resource"), audience: body.get("audience") });
        if (grant === "authorization_code") {
          if (provider.codeError) return json(400, { error: provider.codeError });
          const c = codes.get(body.get("code"));
          codes.delete(body.get("code"));
          if (!c || c.client !== id || c.redirect !== body.get("redirect_uri") || sha256(body.get("code_verifier") ?? "") !== c.challenge) return json(400, { error: "invalid_grant" });
          return json(200, await tokens(c.sub, id, c.scope, c.nonce));
        }
        if (grant === "refresh_token") {
          refreshes.total++;
          refreshes.maxInFlight = Math.max(refreshes.maxInFlight, ++refreshes.inFlight);
          try {
            if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
            const r = refreshTokens.get(body.get("refresh_token"));
            if (!r || r.client !== id || revoked.has(r.sub)) return json(400, { error: "invalid_grant" });
            if (r.used) {
              // Reuse of a rotated refresh token: revoke the whole family.
              refreshes.reused++;
              for (const [k, v] of refreshTokens) if (v.sub === r.sub && v.client === id) refreshTokens.delete(k);
              return json(400, { error: "invalid_grant", error_description: "refresh token reused" });
            }
            r.used = true;
            return json(200, await tokens(r.sub, id, r.scope));
          } finally {
            refreshes.inFlight--;
          }
        }
        if (grant === "client_credentials") {
          const scope = body.get("scope") ?? "hoptell";
          return json(200, { access_token: await accessToken({ sub: `service-${id}`, client: id, scope, groups: [] }), token_type: "Bearer", expires_in: lifetime, scope });
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          const d = deviceCodes.get(body.get("device_code"));
          if (!d || (d.challenge && sha256(body.get("code_verifier") ?? "") !== d.challenge)) return json(400, { error: "invalid_grant" });
          if (!d.approved) return json(400, { error: "authorization_pending" });
          deviceCodes.delete(body.get("device_code"));
          return json(200, await tokens(d.sub, id, d.scope));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/introspect") {
        const { id, secret } = authOf(req, body);
        if (!clientOk(id, secret)) return json(401, { error: "invalid_client" });
        const t = opaqueTokens.get(body.get("token"));
        if (!t || revoked.has(t.rawSub) || t.exp < Date.now() / 1000) return json(200, { active: false });
        const { rawSub, ...claims } = t;
        void rawSub;
        return json(200, claims);
      }
      if (url.pathname === "/revoke") {
        refreshTokens.delete(body.get("token"));
        opaqueTokens.delete(body.get("token"));
        return res.writeHead(200).end();
      }
      json(404, { error: "not_found" });
    } catch (e) {
      json(500, { error: "server_error", error_description: e.message });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  provider.issuer = `http://127.0.0.1:${server.address().port}${trailingSlash ? "/" : ""}`;
  provider.close = () => new Promise((r) => server.close(r));
  provider.accessToken = accessToken;
  provider.keysForTests = async () => keys;
  return provider;
}

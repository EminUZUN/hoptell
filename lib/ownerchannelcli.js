// `hoptell telegram ...` (design 7.2, 7.3): setup, pair, trust, key next|commit, run, status,
// identity, fav, unfav, alias, sessions, unpair.
//
// The bot token is read from standard input only (never from arguments or the environment) and
// kept in the credential store (the OS keychain, or the encrypted file) under
// "telegram-bot-<bot id>"; the bridge's signing key under "owner-channel-key-<bot id>". Nothing
// printed here holds the token or a private key.
import { TELEGRAM_USAGE } from "./clihelp.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, NAME_RULE, defaultHome, envAuth, envCredentialStore, envOwnerChannel } from "./config.js";
import { credentialStore, removeDurable } from "./credentials.js";
import { NAME_REFUSED, RelayClient } from "./client.js";
import { tryLock } from "./locks.js";
import { APP_ORIGIN_PROBLEMS, appOriginFor } from "./ownerapp.js";
import { appSecret } from "./ownerappauth.js";
import { EXIT_ENCRYPTION_REQUIRED, audit, changeOwnerApp, createBridge, readState, keepMenuCleanup, newPairingCode, readBridgeConfig, readPairing, runState, statusLines } from "./ownerchannel.js";
import * as sig from "./ownersig.js";
import { PeopleFullError, PeopleRefusedError, PeopleStaleError, aliasProblemIn, bump, normalAlias, readPeople, removePeople, updatePeople } from "./ownerpeople.js";
import { IDENTITY, TEXTS, ago } from "./ownertexts.js";
import { PHOTO_MAX, createTelegram, isBotToken, isJpeg, redact } from "./telegram.js";
import { statusMark, wrap } from "./words.js";

export const USAGE = TELEGRAM_USAGE;

const tokenAccount = (botId) => `telegram-bot-${botId}`;
const keyAccount = (botId) => `owner-channel-key-${botId}`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exit = code;
  }
}

/** Read one line of standard input (a confirmation), trimmed; "" at its end. */
async function readLine(stream) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: stream, terminal: false });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

/** Read all of standard input (the token), trimmed. */
async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Run a `hoptell telegram` subcommand. `deps`: home, env and homedir (the caller passes its own;
 * nothing ambient is read here); tests also pass stdin (a stream or string),
 * out/err (line writers), telegramFactory(token), keychainBackend, clientFactory, now,
 * pollTimeout, signals (false: no signal handlers). Resolves to the exit code.
 */
export async function telegramCommand(argv, deps = {}) {
  const env = deps.env ?? {};
  const homedir = deps.homedir ?? "";
  const home = deps.home ?? defaultHome(env, homedir);
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const telegramFactory = deps.telegramFactory ?? ((token) => createTelegram(token));
  // A misspelled credential store refuses the command before anything is read or changed.
  let storeKind;
  try {
    storeKind = envCredentialStore(env);
  } catch (e) {
    throw new CliError(e.message);
  }
  const store = (account) => credentialStore(home, account, { store: storeKind, passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null, ...(deps.keychainBackend ? { keychainBackend: deps.keychainBackend } : {}) });
  const args = [...argv];
  const opt = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new CliError(`${flag} needs a value`, 2);
    args.splice(i, 2);
    return v;
  };
  const flag = (f) => {
    const i = args.indexOf(f);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  // A word or option the subcommand does not take is refused, never ignored.
  const done = () => {
    if (args.length) throw new CliError(USAGE, 2);
  };
  let token = null; // known only while a command uses it, for redaction
  try {
    const sub = args.shift();
    switch (sub) {
      case "setup":
        return await setup();
      case "pair":
        return await pair();
      case "trust":
        return trust();
      case "key":
        return await keyCmd();
      case "run":
        return await run();
      case "status":
        return status();
      case "identity":
        return await identity();
      case "fav":
      case "unfav":
        return await favCmd(sub === "fav");
      case "alias":
        return await aliasCmd();
      case "sessions":
        return sessionsCmd();
      case "unpair":
        return await unpair();
      case "app":
        return await appCmd();
      case "help":
        out(USAGE);
        return 0;
      case undefined:
        err(USAGE);
        return 2;
      default:
        err(`hoptell: unknown telegram command "${sub}" (see hoptell telegram --help)`);
        return 2;
    }
  } catch (e) {
    err(`hoptell telegram: ${redact(e.message, token)}`);
    return e.exit ?? 1;
  }

  // ---- shared ---------------------------------------------------------------------------

  /** The relay the bridge joins: {alias, url, token?, signIn?, namePrefix} from the relays file or HOPTELL_RELAY. */
  async function relayEntry(alias) {
    const file = env.HOPTELL_RELAYS || path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "hoptell", "relays.json");
    if (env.HOPTELL_RELAYS || fs.existsSync(file)) {
      const { readRelaysFile } = await import("./relays.js");
      const r = readRelaysFile(file, { env, homedir });
      const a = alias ?? r.default;
      if (!a) throw new CliError(`say which relay: --relay <alias> (relays: ${r.relays.map((x) => x.alias).join(", ")})`, 2);
      const e = r.relays.find((x) => x.alias === a);
      if (!e) throw new CliError(`no relay "${a}" in ${file}`, 2);
      if (e.tokenProblem) throw new CliError(`relay ${a}: ${e.tokenProblem}`);
      return { alias: a, url: e.url, auth: e.auth, token: e.auth === "token" ? e.token : null, profile: e.profile, namePrefix: e.namePrefix ?? "" };
    }
    if (alias && alias !== "default") throw new CliError("--relay needs a relays file (HOPTELL_RELAYS; see README)", 2);
    if (!env.HOPTELL_RELAY) throw new CliError("no relay: set HOPTELL_RELAY and HOPTELL_TOKEN, or use a relays file");
    let auth;
    try {
      auth = envAuth(env);
    } catch (e) {
      throw new CliError(e.message);
    }
    return { alias: "default", url: env.HOPTELL_RELAY, auth, token: auth === "token" ? env.HOPTELL_TOKEN : null, profile: env.HOPTELL_PROFILE || null, namePrefix: "" };
  }

  async function relayOptions(e) {
    if (e.auth !== "login") {
      if (!e.token) throw new CliError(`relay ${e.alias} has no token`);
      return { url: e.url, token: e.token };
    }
    const { tokenSource } = await import("./login.js");
    const { profileKey } = await import("./profiles.js");
    return { url: e.url, token: null, signIn: tokenSource({ home, relayUrl: e.url, profile: profileKey(e.url, e.profile), passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null }) };
  }

  function wireOf(e, logical) {
    if (!NAME_RE.test(logical ?? "")) throw new CliError(`--name: ${NAME_RULE}`, 2);
    const wire = e.namePrefix && !logical.startsWith(e.namePrefix) ? `${e.namePrefix}${logical}` : logical;
    if (!NAME_RE.test(wire)) throw new CliError(`the bridge name ${wire} is too long`, 2);
    return wire;
  }

  function config() {
    const b = readBridgeConfig(home);
    if (!b) throw new CliError("the owner channel is not set up on this home: run hoptell telegram setup");
    return b;
  }

  function loadKey(b) {
    const k = store(keyAccount(b.bot_id)).read();
    if (!k) throw new CliError("the bridge's signing key is missing from the credential store; run hoptell telegram setup again");
    const cur = sig.checkKey(k.current);
    if (cur.pub !== b.key.pub) throw new CliError("the stored signing key does not match bridge.json; run hoptell telegram setup again");
    return { cur, next: k.next ? sig.checkKey(k.next) : null };
  }

  /** The bridge must be stopped: its run lock is free (taken and given back at once). */
  function whileStopped(fn) {
    sig.ensureChannelDir(home);
    const release = tryLock(sig.channelPaths(home).lock);
    if (typeof release !== "function") throw new CliError(`the bridge is running (pid ${release.pid}); stop it first`);
    try {
      return fn();
    } finally {
      release();
    }
  }

  function pinOf(b, pub) {
    return sig.formatPin({ realm: b.realm, name: b.wire, pub });
  }

  // ---- setup ----------------------------------------------------------------------------

  async function setup() {
    const alias = opt("--relay");
    const logical = opt("--name") ?? "owner";
    done();
    const stdin = deps.stdin ?? process.stdin;
    if (typeof stdin !== "string" && stdin.isTTY) err("Paste the bot token from BotFather, then press Enter and Ctrl-D:");
    token = typeof stdin === "string" ? stdin.trim() : await readAll(stdin);
    if (!isBotToken(token)) throw new CliError("standard input does not hold a bot token (<bot id>:<secret>)");
    const tg = telegramFactory(token);
    const me = await tg.getMe();
    const botId = String(me?.id ?? "");
    if (!me?.is_bot || botId !== token.split(":")[0]) throw new CliError("Telegram's getMe does not describe this token's bot");
    const hook = await tg.getWebhookInfo();
    if (hook?.url) throw new CliError("a webhook is set for this bot, so getUpdates cannot work; hoptell never deletes it. Remove it (deleteWebhook) or use another bot.");
    const old = readBridgeConfig(home);
    if (old && old.bot_id !== botId) throw new CliError(`this home's owner channel uses bot @${old.username}; a token for another bot starts a new channel: run hoptell telegram unpair --all first`);
    const e = await relayEntry(alias ?? old?.alias ?? null);
    const wire = wireOf(e, logical);
    if (old && (old.alias !== e.alias || old.wire !== wire)) throw new CliError(`this home's bridge is ${old.alias}/${old.wire}; run hoptell telegram unpair --all to set up another`);
    // The relay's realm and member, from a send-only sign-in (never claims the bridge's name).
    const c = (deps.clientFactory ?? ((o) => new RelayClient(o)))({ ...(await relayOptions(e)), name: `${wire}-setup`.slice(0, 64), mode: "send", reconnect: false, require2: true });
    let realm;
    let member;
    try {
      await c.start().ready(10_000).catch((refusal) => {
        if (!refusal.message.includes(`${NAME_REFUSED}: `)) throw refusal;
        // A first setup can pick another name: a relay entry's namePrefix comes first in it, so a
        // wrong one is fixed there. An existing bridge's name cannot be changed in place.
        // The member's name when the relay says whose token this is (an older relay does not).
        const m = c.helloError?.member ?? "<member>";
        const fix = old ? "" : e.namePrefix ? `; set namePrefix to "${m}-" in relay entry "${e.alias}"` : `; e.g. hoptell telegram setup --name ${m}-${logical}`;
        throw new CliError(`the relay refused the bridge name ${wire}: the bridge needs a member token, which may use only "${m}" or names that start with "${m}-"${fix} (4002)`);
      });
      realm = c.realm?.id;
      member = c.member?.id;
    } finally {
      c.close();
    }
    if (!realm || !member) throw new CliError("the bridge needs a member token on a protocol-2 relay (it accepts questions only from its own member)");
    if (old && old.realm !== realm) throw new CliError("the relay's realm changed since setup; run hoptell telegram unpair --all to set up again");
    // The token: a new one for the same bot replaces the stored one; nothing else changes.
    store(tokenAccount(botId)).write({ token });
    let key = old ? loadKey(old).cur : null;
    if (!key) {
      key = sig.newKey();
      store(keyAccount(botId)).write({ current: key, next: null });
    }
    const doc = { v: 1, bot_id: botId, username: String(me.username ?? ""), alias: e.alias, logical, wire, realm, member, key: { id: sig.keyIdOf(key.pub), pub: key.pub }, next: old?.next ?? null };
    sig.writePrivateJson(sig.channelPaths(home).bridge, doc);
    const pin = pinOf(doc, key.pub);
    sig.trustPin(home, pin, sig.pinFor(home, realm)?.keys.some((k) => k.id === doc.key.id) ? { add: true } : {});
    audit(home, old ? "token-replaced" : "setup", { bot: botId }, deps.now?.() ?? Date.now());
    if (old) {
      out(`The token of @${doc.username} was replaced. The pairing, state, signing key and every pin stay valid.`);
      return 0;
    }
    out(`Owner channel set up: bot @${doc.username}, bridge ${e.alias}/${wire}.`);
    out(`On each of your other agent machines, run this to trust this owner channel's signing key (already trusted here):`);
    out(`  hoptell telegram trust '${pin}'`);
    out("Next: hoptell telegram run (keep it running), then hoptell telegram pair.");
    return 0;
  }

  // ---- pair -----------------------------------------------------------------------------

  async function pair() {
    done();
    const b = config();
    const code = await newPairingCode(home, b.bot_id, deps.now?.() ?? Date.now());
    out(`Within 10 minutes, send this to @${b.username} from your own Telegram account, in a private chat:`);
    out(`  /start ${code}`);
    out(`(or open https://t.me/${b.username}?start=${code})`);
    out("hoptell telegram run must be running. The code works once; a wrong code is ignored, and five wrong codes void it.");
    return 0;
  }

  // ---- trust ------------------------------------------------------------------------------

  function trust() {
    const removeKey = opt("--remove-key");
    const realm = opt("--realm");
    const revoke = opt("--revoke");
    const add = flag("--add");
    // One action, with only its own options, checked before anything changes.
    if (realm !== null && !removeKey) throw new CliError(USAGE, 2);
    if ((removeKey || revoke) && (add || (removeKey && revoke))) throw new CliError(USAGE, 2);
    if (removeKey || revoke) done();
    if (removeKey) {
      const r = sig.removeTrustedKey(home, removeKey, { realm });
      audit(home, "trusted", { realm: r.realm, removed: removeKey }, deps.now?.() ?? Date.now());
      out(r.left.length ? `Key ${removeKey} is no longer trusted for realm ${r.realm}; ${r.left.join(", ")} still is.` : `Key ${removeKey} is no longer trusted for realm ${r.realm}; no owner channel is trusted for realm ${r.realm} now.`);
      return 0;
    }
    if (revoke) {
      sig.revokeRealm(home, revoke);
      audit(home, "trusted", { realm: revoke, revoked: true }, deps.now?.() ?? Date.now());
      out(`The owner channel of realm ${revoke} is no longer trusted on this machine.`);
      return 0;
    }
    const text = args.shift();
    if (!text || args.length) throw new CliError(USAGE, 2);
    const r = sig.trustPin(home, text, { add });
    audit(home, "trusted", { realm: r.realm, keys: r.after }, deps.now?.() ?? Date.now());
    out(`Trusted the owner channel ${r.name} for realm ${r.realm}.`);
    out(`Key ids before: ${r.before.length ? r.before.join(", ") : "(none)"}; now: ${r.after.join(", ")}.`);
    return 0;
  }

  // ---- key next | key commit ----------------------------------------------------------

  async function keyCmd() {
    const what = args.shift();
    done();
    const b = config();
    if (what === "next") {
      return whileStopped(() => {
        const { cur, next } = loadKey(b);
        if (next) throw new CliError(`a next key is already staged (${sig.keyIdOf(next.pub)}); commit it first`);
        const k = sig.newKey();
        store(keyAccount(b.bot_id)).write({ current: cur, next: k });
        sig.writePrivateJson(sig.channelPaths(home).bridge, { ...b, next: { id: sig.keyIdOf(k.pub), pub: k.pub } });
        const pin = pinOf(b, k.pub);
        try {
          sig.trustPin(home, pin, { add: true }); // this home's own agents
        } catch (e) {
          err(`note: this home could not add the next key (${e.message})`);
        }
        audit(home, "key-next", { key: sig.keyIdOf(k.pub) }, deps.now?.() ?? Date.now());
        out("A next signing key is staged; the bridge keeps signing with the current one.");
        out("On each agent machine, add it next to the current key:");
        out(`  hoptell telegram trust --add '${pin}'`);
        out("Then: hoptell telegram key commit (with the bridge stopped).");
        return 0;
      });
    }
    if (what === "commit") {
      return whileStopped(() => {
        const { cur, next } = loadKey(b);
        if (!next) throw new CliError("no next key is staged: run hoptell telegram key next");
        store(keyAccount(b.bot_id)).write({ current: next, next: null });
        sig.writePrivateJson(sig.channelPaths(home).bridge, { ...b, key: { id: sig.keyIdOf(next.pub), pub: next.pub }, next: null });
        audit(home, "key-commit", { key: sig.keyIdOf(next.pub), old: sig.keyIdOf(cur.pub) }, deps.now?.() ?? Date.now());
        out(`The bridge signs with key ${sig.keyIdOf(next.pub)} from its next run.`);
        out(`Once every machine trusts it, remove the old key there: hoptell telegram trust --remove-key ${sig.keyIdOf(cur.pub)}`);
        return 0;
      });
    }
    throw new CliError(USAGE, 2);
  }

  // ---- identity (design 7.3, section 4; notes N11) -------------------------------------------

  /**
   * The bot's profile texts (name, short description, description): shows what Telegram has now
   * and what would change; `--apply` asks for "yes" on standard input, then sets only what
   * differs. `--photo <file.jpg>` also uploads a profile photo (a JPG of at most 2 MB, read and
   * checked before anything is asked), `--remove-photo` removes it; Telegram cannot show the
   * current photo here, so either one is always applied when given. Never run by the bridge.
   */
  async function identity() {
    const apply = flag("--apply");
    const photoFile = opt("--photo");
    const removePhoto = flag("--remove-photo");
    if (args.length || (photoFile && removePhoto)) throw new CliError(USAGE, 2);
    const jpeg = photoFile ? readPhoto(photoFile) : null;
    const b = config();
    token = store(tokenAccount(b.bot_id)).read()?.token ?? null;
    if (!isBotToken(token)) throw new CliError("the bot token is missing from the credential store; run hoptell telegram setup (token on standard input)");
    const tg = telegramFactory(token);
    const now = {
      name: String((await tg.getMyName({}))?.name ?? ""),
      short_description: String((await tg.getMyShortDescription({}))?.short_description ?? ""),
      description: String((await tg.getMyDescription({}))?.description ?? ""),
    };
    const LABEL = { name: "Name", short_description: "Short description (the profile's about text)", description: "Description (shown in an empty chat)" };
    const quote = (v) => (v === "" ? "(empty)" : v.split("\n").map((l, i) => (i ? `       ${l}` : l)).join("\n"));
    const changes = Object.keys(LABEL).filter((k) => now[k] !== IDENTITY[k]);
    out(`The profile texts of @${b.username}:`);
    for (const k of Object.keys(LABEL)) {
      if (!changes.includes(k)) out(`${LABEL[k]}: unchanged\n  now: ${quote(now[k])}`);
      else out(`${LABEL[k]}: would change\n  now: ${quote(now[k])}\n  new: ${quote(IDENTITY[k])}`);
    }
    if (jpeg) out(`Profile photo: would be set from ${photoFile} (${Math.ceil(jpeg.length / 1024)} KB)`);
    else if (removePhoto) out("Profile photo: would be removed");
    else out("Profile photo: not changed (to set one: --photo <file.jpg>; to remove it: --remove-photo)");
    const photo = jpeg || removePhoto;
    if (!changes.length && !photo) {
      out("Nothing to change.");
      return 0;
    }
    if (!apply) {
      out(photo ? "To apply, run the same command with --apply." : "To set them: hoptell telegram identity --apply");
      return 0;
    }
    const stdin = deps.stdin ?? process.stdin;
    err(`Apply these changes to @${b.username}? Type yes to apply them, anything else cancels:`);
    const answer = typeof stdin === "string" ? stdin.split("\n")[0].trim() : await readLine(stdin);
    if (answer !== "yes") {
      out("Nothing was changed.");
      return 1;
    }
    const SET = { name: (v) => tg.setMyName({ name: v }), short_description: (v) => tg.setMyShortDescription({ short_description: v }), description: (v) => tg.setMyDescription({ description: v }) };
    for (const k of changes) {
      await SET[k](IDENTITY[k]);
      out(`Set: ${LABEL[k]}.`);
    }
    if (jpeg) {
      await tg.setMyProfilePhoto({ jpeg });
      out("Set: Profile photo.");
    } else if (removePhoto) {
      await tg.removeMyProfilePhoto({});
      out("Removed: Profile photo.");
    }
    audit(home, "identity", { fields: changes, ...(jpeg ? { photo: "set" } : removePhoto ? { photo: "removed" } : {}) }, deps.now?.() ?? Date.now());
    out("Done. Telegram may take a few minutes to show the new texts.");
    return 0;
  }

  /** A profile photo file: a regular file, a JPG, at most PHOTO_MAX bytes; read once. */
  function readPhoto(file) {
    let st;
    let b;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) throw new CliError(`the photo is not a file: ${file}`);
      if (st.size > PHOTO_MAX) throw new CliError(`the photo is too large: ${Math.ceil(st.size / 1024)} KB; the limit is 2 MB`);
      b = fs.readFileSync(file);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`cannot read the photo: ${e.code ?? e.message}`);
    }
    if (b.length > PHOTO_MAX) throw new CliError(`the photo is too large: ${Math.ceil(b.length / 1024)} KB; the limit is 2 MB`);
    if (!isJpeg(b)) throw new CliError("the photo must be a JPG file (Telegram takes only JPG for a bot's profile photo)");
    return b;
  }

  // ---- favourites, names, sessions (design 7.3, 2.7; phase-2 notes P12) -------------------------

  /** people.json's scope: this bridge's member and the paired Telegram user; refused while unpaired. */
  function peopleScope() {
    const b = config();
    const p = readPairing(home)?.paired;
    if (!p) throw new CliError("the owner channel is not paired yet: run hoptell telegram pair");
    if (!b.member) throw new CliError("this bridge's setup has no member id; run hoptell telegram setup again");
    return { b, scope: { member: b.member, owner: p.user_id }, pairingId: p.id };
  }
  /** The relay entry's name prefix, if the relay entry can be read (else none). */
  async function prefixOf(b) {
    try {
      return (await relayEntry(b.alias)).namePrefix ?? "";
    } catch {
      return "";
    }
  }
  /** A logical or wire name as a wire name: a name people.json holds as it is, else with the prefix. */
  async function wireName(b, sessions, n) {
    if (typeof n !== "string" || !n) throw new CliError(USAGE, 2);
    const prefix = await prefixOf(b);
    const wire = Object.hasOwn(sessions, n) || !prefix || n.startsWith(prefix) ? n : `${prefix}${n}`;
    if (!NAME_RE.test(wire) || wire === b.wire) throw new CliError(`${n} is not the name of one of your agents`, 2);
    return { wire, logical: prefix && wire.startsWith(prefix) && wire.length > prefix.length ? wire.slice(prefix.length) : wire };
  }
  /** people.json changes of this command are written as "cli:<random>" (design 7.4, section 7). */
  function cliOp() {
    return `cli:${crypto.randomBytes(8).toString("hex")}`;
  }
  function fullName(logical, alias) {
    return alias ? `${alias} (${logical})` : logical;
  }
  /**
   * Change people.json under its lock, only while the pairing and member this command started with
   * are still the current ones (an unpair or a new pairing while it waited for the relay or the
   * lock writes nothing).
   */
  async function changePeople({ b, scope, pairingId }, change) {
    const still = () => readPairing(home)?.paired?.id === pairingId && readBridgeConfig(home)?.member === b.member;
    try {
      return await updatePeople(home, scope, change, deps.now?.() ?? Date.now(), { still });
    } catch (e) {
      if (e instanceof PeopleFullError) throw new CliError(TEXTS.peopleFull);
      if (e instanceof PeopleStaleError) throw new CliError("the owner channel's pairing changed while this ran; nothing was saved: run the command again");
      if (e instanceof PeopleRefusedError) throw new CliError(e.reason === "taken" ? TEXTS.aliasTaken : TEXTS.aliasInvalid);
      throw e;
    }
  }

  async function favCmd(on) {
    const ps = peopleScope();
    const { b, scope } = ps;
    const n = args.shift();
    done();
    const { wire, logical } = await wireName(b, readPeople(home, scope).sessions, n);
    // A favourite is always shown, so it is not hidden (as the Favourite button in Telegram).
    const alias = await changePeople(ps, (sessions, entry) => bump(Object.assign(entry(wire), on ? { fav: true, hidden: false } : { fav: false }), cliOp()).alias ?? null);
    out(on ? `${fullName(logical, alias)} is now a favourite.` : `${fullName(logical, alias)} is no longer a favourite.`);
    return 0;
  }

  /** The relay's own list from a send-only sign-in (never the bridge's name), or null when it cannot be reached. */
  async function relayList(b) {
    let c = null;
    try {
      const e = await relayEntry(b.alias);
      c = (deps.clientFactory ?? ((o) => new RelayClient(o)))({ ...(await relayOptions(e)), name: `${b.wire}-cli`.slice(0, 64), mode: "send", reconnect: false, require2: true });
      await c.start().ready(10_000);
      if (!c.caps?.includes("list_own")) return null;
      const list = await c.list();
      return Array.isArray(list) ? list.filter((p) => p?.own === true && p.custody !== "hosted" && typeof p.name === "string") : null;
    } catch {
      return null;
    } finally {
      c?.close();
    }
  }

  async function aliasCmd() {
    const clear = flag("--clear");
    const ps = peopleScope();
    const { b, scope } = ps;
    const n = args.shift();
    const sessions = readPeople(home, scope).sessions;
    const { wire } = await wireName(b, sessions, n);
    if (clear) {
      done();
      await changePeople(ps, (s) => {
        if (Object.hasOwn(s, wire)) bump(Object.assign(s[wire], { alias: undefined, alias_host: undefined }), cliOp());
      });
      out(`The custom name for ${wire} has been removed.`);
      return 0;
    }
    const alias = args.join(" ");
    if (!alias) throw new CliError(USAGE, 2);
    const list = await relayList(b);
    if (!list) out("(Could not reach the relay; checked against this machine's list only.)");
    const prefix = await prefixOf(b);
    const display = (w) => (prefix && w.startsWith(prefix) && w.length > prefix.length ? w.slice(prefix.length) : w);
    const host = list?.find((p) => p.name === wire && p.online)?.host;
    // The rules are checked against people.json as read under the lock that writes the alias.
    await changePeople(ps, (s, entry) => {
      const problem = aliasProblemIn(alias, wire, s, (list ?? []).map((p) => p.name), display);
      if (problem) throw new PeopleRefusedError(problem);
      bump(Object.assign(entry(wire), { alias: normalAlias(alias), alias_host: typeof host === "string" && host ? host : undefined }), cliOp());
    });
    out(`${wire} is now shown as "${normalAlias(alias)}".`);
    return 0;
  }

  function sessionsCmd() {
    done();
    const { scope } = peopleScope();
    const sessions = readPeople(home, scope).sessions;
    const t = deps.now?.() ?? Date.now();
    const rows = Object.keys(sessions)
      .sort()
      .map((n) => {
        const e = sessions[n];
        return [n, ...(e.alias ? [`alias "${e.alias}"`] : []), ...(e.fav ? ["favourite"] : []), ...(e.hidden ? ["hidden"] : []), ...(e.last_talked ? [`last talked ${ago(t - e.last_talked)}`] : [])].join("  ");
      });
    if (!rows.length) out("No saved agents yet.");
    for (const r of rows) out(r);
    return 0;
  }

  // ---- run --------------------------------------------------------------------------------

  async function bridgeFor(b, extra = {}) {
    token = store(tokenAccount(b.bot_id)).read()?.token ?? null;
    if (!isBotToken(token)) throw new CliError("the bot token is missing from the credential store; run hoptell telegram setup (token on standard input)");
    const { cur } = loadKey(b);
    const e = await relayEntry(b.alias);
    if (wireOf(e, b.logical) !== b.wire) throw new CliError(`the relay entry ${b.alias} now gives the bridge another name; run hoptell telegram unpair --all and set up again`);
    // The app's initData key, derived from the token: the bridge never needs the token for it.
    return createBridge({ home, telegram: telegramFactory(token), relay: await relayOptions(e), alias: b.alias, appUrl: env.HOPTELL_APP_URL ?? null, namePrefix: e.namePrefix, name: b.wire, key: cur, botId: b.bot_id, appKey: appSecret(token), expectRealm: b.realm, expectMember: b.member ?? null, log: (...a) => err(redact(a.join(" "), token)), ...(deps.pollTimeout ? { pollTimeout: deps.pollTimeout } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}), ...extra });
  }

  // ---- app ------------------------------------------------------------------------------

  /** Whether the relay can serve the app (cap owner_app), from a send-only connection; null: unknown. */
  async function relayServesApp(b) {
    let c = null;
    try {
      const e = await relayEntry(b.alias);
      c = (deps.clientFactory ?? ((o) => new RelayClient(o)))({ ...(await relayOptions(e)), name: `${b.wire}-cli`.slice(0, 64), mode: "send", reconnect: false, require2: true });
      await c.start().ready(10_000);
      return Boolean(c.caps?.includes("owner_app"));
    } catch {
      return null;
    } finally {
      c?.close();
    }
  }

  async function appCmd() {
    const b = config();
    const what = ["--on", "--off", "--rotate", "--status"].filter((f) => flag(f));
    if (what.length !== 1 || args.length) throw new CliError(USAGE, 2);
    const t = deps.now?.() ?? Date.now();
    const relayUrl = (await relayEntry(b.alias)).url;
    const o = appOriginFor({ explicit: env.HOPTELL_APP_URL, relayUrl });
    // Where Telegram opens the app, as this command's environment says; a bridge run as a service
    // reads its own environment, which may differ.
    const where = () => {
      if (o.origin) return out(`With this command's environment, the app uses ${o.origin}.`);
      const why = o.invalid ?? `Telegram can't open the app at the relay's address: ${APP_ORIGIN_PROBLEMS[o.problem] ?? o.problem}`;
      out(wrap(`warning: ${why}. With this command's environment, the bot cannot show an app button. Set HOPTELL_APP_URL in the bridge's environment to the server's public HTTPS address, such as https://hoptell.example.com. A bridge running as a service may use a different environment.`));
    };
    if (what[0] === "--status") {
      let a = null;
      try {
        a = readState(home, b.bot_id).app ?? null;
      } catch {}
      out(!a ? "The app has never been turned on." : a.on ? "The app is on." : "The app is off.");
      if (a?.on) {
        where();
        if (o.origin) out(`Send /app in your chat with the bot to open it.`);
      }
      return 0;
    }
    if (what[0] === "--on") {
      const serves = await relayServesApp(b);
      if (serves === false) throw new CliError("the hoptell relay cannot serve the app yet: its operator must update it and set HOPTELL_OWNER_APP=on");
      if (serves === null) throw new CliError("the hoptell relay could not be reached, so its app support could not be checked: try again later");
    }
    const a = whileStopped(() => changeOwnerApp(home, b.bot_id, what[0].slice(2), t));
    if (what[0] === "--on") {
      out("The app is on. Start the bridge, then send /app in the chat.");
      where();
    }
    else if (what[0] === "--off") out(a ? "The app is off. Its links stop working when the bridge starts again." : "The app has never been turned on.");
    else out("The app has a new link. Old links stop working when the bridge starts again; send /app for the new one.");
    return 0;
  }

  async function run() {
    done();
    const b = config();
    const bridge = await bridgeFor(b);
    const stop = () => bridge.stop();
    if (deps.signals !== false) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    deps.onBridge?.(bridge);
    out(`hoptell telegram run: bridge ${b.alias}/${b.wire} for @${b.username}`);
    // This process lives until the bridge stops. While the relay is away nothing else holds the
    // event loop (the relay client's reconnect timers are unreferenced, and the poll ended with the
    // claim), so without this Node would end the process with code 13 (an unsettled top-level
    // await) instead of letting the bridge reconnect when the relay is back.
    const keepAlive = setInterval(() => {}, 60_000);
    let r;
    try {
      r = await bridge.start();
    } finally {
      clearInterval(keepAlive);
    }
    if (deps.signals !== false) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (r.code === "stopped") {
      out("Stopped.");
      return 0;
    }
    err(`hoptell telegram run: ${redact(r.message, token)}`);
    // Refused by the encryption policy: final until the owner changes it. A service manager should
    // not restart on this code (a restart would only connect and stop again).
    if (r.code === "encryption_required") {
      err(`hoptell telegram run: exit code ${EXIT_ENCRYPTION_REQUIRED}; a service manager should not restart the bridge on this code`);
      return EXIT_ENCRYPTION_REQUIRED;
    }
    return 1;
  }

  // ---- status -----------------------------------------------------------------------------

  function status() {
    done();
    const b = readBridgeConfig(home);
    if (b) {
      out(`bridge: ${b.alias}/${b.wire} for bot @${b.username}; ${runState(home)}`);
      out(`pin: ${pinOf(b, b.key.pub)}`);
      if (b.next) out(`next key staged: ${b.next.id} (pin ${pinOf(b, b.next.pub)})`);
    }
    for (const [realm, e] of Object.entries(sig.readTrusted(home).realms)) out(`trusted: ${e.name} on realm ${realm}, key ids ${e.keys.map((k) => k.id).join(", ")}`);
    const ownerChannel = envOwnerChannel(env);
    const marks = deps.marks ?? false;
    if (ownerChannel.warning) out(`${statusMark("warn", marks)}warn  settings: ${ownerChannel.warning}`);
    for (const l of statusLines(home, { ownerChannel: ownerChannel.value })) out(`${statusMark(l.level, marks)}${l.level.padEnd(4)}  ${l.what}: ${l.detail}`);
    return 0;
  }

  // ---- unpair -----------------------------------------------------------------------------

  /**
   * Remove the chat-scoped command menu (it lists agent names) of each chat, honouring
   * retry_after, for up to `ms`. Returns the chats Telegram did not confirm and why (redacted);
   * a refusal (400, 403) is not a confirmation either.
   */
  async function deleteMenus(b, chats, ms) {
    chats = [...new Set(chats.filter(Number.isSafeInteger))];
    if (!b || !chats.length) return { left: [], why: null };
    let api;
    try {
      token = store(tokenAccount(b.bot_id)).read()?.token ?? null;
      if (!isBotToken(token)) return { left: chats, why: "the bot token is missing from the credential store" };
      api = telegramFactory(token);
    } catch (e) {
      return { left: chats, why: redact(e.message, token) };
    }
    if (typeof api.deleteMyCommands !== "function") return { left: chats, why: "this client cannot delete the menu" };
    const end = Date.now() + ms;
    const left = [];
    let why = null;
    for (const chat of chats) {
      for (;;) {
        try {
          await api.deleteMyCommands({ scope: { type: "chat", chat_id: chat } });
          break;
        } catch (e) {
          const wait = Number.isFinite(e?.retryAfter) && e.retryAfter > 0 ? e.retryAfter * 1000 : 1000;
          if (e?.status === 400 || e?.status === 403 || Date.now() + wait > end) {
            left.push(chat);
            why = redact(e?.message ?? String(e), token);
            break;
          }
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    return { left, why };
  }
  function menuNote(why) {
    return `note: the command menu in your Telegram chat could not be removed (${why}); it lists your agents' names. The next run of this bot on this home tries again; you can also delete the bot chat in Telegram.`;
  }

  async function unpair() {
    const all = flag("--all");
    done();
    const p = sig.channelPaths(home);
    if (!all) {
      const chat = readPairing(home)?.paired?.chat_id;
      if (!chat) {
        out("Not paired.");
        return 0;
      }
      fs.rmSync(p.pairing, { force: true });
      audit(home, "unpaired", {}, deps.now?.() ?? Date.now());
      out("Unpaired: the bot no longer accepts anyone until hoptell telegram pair.");
      // One try now; the bridge keeps the chat in its state and retries until Telegram confirms.
      let b = null;
      try {
        b = readBridgeConfig(home);
      } catch {}
      const { left, why } = await deleteMenus(b, [chat], 0);
      if (left.length) err(`note: the command menu in your Telegram chat could not be removed yet (${why}); the bridge tries again when it runs.`);
      return 0;
    }
    // This home's run lock is held from the check through the drain and the cleanup, so no run
    // can start in between and nothing is removed under a running bridge.
    sig.ensureChannelDir(home);
    const lock = tryLock(p.lock);
    if (typeof lock !== "function") throw new CliError(`the bridge is running (pid ${lock.pid}); stop it first`);
    const untrusted = [];
    let untrustedRealm = null;
    let menuLeft = null;
    try {
      const b = readBridgeConfig(home);
      // The chats whose menu this channel may have set: the pairing's, and those its state keeps.
      const menuChats = [readPairing(home)?.paired?.chat_id];
      try {
        const st = sig.readPrivateJson(p.state, 16 * 1024 * 1024);
        menuChats.push(st?.menu?.chat, ...(Array.isArray(st?.menu?.delete) ? st.menu.delete : []));
      } catch {}
      if (b) {
        // Open questions are answered `cancelled` first.
        const bridge = await bridgeFor(b);
        await deps.beforeDrain?.(); // tests: another command acts here, while the lock is held
        const r = await bridge.start({ drain: true, drainMs: deps.drainMs ?? 15_000, heldLock: lock });
        if (r.code !== "stopped") throw new CliError(`the owner channel was not reset: ${r.message}`);
        if (r.message) err(`note: ${r.message}; those questions expire at their agents instead`);
        // Before the token goes: delete the menus; what Telegram does not confirm is kept for the
        // next run of this bot (menu-cleanup.json survives this reset), and the owner is told.
        const { left, why } = await deleteMenus(b, menuChats, deps.menuDeleteMs ?? 15_000);
        if (left.length) {
          keepMenuCleanup(home, b.bot_id, left);
          menuLeft = why;
        }
        for (const account of [tokenAccount(b.bot_id), keyAccount(b.bot_id)]) {
          try {
            store(account).remove();
          } catch (e) {
            err(`note: ${account} could not be removed from the credential store (${e.message})`);
          }
        }
      }
      for (const f of [p.pairing, p.state, p.bridge, path.join(p.dir, "run.json")]) if (fs.existsSync(f)) removeDurable(f);
      await removePeople(home); // favourites, names and hidden agents go too (plain unpair keeps them)
      // This home's own agents trusted the deleted keys (setup and key next pin them): that
      // trust goes too, so nothing here accepts or offers the old channel. Only this channel's
      // entry (its realm and bridge name) is changed; the same key pinned elsewhere stays.
      if (b) {
        const ids = [b.key.id, b.next?.id].filter(Boolean);
        let readable = false;
        try {
          sig.readTrusted(home);
          readable = true;
          untrusted.push(...sig.removeChannelKeys(home, b.realm, b.wire, ids));
          untrustedRealm = b.realm;
          if (untrusted.length) audit(home, "trusted", { realm: b.realm, removed: untrusted }, deps.now?.() ?? Date.now());
        } catch (e) {
          if (!readable) err(`note: the trust file ${p.trusted} could not be read (${e.message}), so this hoptell home may still trust the old owner-channel signing ${ids.length === 1 ? "key" : "keys"}: ${ids.join(", ")}. Fix or remove that file.`);
          else err(`note: the old owner-channel signing ${ids.length === 1 ? "key" : "keys"} could not be untrusted (${e.message}). Only if this home's trust entry for realm ${b.realm} still names ${b.wire}, run: ${ids.map((id) => `hoptell telegram trust --remove-key ${id} --realm ${b.realm}`).join("; ")}`);
        }
      }
    } finally {
      lock();
    }
    audit(home, "unpaired", { all: true }, deps.now?.() ?? Date.now());
    out("The owner channel of this home was reset: pairing, state and open questions are cleared.");
    if (menuLeft) err(menuNote(menuLeft));
    if (untrusted.length) out(`Removed the old owner channel's signing ${untrusted.length === 1 ? "key" : "keys"} from this home's trust entry for realm ${untrustedRealm}: ${untrusted.join(", ")}.`);
    out("Pins on other machines name the old key; replace them after a new setup.");
    return 0;
  }
}

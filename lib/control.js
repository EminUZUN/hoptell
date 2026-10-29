// The injector's control connection (design 9, C, with the v2 correction 1). `hoptell inject` tells
// the owner's bridge that its session waits (lib/waits.js) through a connection of its own: the
// session's MCP server may not run at all then (Codex asks for folder trust before it starts it).
// It sends with the member's own credential, by name to the pinned bridge, for the own member only,
// through the same send guard as `hoptell send` (lib/ownersig.js).
//
// It is a receiving peer that holds its name's lease (a send-only hello proves no ownership of a
// name): the owner's answer to a prompt card comes back to it (lib/promptcards.js), and only the
// session holding the name gets it. Its hello carries the role CONTROL_ROLE, so the owner's bridge
// never lists it among the owner's agents.
//
// Its name is the authenticated member's name, intact, with "-c<random>" after it, within 64
// characters. It is chosen once per session, kept in sessions/<name>.control.json, and asked for
// without replace; a name the relay refuses is drawn again, at most CONTROL_TRIES times, then the
// session's notes stay local. A member name of 63 or 64 characters leaves no room: no connection.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTROL_ROLE, NAME_RE, checkName, ensurePrivateDir } from "./config.js";
import { writeRecord } from "./locks.js";
import { ownerChannelNameFor, ownerPolicyCheck, ownerSendGuard } from "./ownersig.js";

export const CONTROL_TRIES = 5;
export { CONTROL_ROLE };
const SUFFIX = 10; // "-c" and up to this many random characters
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const controlFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.control.json`);

/** A new control name for member `member` ("me" → "me-c4k7q2xm3a"), or null when no room is left. */
export function drawControlName(member, bytes = crypto.randomBytes) {
  const room = Math.min(SUFFIX, 64 - String(member).length - 2);
  if (!NAME_RE.test(String(member)) || room < 1) return null;
  const b = bytes(room);
  return `${member}-c${[...b].map((x) => ALPHABET[x % 32]).join("")}`;
}
const isControlOf = (name, member) => typeof name === "string" && NAME_RE.test(name) && name.startsWith(`${member}-c`) && name.length > member.length + 2;

/** The control name kept for session `name` of member `member`, or null. */
export function readControlName(home, name, member) {
  try {
    const r = JSON.parse(fs.readFileSync(controlFileOf(home, name), "utf8"));
    return r && r.v === 1 && r.member === member && isControlOf(r.name, member) ? r.name : null;
  } catch {
    return null;
  }
}

/**
 * The control connection of session `name`: {note(text) to the owner's bridge, tell(to, text) to a
 * session of the own member (a team's lead), each true when the relay took it; whoami() (connects
 * first: {name, member, realm} of the control connection, or null); close()}.
 * `client({name, mode, reconnect, roles, waitWhenReplaced})` makes a RelayClient with the session's
 * settings (the CLI's connect); `policy()` is the contacts' current policy; `onMessage(m, confirm,
 * me)` gets what arrives for the control name, with the receiving connection's {name, member,
 * realm} (by default it is confirmed and dropped); `onReady()` runs each time a control connection
 * is ready: a new one (also under a name drawn again) and after each reconnect.
 * Connected on first use: first with an automatic name, only to learn the authenticated member,
 * then under the control name as a receiving peer that holds it, never replacing anyone (a name in
 * use is drawn again). Never throws; problems are said once through `log` and leave notes local.
 */
export function createControl({ home, name, client, policy, onMessage = (m, confirm) => confirm(), onReady = () => {}, log = () => {}, tries = CONTROL_TRIES }) {
  let conn = null;
  let connecting = null; // the one connect in progress: note and tell share it
  let closed = false;
  let gaveUp = null;
  let said = null;
  const live = new Set(); // every connection made and not closed yet, so close() reaches them all
  const say = (why) => {
    if (why !== said) log(`owner notes about this session are not sent: ${why}`);
    said = why;
  };
  const drop = (c) => {
    live.delete(c);
    c.close();
  };
  const stopped = () => Object.assign(new Error("the control connection is closed"), { final: true });
  const who = (c) => ({ name: c.name, member: c.member ?? null, realm: c.realm ?? null });
  async function open(n) {
    if (closed) throw stopped();
    const c = n === null ? client({ name: null, mode: "send", reconnect: false }) : client({ name: n, mode: "peer", reconnect: true, roles: [CONTROL_ROLE], waitWhenReplaced: false });
    live.add(c);
    c.on("fatal", () => {
      // A refusal while connecting is seen through ready(); one later ends this connection: the
      // next use connects again (under the kept name first).
      if (conn === c) {
        conn = null;
        drop(c);
      }
    });
    if (n !== null) {
      c.on("message", (m, confirm) => onMessage(m, confirm, who(c)));
      c.on("ready", () => {
        // A reconnect of the kept connection (its first ready is the connect: told above).
        if (conn === c) Promise.resolve(onReady()).catch(() => {});
      });
    }
    c.start();
    try {
      await c.ready(15_000);
    } catch (e) {
      drop(c);
      throw e;
    }
    if (closed) {
      drop(c);
      throw stopped();
    }
    return c;
  }
  async function connect() {
    const probe = await open(null);
    const member = probe.member?.name ?? null;
    drop(probe);
    if (!member) throw Object.assign(new Error("this credential has no member name"), { final: true });
    let n = readControlName(home, name, member);
    for (let i = 0; i < tries; i++) {
      n ??= drawControlName(member);
      if (!n) throw Object.assign(new Error(`the member name ${member} leaves no room for a control name`), { final: true });
      let c = null;
      try {
        c = await open(n);
        ensurePrivateDir(path.dirname(controlFileOf(home, name)));
        writeRecord(controlFileOf(home, name), { v: 1, member, name: n });
        return c;
      } catch (e) {
        if (c) drop(c); // given but not kept: never left open behind the next draw
        if (e.final) throw e;
        log(`the control name ${n} was not given (${e.message}); drawing another`);
        n = null;
      }
    }
    throw Object.assign(new Error(`no control name after ${tries} tries`), { final: true });
  }
  /** The control connection: the one open, or the one connect in progress (single flight). */
  function connection() {
    if (closed) return Promise.reject(stopped());
    if (conn) return Promise.resolve(conn); // connected, or reconnecting by itself
    connecting ??= connect().then(
      (c) => {
        connecting = null;
        conn = c;
        Promise.resolve(onReady()).catch(() => {}); // a new connection (also one under a name drawn again)
        return c;
      },
      (e) => {
        connecting = null;
        throw e;
      },
    );
    return connecting;
  }
  return {
    async note(text) {
      if (gaveUp || closed) return false;
      try {
        const c = await connection();
        const bridge = ownerChannelNameFor(home, c);
        if (!bridge) {
          say("this realm has no trusted owner channel");
          return false;
        }
        const guard = ownerSendGuard({ home, client: c, to: bridge, policy });
        await c.send(bridge, text, 3600, undefined, { toMember: guard.toMember });
        said = null;
        return true;
      } catch (e) {
        if (closed) return false;
        if (e.final) gaveUp = e.message;
        say(e.message);
        return false;
      }
    },
    /** The control connection's {name, member, realm} once connected, or null. */
    async whoami() {
      if (gaveUp || closed) return null;
      try {
        return who(await connection());
      } catch (e) {
        if (closed) return null;
        if (e.final) gaveUp = e.message;
        say(e.message);
        return null;
      }
    },
    async tell(to, text) {
      if (gaveUp || closed) return false;
      try {
        const c = await connection();
        // Plaintext to the own member, as a note to the bridge: refused when its policy requires encryption.
        ownerPolicyCheck({ policy, realm: c.realm?.id, member: c.member?.id });
        await c.send(to, text, 3600, undefined, { toMember: c.member.id });
        return true;
      } catch (e) {
        if (closed) return false;
        if (e.final) gaveUp = e.message;
        log(`the lead was not told: ${e.message}`);
        return false;
      }
    },
    /** Close every connection, also one still connecting; later notes are not sent. */
    close() {
      closed = true;
      for (const c of [...live]) drop(c);
      conn = null;
    },
  };
}

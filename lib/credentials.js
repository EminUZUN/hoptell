// Stored sign-in credentials of a relay profile (design 1.6): refresh tokens and broker session
// credentials in the OS keychain (macOS `security`, Linux Secret Service via `secret-tool`), or,
// only when the user chooses it, an encrypted file. Secrets never appear in process arguments:
// they go through standard input. Access tokens are not stored (memory only).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensurePrivateDir } from "./config.js";

const SERVICE = "hoptell";
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Run a command with input on stdin; returns {status, stdout}. Injectable for tests. */
const defaultRun = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Write a file durably or fail: the data and the folder entry are synced, and any failure is
 * reported (a credential must never look saved when it is not). A failure carries `phase`:
 * "before-replace" (the file is unchanged) or "after-replace" (the new content is in place, its
 * durability unknown). `fault(point, file)` is for tests.
 */
export function writeDurable(file, text, { fault = null } = {}) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      const buf = Buffer.from(text, "utf8");
      for (let off = 0; off < buf.length; ) {
        const n = fs.writeSync(fd, buf, off, buf.length - off); // a short write continues
        if (!(n > 0)) throw Object.assign(new Error(`writing ${file} made no progress`), { code: "EIO" });
        off += n;
      }
      fault?.("file-fsync", file);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fault?.("rename", file);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw Object.assign(e, { phase: "before-replace" });
  }
  if (process.platform === "win32") return; // a directory cannot be synced there
  try {
    const d = fs.openSync(path.dirname(file), "r");
    try {
      fault?.("dir-fsync", path.dirname(file));
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } catch (e) {
    throw Object.assign(e, { phase: "after-replace" });
  }
}

/** Remove a file and sync its folder, or fail (a removal must be durable before it is reported). */
export function removeDurable(file) {
  fs.rmSync(file, { force: true });
  if (process.platform === "win32" || !fs.existsSync(path.dirname(file))) return;
  const d = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
}

/** The keychain backend of this platform, or null when there is none. */
export function keychain({ platform = process.platform, run = defaultRun, service = SERVICE } = {}) {
  if (platform === "darwin") {
    // `security -i` reads its commands from stdin, so the secret is not in any argument list.
    const b64 = (s) => Buffer.from(s).toString("base64");
    return {
      kind: "macOS keychain",
      available: () => run("security", ["help"], "").status !== -1,
      set: (account, value) => run("security", ["-i"], `add-generic-password -U -s ${service} -a ${account} -w ${b64(value)}\n`).status === 0,
      get: (account) => {
        const r = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], "");
        if (r.status === 0) return Buffer.from(r.stdout.trim(), "base64").toString();
        if (r.status === 44) return null; // errSecItemNotFound: not stored
        throw new Error(`the macOS keychain could not be read (locked or unavailable, status ${r.status})`);
      },
      remove: (account) => run("security", ["delete-generic-password", "-s", service, "-a", account], "").status === 0,
    };
  }
  if (platform === "linux") {
    return {
      kind: "Secret Service",
      available: () => run("secret-tool", ["--version"], "").status === 0,
      set: (account, value) => run("secret-tool", ["store", `--label=hoptell ${account}`, "service", service, "account", account], value).status === 0,
      get: (account) => {
        const r = run("secret-tool", ["lookup", "service", service, "account", account], "");
        if (r.status === 0 && r.stdout) return r.stdout;
        if (r.status === 1 && !String(r.stderr ?? "").trim()) return null; // no such item
        throw new Error(`the Secret Service could not be read (locked or unavailable${r.stderr ? `: ${String(r.stderr).trim().split("\n")[0].slice(0, 120)}` : `, status ${r.status}`})`);
      },
      remove: (account) => run("secret-tool", ["clear", "service", service, "account", account], "").status === 0,
    };
  }
  return null;
}

/** An encrypted credentials file: AES-256-GCM, key from scrypt over a passphrase. */
export function encryptedFile(home, { passphrase, fault = null }) {
  if (!passphrase || passphrase.length < 12) throw new Error("HOPTELL_CREDENTIAL_PASSPHRASE must be set (at least 12 characters) to keep credentials in an encrypted file");
  const dir = () => ensurePrivateDir(path.join(ensurePrivateDir(home), "credentials"));
  const fileOf = (account) => path.join(dir(), `${account}.json`);
  const keyOf = (salt) => crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return {
    kind: "encrypted file",
    available: () => true,
    set(account, value) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", keyOf(salt), iv);
      c.setAAD(Buffer.from(`hoptell:${account}`));
      const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
      writeDurable(fileOf(account), `${JSON.stringify({ v: 1, kdf: "scrypt", N: 1 << 15, r: 8, p: 1, cipher: "aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") })}\n`, { fault });
      return true;
    },
    get(account) {
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(fileOf(account), "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw new Error(`the credentials file for ${account} cannot be read`);
      }
      // Only the fixed format is accepted, checked before any key derivation runs.
      const len = (b64, n) => typeof b64 === "string" && Buffer.from(b64, "base64").length === n;
      if (rec?.v !== 1 || rec.kdf !== "scrypt" || rec.N !== 1 << 15 || rec.r !== 8 || rec.p !== 1 || rec.cipher !== "aes-256-gcm" || !len(rec.salt, 16) || !len(rec.iv, 12) || !len(rec.tag, 16) || typeof rec.data !== "string") {
        throw new Error(`the credentials file for ${account} has an unknown format`);
      }
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", keyOf(Buffer.from(rec.salt, "base64")), Buffer.from(rec.iv, "base64"));
        d.setAAD(Buffer.from(`hoptell:${account}`));
        d.setAuthTag(Buffer.from(rec.tag, "base64"));
        return Buffer.concat([d.update(Buffer.from(rec.data, "base64")), d.final()]).toString("utf8");
      } catch {
        throw new Error(`the credentials file for ${account} cannot be decrypted (wrong HOPTELL_CREDENTIAL_PASSPHRASE, or the file changed)`);
      }
    },
    remove(account) {
      removeDurable(fileOf(account));
      return true;
    },
  };
}

/**
 * The credential store for relay profile `account`: the keychain, or the encrypted file when the
 * user chose it (`store: "file"`) or it already holds this profile. Values are JSON objects.
 */
export function credentialStore(home, account, { store = "auto", passphrase = null, keychainBackend = keychain(), fault = null } = {}) {
  if (!ACCOUNT_RE.test(account)) throw new Error("invalid relay profile name");
  const fileBackend = () => encryptedFile(home, { passphrase, fault });
  const existingFile = fs.existsSync(path.join(home, "credentials", `${account}.json`));
  let backend;
  // "keychain" and "file" name a concrete backend (what a sign-in record stores); "auto" (a new
  // sign-in without a choice, or an older record) prefers an existing file, else the keychain.
  if (store === "file" || (store === "auto" && existingFile)) backend = fileBackend();
  else if (keychainBackend?.available()) backend = keychainBackend;
  else throw new Error("no OS keychain is available here; run hoptell login --store file with HOPTELL_CREDENTIAL_PASSPHRASE set, or use a member token");
  return {
    kind: backend.kind,
    read() {
      const v = backend.get(account);
      return v ? JSON.parse(v) : null;
    },
    write(obj) {
      if (!backend.set(account, JSON.stringify(obj))) throw new Error(`the credential could not be saved in the ${backend.kind}`);
    },
    /** Remove it; throws when it is still there afterwards (a locked keychain, a failed delete). */
    remove() {
      if (backend.remove(account)) return;
      if (backend.get(account) !== null) throw new Error(`the credential could not be removed from the ${backend.kind}`);
    },
  };
}

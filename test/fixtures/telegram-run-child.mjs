// `hoptell telegram run` in a process of its own, as bin/hoptell.js runs it (a top-level await on
// telegramCommand), with a stand-in Bot API: tests of the bridge process's lifetime.
//   node telegram-run-child.mjs <home> <relays file>   (ME_TOKEN: the member token)
// The stand-in's getUpdates holds a referenced timer while it waits, as a real fetch holds its
// socket, and ends at once on abort; every other method succeeds. Nothing leaves 127.0.0.1.
import { telegramCommand } from "../../lib/ownerchannelcli.js";
import { BOT_ID, BOT_TOKEN, paired } from "../owner-helpers.js";

const [home, relays] = process.argv.slice(2);
const env = { HOPTELL_RELAYS: relays, ME_TOKEN: process.env.ME_TOKEN, HOPTELL_HOME: home };
const items = new Map();
const keychainBackend = { kind: "test keychain", available: () => true, set: (a, v) => (items.set(a, v), true), get: (a) => items.get(a) ?? null, remove: (a) => items.delete(a) };
let nextMessage = 100;
const api = {
  getMe: async () => ({ id: Number(BOT_ID), is_bot: true, username: "owner_test_bot" }),
  getWebhookInfo: async () => ({ url: "" }),
  getUpdates: ({ timeout = 1, signal = null } = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([]), timeout * 1000);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(Object.assign(new Error("aborted"), { aborted: true }))), { once: true });
    }),
};
const telegram = new Proxy(api, { get: (o, k) => o[k] ?? (async () => (k === "sendMessage" ? { message_id: nextMessage++ } : true)) });
const deps = { home, env, homedir: home, telegramFactory: () => telegram, keychainBackend, pollTimeout: 1 };

if ((await telegramCommand(["setup"], { ...deps, stdin: BOT_TOKEN })) !== 0) process.exit(70);
paired(home);
process.exitCode = await telegramCommand(["run"], deps);

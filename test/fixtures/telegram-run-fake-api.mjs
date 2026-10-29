// `hoptell telegram run` in a process of its own, as bin/hoptell.js runs it (a top-level await on
// telegramCommand), on the fake Bot API of the owner channel tests (test/owner-helpers.js
// fakeTelegram), for end-to-end tests that drive it from the parent process over IPC:
//   node telegram-run-fake-api.mjs <home> <relays file>
//   (ME_TOKEN: the member token; HOPTELL_CREDENTIAL_PASSPHRASE: the file store's passphrase)
// It sets the bridge up with the file credential store, pairs it, sends {pin} (the line `hoptell
// telegram trust` takes), then every Bot API call as {sent: [...]} as it happens, and presses a
// button on {press: {message_id, index}}. Nothing leaves 127.0.0.1.
import { telegramCommand } from "../../lib/ownerchannelcli.js";
import { BOT_TOKEN, fakeTelegram, paired } from "../owner-helpers.js";

const [home, relays] = process.argv.slice(2);
const env = { HOPTELL_RELAYS: relays, ME_TOKEN: process.env.ME_TOKEN, HOPTELL_HOME: home, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: process.env.HOPTELL_CREDENTIAL_PASSPHRASE };
const tg = fakeTelegram();
const lines = [];
const deps = { home, env, homedir: home, telegramFactory: () => tg.client(), pollTimeout: 1, out: (s) => (lines.push(s), console.log(s)) };

if ((await telegramCommand(["setup"], { ...deps, stdin: BOT_TOKEN })) !== 0) process.exit(70);
paired(home);
const pin = lines.map((l) => /hoptell telegram trust '([^']+)'/.exec(l)?.[1]).find(Boolean);
if (!pin) process.exit(71);
process.send({ pin });
let told = 0;
const tell = setInterval(() => {
  if (tg.sent.length > told) process.send({ sent: tg.sent.slice(told) });
  told = tg.sent.length;
}, 50);
process.on("message", (m) => {
  if (!m?.press) return;
  const card = tg.sent.find((s) => s.message_id === m.press.message_id);
  if (card) tg.press(card, m.press.index);
});
process.on("disconnect", () => process.kill(process.pid, "SIGTERM"));
process.exitCode = await telegramCommand(["run"], deps);
clearInterval(tell);
process.disconnect?.();

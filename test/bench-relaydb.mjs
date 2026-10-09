// The cost of one durable relay transaction (design 3.3: whether the relay needs a worker thread is
// decided by measurement). Not part of npm test. Run: node test/bench-relaydb.mjs [count] [dir]
// `dir` should be on the disk the relay's state directory uses (the default is the temp folder).
// Each transaction inserts one row of a few hundred bytes and updates a counter, like a queued
// message; it is measured with fullfsync on (the relay's setting) and off (fsync only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";

const count = Number(process.argv[2] ?? 1000);
const base = process.argv[3] ?? os.tmpdir();
const migrations = ["CREATE TABLE queue (id INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT; CREATE TABLE totals (k TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT; INSERT INTO totals VALUES ('queued', 0)"];
const body = Buffer.alloc(400, 7);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const ms = (ns) => (Number(ns) / 1e6).toFixed(3);

for (const fullfsync of [true, false]) {
  const dir = fs.mkdtempSync(path.join(base, "hoptell-bench-"));
  fs.chmodSync(dir, 0o700);
  const release = lockStateDir(dir);
  try {
    const db = openRelayDb({ dir, migrations, fullfsync });
    const times = [];
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) {
      const t0 = process.hrtime.bigint();
      db.tx((h) => {
        h.run("INSERT INTO queue (body) VALUES (?)", body);
        h.run("UPDATE totals SET n = n + 1 WHERE k = 'queued'");
      });
      times.push(process.hrtime.bigint() - t0);
    }
    const total = process.hrtime.bigint() - start;
    db.close();
    times.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    console.log(
      `fullfsync ${fullfsync ? "on " : "off"}: ${count} transactions, median ${ms(pct(times, 50))} ms, p90 ${ms(pct(times, 90))} ms, p99 ${ms(pct(times, 99))} ms, max ${ms(times.at(-1))} ms, ${Math.round(count / (Number(total) / 1e9))} per second`,
    );
  } finally {
    release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`node ${process.version}, ${process.platform} ${os.release()}, ${base}`);

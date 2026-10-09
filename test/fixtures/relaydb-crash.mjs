// A relay that dies at a transaction boundary (test/relaydb.test.js): it commits row "a", then
// writes row "b" and is killed (SIGKILL: no rollback, no close) at fault point `point`.
import { lockStateDir } from "../../lib/realm.js";
import { openRelayDb } from "../../lib/relaydb.js";

const [dir, point] = process.argv.slice(2);
lockStateDir(dir);
const migrations = ["CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT"];
let armed = false; // the migrations and row "a" commit normally
const db = openRelayDb({ dir, migrations, fault: (p) => armed && p === point && process.kill(process.pid, "SIGKILL") });
db.tx((h) => h.run("INSERT INTO items (id, body) VALUES ('a', 'first')"));
armed = true;
db.tx((h) => {
  h.run("INSERT INTO items (id, body) VALUES ('b', 'second')");
  h.run("UPDATE items SET body = 'changed' WHERE id = 'a'");
});
process.stdout.write("survived\n");

// Imported first by tests that scan owner-visible texts: the computer's real name is the user's
// data, not hoptell's wording, and a name such as "hoptell-relay" would trip the banned-word scan.
// This module runs before lib/config.js reads the name (HOSTNAME), so every session of the test
// reports "testhost". Each test file runs in a process of its own.
import os from "node:os";

os.hostname = () => "testhost";

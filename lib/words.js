// Small wording helpers for terminal output: counted nouns, and Node error codes in words.

/** "1 message", "3 messages"; `many` for an irregular plural ("entry", "entries"). */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ERRNO = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "a part of the path is not a directory",
  EEXIST: "it already exists",
};

/** A Node file-system error's cause in words ("permission denied"), else its message. */
export const errnoWords = (e) => ERRNO[e?.code] ?? e?.message ?? String(e);

/**
 * Terminal text in lines of at most `width` columns: each sentence starts a line, and a long
 * sentence wraps between words (a word, id or URL is never split, so a longer one stays whole).
 */
export function wrap(text, width = 78) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    const indent = /^ */.exec(para)[0];
    for (const sentence of para.slice(indent.length).split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      let line = indent;
      for (const word of sentence.split(/\s+/).filter(Boolean)) {
        if (line.length > indent.length && line.length + 1 + word.length > width) {
          lines.push(line);
          line = indent;
        }
        line += line.length > indent.length ? ` ${word}` : word;
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// Status marks on a terminal: symbol and ANSI colour per level, before the level's word.
const MARKS = { ok: ["✓", 32], info: ["·", 2], warn: ["⚠", 33], FAIL: ["✗", 31] };

/** Whether `stream` is a terminal that takes colour: a TTY, NO_COLOR unset or empty, TERM not "dumb". */
export const terminalMarks = (stream, env) => Boolean(stream?.isTTY) && !env.NO_COLOR && env.TERM !== "dumb";

/** The coloured symbol and a space for `level` when `marks` is on, else "" (the word stays as it is). */
export const statusMark = (level, marks) => (marks && MARKS[level] ? `\x1b[${MARKS[level][1]}m${MARKS[level][0]}\x1b[0m ` : "");

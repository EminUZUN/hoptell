#!/usr/bin/env bash
# Run the plugin eval suites (evals/) with `claude plugin eval`. These are real, billed model runs
# on your own Claude credential, so they are not part of `npm test`.
#
#   test/skill-evals/run-evals.sh [extra claude plugin eval options, e.g. --case 'hoptell-safe-ops/*' --runs 1]
#
# Safety: the hoptell MCP server is never started (every tool is a mock in evals/mocks/), and Bash
# is granted only for read-only commands and `hoptell snapshot`. Any other command the agent tries
# (hoptell tmux, tmux kill-session, pkill, git push, ...) is denied, but stays in the trace, where
# the graders see it. The report is kept local (--no-publish).
set -euo pipefail
cd "$(dirname "$0")/../.."
# One run at a time: the scaffold scripts read evals/.staged-cli, so a second run must not replace
# the first one's copy. The lock is the directory evals/.run-lock, taken with one atomic mkdir
# before anything else; a run that cannot create it stops, even when the lock looks stale, and
# only the run that created it removes it (from its exit trap).
lock=evals/.run-lock
if ! mkdir "$lock" 2>/dev/null; then
  other=$(cat "$lock/pid" 2>/dev/null || true)
  echo "run-evals: $lock exists${other:+ (PID $other)}: another eval run is using evals/.staged-cli." >&2
  echo "Wait for it to finish. If no run is active, remove $lock by hand and try again." >&2
  exit 1
fi
cli=
cleanup() {
  if [ -n "$cli" ]; then
    rm -rf "$cli"
    if [ "$(cat evals/.staged-cli 2>/dev/null)" = "$cli" ]; then rm -f evals/.staged-cli; fi
  fi
  rm -rf "$lock"
}
trap cleanup EXIT
echo $$ > "$lock/pid"
node test/skill-evals/render-commands.mjs
# Bash inside a run is OS-sandboxed: it reads only the run's workspace, so a `hoptell` installed in
# your home folder does not run there. The cases' scaffold scripts copy this staged CLI (the
# checkout's bin/ and lib/, with the one package `hoptell snapshot` needs) into the workspace as
# .hoptell-cli/; the mocked tool descriptions name it as the snapshot command. A fresh folder per
# run, named in evals/.staged-cli for the scaffold scripts (they fail when it is missing).
cli=$(mktemp -d "${TMPDIR:-/tmp}/hoptell-eval-cli.XXXXXX")
mkdir -p "$cli/node_modules"
cp -R bin lib presets schema templates package.json "$cli/"
cp -RL node_modules/ws "$cli/node_modules/"
echo "$cli" > evals/.staged-cli
env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR claude plugin eval . \
  --no-publish --trust-plugin --scaffold \
  --allow-tools "Bash(hoptell snapshot:*)" "Bash(node .hoptell-cli/bin/hoptell.js snapshot:*)" "Bash('node' '.hoptell-cli/bin/hoptell.js' snapshot:*)" "Bash(pwd)" "Bash(ls:*)" "Bash(cat:*)" "Bash(which:*)" "Bash(command -v:*)" "Bash(echo:*)" "Edit" \
  "$@"

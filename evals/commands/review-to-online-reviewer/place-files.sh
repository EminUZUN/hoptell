#!/usr/bin/env bash
# The case files, and the CLI copy that run-evals.sh stages (Bash in a run reads only the workspace).
set -eu
# claude plugin eval runs this with its own environment, so run-evals.sh names its staged copy
# in evals/.staged-cli (one run at a time holds evals/.run-lock).
pointer="$(cd "$(dirname "$0")/../.." && pwd)/.staged-cli"
cli=$(cat "$pointer" 2>/dev/null) || { echo "no staged CLI: run the evals through test/skill-evals/run-evals.sh" >&2; exit 1; }
[ -f "$cli/bin/hoptell.js" ] || { echo "the staged CLI $cli is missing" >&2; exit 1; }
cp -R "$(dirname "$0")/files/." .
cp -R "$cli" ./.hoptell-cli

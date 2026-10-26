#!/usr/bin/env bash
# Trigger accuracy of the three skill descriptions, with skill-creator's run_eval.py: each query in
# test/skill-evals/triggers/<skill>.json runs through `claude -p` several times, and the script
# records whether Claude chose the skill. Real, billed model runs; not part of `npm test`.
#
#   SKILL_CREATOR=<path to the skill-creator skill> test/skill-evals/run-triggers.sh <out-dir> [runs-per-query] [model]
#
# ONLY="hoptell-safe-ops" limits the run to the named skills. Queries run one at a time:
# run_eval.py puts each query's stand-in skill into one shared project, so parallel queries would
# see each other's stand-ins.
#
# Isolation: claude runs from a temporary project through a wrapper that loads no user settings
# (so no installed plugins, hooks or MCP servers) and points every hoptell setting at a dead
# local port, so nothing can reach a real relay. The other two hoptell skills are present as
# competing entries with their current descriptions, as they are in a real session.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mkdir -p "$1" && cd "$1" && pwd)"
runs="${2:-3}"
model="${3:-}"
: "${SKILL_CREATOR:?set SKILL_CREATOR to the skill-creator skill folder (it holds scripts/run_eval.py)}"
real="$(command -v claude)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/xdg" "$work/project/.claude/commands"
: > "$work/empty.env"
cat > "$work/bin/claude" <<EOF
#!/bin/sh
export HOPTELL_ENV="$work/empty.env" HOPTELL_HOME="$work/home" XDG_CONFIG_HOME="$work/xdg" HOPTELL_RELAY=ws://127.0.0.1:9 HOPTELL_TOKEN=none
exec "$real" --setting-sources project,local --strict-mcp-config "\$@"
EOF
chmod +x "$work/bin/claude"
git -C "$work/project" init -q

description() { sed -n 's/^description: //p' "$repo/skills/$1/SKILL.md" | head -1; }
skills=(hoptell-reviewers hoptell-owner-channel hoptell-safe-ops)
for skill in ${ONLY:-${skills[@]}}; do
  rm -f "$work/project/.claude/commands/"*.md
  for other in "${skills[@]}"; do
    [ "$other" = "$skill" ] && continue
    printf -- '---\ndescription: |\n  %s\n---\n\n# %s\n' "$(description "$other")" "$other" > "$work/project/.claude/commands/$other.md"
  done
  (cd "$work/project" && env -u CLAUDECODE PATH="$work/bin:$PATH" PYTHONPATH="$SKILL_CREATOR" python3 -m scripts.run_eval \
    --eval-set "$repo/test/skill-evals/triggers/$skill.json" --skill-path "$repo/skills/$skill" \
    --runs-per-query "$runs" --num-workers 1 --timeout 60 ${model:+--model "$model"}) > "$out/$skill.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["summary"]; print(d["skill_name"] + ": " + str(s["passed"]) + "/" + str(s["total"]) + " queries pass")' "$out/$skill.json"
done

#!/usr/bin/env python3
"""Summarize `claude plugin eval` results (the --json output, or aggregate-result.json) as Markdown.

    python3 test/skill-evals/summarize.py <result.json> [<baseline result.json>]

Per case: the with-plugin score and pass rate over its runs, the no-plugin baseline score, and
the skill-fired indicator (how many with-plugin runs called the expected skill). Per suite: the
mean score with its standard deviation over runs. With a second file, a before/after column.
"""
import json, statistics, sys
from collections import defaultdict


def load(path):
    d = json.load(open(path))
    out = {}
    for c in d["cases"]:
        runs = c["arms"].get("with", [])
        base = c["arms"].get("without", [])
        def fired(r):
            gs = [g for g in r.get("graders", []) if "uses-skill" in g["name"]]
            return any(g["passed"] for g in gs) if gs else None
        f = [fired(r) for r in runs]
        failed = defaultdict(int)
        for r in runs:
            for g in r.get("graders", []):
                if g.get("scored", True) and not g["passed"]:
                    failed[g["name"]] += 1
        out[c["name"]] = {
            "suite": c.get("dir", "evals/?").split("/")[1],
            "scores": [r.get("score") or 0 for r in runs],
            "passed": sum(1 for r in runs if r.get("passed")),
            "runs": len(runs),
            "baseline": statistics.mean([r.get("score") or 0 for r in base]) if base else None,
            "fired": (sum(1 for x in f if x), len([x for x in f if x is not None])) if any(x is not None for x in f) else None,
            "failed": dict(failed),
            "errors": sum(1 for r in runs if r.get("error")),
        }
    return d, out


def fmt(x):
    return "-" if x is None else f"{x:.2f}"


def main():
    d, now = load(sys.argv[1])
    prev = load(sys.argv[2])[1] if len(sys.argv) > 2 else None
    print(f"Claude Code {d.get('claudeVersion')}, {d.get('durationSeconds')} s, ${d.get('costUsd', 0):.2f}\n")
    head = "| Case | Runs passed | Score (mean) | Baseline | Skill fired |" + (" Before |" if prev else "") + " Failed graders |"
    print(head)
    print("|" + " --- |" * (head.count("|") - 1))
    suites = defaultdict(list)
    for name, c in sorted(now.items(), key=lambda kv: kv[0]):
        suites[c["suite"]].extend(c["scores"])
        fired = f"{c['fired'][0]}/{c['fired'][1]}" if c["fired"] else "-"
        before = fmt(statistics.mean(prev[name]["scores"])) if prev and name in prev and prev[name]["scores"] else "-"
        failed = ", ".join(f"{k} ({v})" for k, v in sorted(c["failed"].items())) or "-"
        row = f"| {name} | {c['passed']}/{c['runs']} | {fmt(statistics.mean(c['scores']) if c['scores'] else None)} | {fmt(c['baseline'])} | {fired} |"
        print(row + (f" {before} |" if prev else "") + f" {failed} |")
    print("\n| Suite | Runs | Mean score | Std dev |")
    print("| --- | --- | --- | --- |")
    for s, xs in sorted(suites.items()):
        print(f"| {s} | {len(xs)} | {statistics.mean(xs):.3f} | {statistics.pstdev(xs):.3f} |")


if __name__ == "__main__":
    main()

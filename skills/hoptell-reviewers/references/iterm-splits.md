# iTerm2 splits, one per reviewer

This is a reference recipe for macOS with iTerm2. It is not part of hoptell. Run it only when the
user asked to see the reviewers, and show the user the script first.

Start the reviewers first (SKILL.md, step 2). Then open one split per reviewer in the current
iTerm2 window. Each split attaches one tmux session.

```sh
osascript <<'APPLESCRIPT'
set names to {"alice-reviewer-1", "alice-reviewer-2"}
tell application "iTerm2"
  tell current window
    set base to current session of current tab
    repeat with n in names
      tell base
        set s to (split vertically with default profile)
      end tell
      tell s
        write text "tmux attach -t '=hoptell-" & n & "'"
      end tell
    end repeat
  end tell
end tell
APPLESCRIPT
```

- Replace the names in the first line with the reviewers' names.
- `split horizontally` stacks the splits instead of placing them side by side.
- Closing a split only detaches it. The reviewer keeps running. Attach again with
  `tmux attach -t '=hoptell-<name>'`.
- macOS may ask once to allow the terminal app to control iTerm2.

## Other terminals

- Inside the user's own tmux: `tmux split-window "env -u TMUX tmux attach -t '=hoptell-<name>'"`
  opens a nested view of the reviewer in a new pane.
- Any terminal: give the user one line per reviewer to paste into a new split or tab:

```sh
tmux attach -t '=hoptell-alice-reviewer-1'
```

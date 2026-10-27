# iTerm2 splits, one per reviewer

This is a reference recipe for macOS with iTerm2. It is not part of hoptell. Run it only when the
user asked to see the reviewers, and show the user the script first.

Start the reviewers first (SKILL.md, step 2). Then open one split per reviewer next to this
session's own iTerm2 pane. Each split attaches one tmux session.

The script finds this session's pane by its iTerm2 session id (from `ITERM_SESSION_ID`, which
the agent's shell inherits from its terminal) and splits that pane. It writes only to the split
object each `split` returns. Never target `current session`, `current tab` or `current window`:
they follow keyboard focus, which moves when a split opens or the user clicks elsewhere, and
text can then be typed into another pane, such as another agent's prompt.

```sh
osascript - "${ITERM_SESSION_ID#*:}" alice-reviewer-1 alice-reviewer-2 <<'APPLESCRIPT'
on run argv
  set sid to item 1 of argv
  set names to rest of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is sid then
            repeat with n in names
              set p to (split vertically with default profile) of s
              tell p to write text "tmux attach -t '=hoptell-" & n & "'"
            end repeat
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "No iTerm2 session with id " & sid & "; nothing was opened."
end run
APPLESCRIPT
```

- Replace the names after the session id with the reviewers' names.
- If `ITERM_SESSION_ID` is empty, this session does not run in iTerm2; give the user the attach
  lines below instead. With a known tty, compare `tty of s` instead of `id of s`.
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

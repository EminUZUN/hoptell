# A real terminal client for injector tests: runs `tmux attach -t <session>` on a
# pseudo-terminal and types each line read from stdin into it (tmux sees real key input).
import os
import pty
import select
import sys

session = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "attach", "-t", session])

stdin = sys.stdin.fileno()
while True:
    ready, _, _ = select.select([fd, stdin], [], [], 1.0)
    if fd in ready:
        try:
            if not os.read(fd, 65536):
                break
        except OSError:
            break
    if stdin in ready:
        line = os.read(stdin, 4096)
        if not line:
            break
        os.write(fd, line.rstrip(b"\n"))

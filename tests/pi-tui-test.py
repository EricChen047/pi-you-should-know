#!/usr/bin/env python3
"""Exercise Pi's real TUI with an in-process fake model and isolated state."""
import errno
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import unicodedata
from pathlib import Path

here = Path(__file__).resolve().parent
temp = tempfile.mkdtemp(prefix="pi-observer-tui-", dir=os.environ.get("YSK_TEST_TMPDIR"))
mode = os.environ.get("YSK_TEST_MODE", "fullscreen")
if mode == "regular":
    Path(temp, "agent").mkdir(parents=True, exist_ok=True)
    Path(temp, "agent", "settings.json").write_text('{"tuiMode":"regular"}')
pi = os.environ.get("PI_TEST_BIN", str(Path.home() / ".pi/agent/bin/pi"))
env = {"PATH": os.environ.get("PATH", ""), "HOME": temp, "TMPDIR": temp,
       "PI_CODING_AGENT_DIR": str(Path(temp) / "agent"), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
args = [pi, "--offline", "--no-session", "--no-approve", "--no-extensions", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "observer-test", "--model", "mock-model", "-e", str(here / "mock-provider.ts"), "-e", str(here.parent / "index.ts")]
if os.environ.get("YSK_TEST_EXTRA_EXTENSION"):
    args.extend(["-e", os.environ["YSK_TEST_EXTRA_EXTENSION"]])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(temp)
    os.execvpe(pi, args, env)

columns = int(os.environ.get("YSK_TEST_COLUMNS", "110"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
out = bytearray()

def wait_for(needle, start=0, seconds=10):
    target = needle.encode()
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if target in out[start:]:
            return
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            out.extend(chunk)
    raise AssertionError(f"Not found: {needle!r}; terminal output: {out[-5000:].decode(errors='replace')}")

def send(line):
    os.write(fd, line.encode() + b"\r")

def screen_rows():
    # Fullscreen Pi redraws each changed row with CUP + erase-line. Reconstruct
    # just the visible text; button rows contain no cursor movement of their own.
    data = out.decode(errors="replace")
    updates = list(re.finditer(r"\x1b\[(\d+);1H\x1b\[2K", data))
    rows = {}
    for index, update in enumerate(updates):
        end = updates[index + 1].start() if index + 1 < len(updates) else len(data)
        text = data[update.end():end]
        text = re.split(r"\x1b\[\d+;\d+H", text)[0]
        text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        rows[int(update.group(1))] = text
    return rows

def click(label):
    # SGR mouse press + release uses terminal coordinates (1-based).
    for _ in range(100):
        for row, text in screen_rows().items():
            if label in text:
                before = text[:text.index(label) + 2]
                col = sum(0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in before) + 1
                os.write(fd, f"\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m".encode())
                return
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            out.extend(os.read(fd, 65536))
    raise AssertionError(f"Button {label!r} not on screen: {screen_rows()}")

try:
    # The Pi input border is present once the real interactive runtime is ready.
    wait_for("Press ctrl+o")
    time.sleep(0.8)
    print("Pi TUI ready", flush=True)
    start = len(out)
    send("/ysk model observer-test/side-model")
    wait_for("Observer model updated", start)
    start = len(out)
    send("/ysk thinking")
    wait_for("Choose observer thinking level", start)
    wait_for("high", start)
    # Options are minimal, low, medium, high for the fixture model; no off option.
    for _ in range(3):
        os.write(fd, b"\x1b[B")
        time.sleep(0.05)
    os.write(fd, b"\r")
    wait_for("Observer thinking set to high", start)
    start = len(out)
    send("/ysk on")
    wait_for("Observer enabled", start)
    print("observer enabled", flush=True)
    start = len(out)
    send("请检查测试结果")
    wait_for("2 tests failed", start)
    print("main response received", flush=True)
    # Wait until the agent becomes idle before issuing an interactive command.
    time.sleep(0.3)
    start = len(out)
    send("/ysk check")
    wait_for("模拟测试失败", start)
    print("widget shown", flush=True)
    if mode == "fullscreen":
        wait_for("[ View details ]", start)

    # The shortcut opens actions without submitting a command or consuming text.
    start = len(out)
    os.write(fd, b"DRAFT_TEST")
    wait_for("DRAFT_TEST", start)
    start = len(out)
    os.write(fd, b"\x1b\x19")  # Ctrl+Alt+Y
    wait_for("Cancel", start)
    if mode == "regular":
        start = len(out)
        os.write(fd, b"\x1b[B\r")  # View details
        wait_for("Heads-up details", start)
        wait_for("上线前应确认", start)
        start = len(out)
        os.write(fd, b"d")  # Put the finding in the editor, without sending it.
        wait_for("Reminder from the side agent", start)
        wait_for("DRAFT_TEST", start)
        print(f"PASS real Pi regular TUI ({columns} columns): keyboard details and draft preservation", flush=True)
    else:
        start = len(out)
        os.write(fd, b"\x1b")
        wait_for("[ View details ]", start)
        start = len(out)
        click("[ View details ]")
        wait_for("Heads-up details", start)
        wait_for("上线前应确认", start)
        start = len(out)
        click("[ Close ]")
        wait_for("\x1b[?2026l", start)
        time.sleep(0.2)
        assert not any("[ Dismiss ]" in text for text in screen_rows().values())
        print(f"PASS real Pi TUI ({columns} columns): shortcut, mouse details, close clears reminder", flush=True)
    assert b"rendered line exceeds" not in out
except BaseException as exc:
    print(f"TUI fixture failed: {exc}", flush=True)
    raise
finally:
    # Closing the master first prevents a full PTY output buffer blocking exit.
    os.close(fd)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    limit = time.monotonic() + 2
    while time.monotonic() < limit:
        done, _status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        time.sleep(0.05)
    shutil.rmtree(temp)

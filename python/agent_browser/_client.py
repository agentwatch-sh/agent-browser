"""The adapter: one method for each `agent-browser` CLI command, with the same options.

Each call runs the CLI with subprocess (an argv list, never a shell string), reads its one JSON
document, and returns a typed result. Text that can be a secret (the text of `type`, the
expression of `eval`) goes to the CLI's standard input, never into argv.
"""

from __future__ import annotations

import collections.abc
import json
import os
import re
import shutil
import subprocess
from collections.abc import Sequence as AnySequence
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple, TypeVar, Union

from ._errors import ERRORS_BY_CODE, CLIError, NodeNotFoundError, NodeVersionError, PackageNotFoundError, ProtocolError
from ._results import (
    ClickResult, CloseResult, CommandsResult, DownloadResult, EvalResult, FetchResult, GotoResult,
    HoverResult, NetResult, OpenResult, OutlineResult, PressResult, RecordResult, ShotResult, StatusResult,
    TabsResult, TextResult, TypeResult, WindowResult,
)

PathLike = Union[str, "os.PathLike[str]"]
R = TypeVar("R")

MIN_NODE_MAJOR = 26

#: How long a call may run, in seconds, by default. `net` and `record` add their own waiting time.
DEFAULT_TIMEOUT = 120.0

#: `record` runs at most 30 minutes (the CLI's limit), then encodes the MP4.
RECORD_WAIT = 1800.0 + 900.0

#: On Linux an input command can wait for another one's input lock (inputTiming.lockWaitMs, 600 s by
#: default), and it types at a person's pace: about 0.2 to 0.3 s a character for the first 12 s of a run, then 0.1 to
#: 0.12 s (a capital adds its Shift key). KEY_MS, 0.35 s a character, is the slow end of the first part with a margin.
LOCK_WAIT_MS = 600_000.0
KEY_MS = 350.0

#: A read (text, outline, eval) waits for the input lock inside its own timeout (review-52 note 5), as the library's
#: Tab.waitFor does: it keeps this many seconds of the timeout for its own work, and at least half of the timeout, and the
#: rest (at most lockWaitMs) may go to the wait. A read that hangs for another reason fails at the timeout; a long wait
#: for the lock fails with the lock's own error.
READ_WORK = 30.0


def default_package_dir() -> Optional[Path]:
    """The checkout this adapter came from (python/agent_browser/ is two levels below it), if it holds the CLI."""
    root = Path(__file__).resolve().parents[2]
    return root if _is_package(root) else None


def _scope(any_scope: bool) -> List[str]:
    """The CLI flag that reaches tabs outside the tab scope."""
    return ["--any-scope"] if any_scope else []


def _is_package(path: Path) -> bool:
    try:
        name = json.loads((path / "package.json").read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError, AttributeError):
        return False
    return name == "agent-browser" and (path / "bin" / "agent-browser.js").is_file()


def _strings(value: object) -> bool:
    """A sequence of strings (a list or a tuple), not one string."""
    return isinstance(value, AnySequence) and not isinstance(value, (str, bytes)) and all(isinstance(a, str) for a in value)


def _argv_list(name: str, value: Optional[Sequence[str]]) -> Optional[List[str]]:
    """A command for the CLI to run: a non-empty argv list, never a shell string."""
    if value is None:
        return None
    if not _strings(value) or not value:
        raise ValueError(f"{name} must be a non-empty sequence of strings (an argv list, not a shell string)")
    return list(value)


def _path(name: str, value: Optional[PathLike]) -> Optional[Path]:
    """A path argument as a Path. An empty one is a ValueError: Path("") is ".", the current folder."""
    if value is None:
        return None
    if os.fspath(value) == "":
        raise ValueError(f"{name} is an empty path: give a path, or leave it out")
    return Path(value)


class AgentBrowser:
    """agentwatch's agent browser, driven through the `agent-browser` CLI over agent mode's endpoint.

    `notify_command` (an argv list, never a shell string) is where `status(notify=True)` sends one message when agent
    mode's endpoint does not answer: `{message}` in an argument and its standard input carry the text.

    `cdp_url` (required) is agent mode's endpoint, ws+unix://<socket>:/devtools/browser/<scope>, from
    `agentwatch browser endpoint`: the only way to drive the agent browser. agent-browser starts no
    Chrome and no proxy, and no "Allow remote debugging?" prompt appears (the CDP proxy, `launch`,
    personal mode and the approvers are gone: README, "Agent mode's endpoint"). state_dir and
    allowlist belong to this consumer alone: its tab names and scopes live under state_dir. The
    allowlist file is read, never written. `node` is the Node 26+ binary, and `package_dir` the
    agent-browser package folder (default: the checkout this module is in).

    `tab_scope` (for example the calling session's name) keeps callers that share one agent browser
    apart: `open` records each new tab under the scope, a `tab` argument resolves only among the
    scope's tabs, and `tabs()` lists them with a count of the others. The `any_scope=True` argument of
    a method reaches the tabs outside the scope. The CLI checks the name (1 to 64 letters, digits,
    ".", "_" or "-", starting with a letter or a digit) and raises UsageError for any other; a
    tab_scope that is not a string raises ValueError here, before any call.

    `hidden_drive=True` (`--hidden-drive`) keeps a background tab's page hidden while a command drives
    it: no focus emulation, and click, hover, type, press and shot keep Chrome drawing the hidden page
    with a hidden capture. Without it a command turns on focus emulation for a background tab, so the
    page is visible for the command's length. On Linux each page has a window of its own and needs
    neither (README, "One window per agent page"): there the two modes apply only where the display is
    not the agent browser's own; on the Mac the relay keeps its tabs. See the README, "A command on a
    background tab: two modes". Measured on Linux only. A hidden_drive that is not a bool raises
    ValueError here, before any call.

    `input_timing` (`--input-timing`, a JSON object) changes the shape of a person's input in a window of
    its own (on Linux): ms ranges such as `{"pressMs": [70, 90], "keyMs": [90, 150]}`, and `moveScale`,
    `activateMs`, `lockWaitMs`. The fields that it names replace the defaults; the CLI checks them and
    raises UsageError. An input_timing that is not a mapping raises ValueError here.

    An empty path argument ("") raises ValueError here, before any call: Path("") would be ".", the
    current folder. A method's empty path goes to the CLI, which raises UsageError.
    """

    def __init__(
        self,
        state_dir: PathLike,
        allowlist: Optional[PathLike] = None,
        *,
        cdp_url: str,
        notify_command: Optional[Sequence[str]] = None,
        command_name: Optional[str] = None,
        tab_scope: Optional[str] = None,
        hidden_drive: bool = False,
        input_timing: Optional[Mapping[str, object]] = None,
        node: str = "node",
        package_dir: Optional[PathLike] = None,
        timeout: float = DEFAULT_TIMEOUT,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        if not isinstance(cdp_url, str) or not cdp_url:
            raise ValueError("cdp_url is required: agent mode's endpoint (ws+unix://<socket>:/devtools/browser/<scope>, from "
                             "`agentwatch browser endpoint`), the only way to drive the agent browser")
        notify_argv = _argv_list("notify_command", notify_command)
        if tab_scope is not None and not isinstance(tab_scope, str):
            raise ValueError(f"tab_scope must be a string (a scope name) or None, not {type(tab_scope).__name__}")
        if not isinstance(hidden_drive, bool):
            raise ValueError(f"hidden_drive must be True or False, not {hidden_drive!r}")
        if input_timing is not None and not isinstance(input_timing, collections.abc.Mapping):
            raise ValueError(f"input_timing must be a mapping of field names to ms ranges, not {type(input_timing).__name__}")
        state = _path("state_dir", state_dir)
        if state is None:
            raise ValueError("state_dir is required: this consumer's own state folder")
        self.state_dir = state
        self.allowlist = _path("allowlist", allowlist)
        # Agent mode's endpoint (agentwatch's relay): every command connects to it.
        self.cdp_url = cdp_url
        self.notify_command = notify_argv
        self.command_name = command_name
        self.tab_scope = tab_scope
        self.hidden_drive = hidden_drive
        self.input_timing: Optional[Dict[str, object]] = dict(input_timing) if input_timing is not None else None
        self.node = node
        self.package_dir = _path("package_dir", package_dir)
        self.timeout = timeout
        self.env: Optional[Dict[str, str]] = dict(env) if env is not None else None
        self._node_checked: Optional[str] = None

    # ---------- plumbing ----------

    def node_version(self) -> Tuple[int, int, int]:
        """The node binary's version; raises NodeNotFoundError or NodeVersionError (older than Node 26)."""
        node = self._node_path()
        try:
            done = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30, env=self.env, check=False)
        except (FileNotFoundError, PermissionError, NotADirectoryError) as e:
            raise NodeNotFoundError(f"cannot run node at {node}: {e}") from e
        except subprocess.TimeoutExpired as e:
            raise NodeNotFoundError(f"{node} --version did not answer") from e
        m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\S*", done.stdout.strip())
        if done.returncode != 0 or not m:
            raise NodeNotFoundError(f"{node} --version printed {done.stdout.strip()!r} (exit {done.returncode}); is it Node.js?")
        version = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if version[0] < MIN_NODE_MAJOR:
            raise NodeVersionError(f"agent-browser needs Node {MIN_NODE_MAJOR} or later; {node} is {done.stdout.strip()}")
        return version

    def _node_path(self) -> str:
        if os.sep in self.node or (os.altsep and os.altsep in self.node):
            return self.node
        found = shutil.which(self.node, path=(self.env or os.environ).get("PATH"))
        if not found:
            raise NodeNotFoundError(f"{self.node!r} is not on PATH; install Node {MIN_NODE_MAJOR}+ or pass node=")
        return found

    def _bin(self) -> Path:
        root = self.package_dir or default_package_dir()
        if root is None or not _is_package(root):
            raise PackageNotFoundError(f"no agent-browser package at {root}; pass package_dir= (a checkout, or node_modules/agent-browser)")
        return root / "bin" / "agent-browser.js"

    def _global_flags(self, lock_wait_ms: Optional[int] = None) -> List[str]:
        flags = ["--state-dir", os.fspath(self.state_dir)]
        if self.allowlist is not None:
            flags += ["--allowlist", os.fspath(self.allowlist)]
        flags += ["--cdp-url", self.cdp_url]
        if self.notify_command is not None:
            flags += ["--notify-command", json.dumps(self.notify_command)]
        if self.command_name is not None:
            flags += ["--command-name", self.command_name]
        if self.tab_scope is not None:
            flags += ["--tab-scope", self.tab_scope]
        if self.hidden_drive:
            flags.append("--hidden-drive")
        timing = dict(self.input_timing) if self.input_timing is not None else None
        if lock_wait_ms is not None:
            timing = {**(timing or {}), "lockWaitMs": lock_wait_ms}
        if timing is not None:
            flags += ["--input-timing", json.dumps(timing)]
        return flags

    def _run(self, command: str, args: Sequence[str], parse: Callable[[Mapping[str, object]], R], *, stdin: Optional[str] = None,
             extra_timeout: float = 0.0, global_flags: bool = True, lock_wait_ms: Optional[int] = None) -> R:
        if self._node_checked is None:
            self.node_version()
            self._node_checked = self._node_path()
        argv = [self._node_checked, os.fspath(self._bin()), command, *args, *(self._global_flags(lock_wait_ms) if global_flags else []), "--json"]
        try:
            done = subprocess.run(argv, input=(stdin or "").encode("utf-8"), capture_output=True, timeout=self.timeout + extra_timeout,
                                  env=self.env, check=False)
        except FileNotFoundError as e:
            raise NodeNotFoundError(f"cannot run node at {self._node_checked}: {e}") from e
        except subprocess.TimeoutExpired as e:
            raise ProtocolError(f"agent-browser {command} did not finish within {self.timeout + extra_timeout:.0f} s") from e
        stdout = done.stdout.decode("utf-8", errors="replace")
        stderr = done.stderr.decode("utf-8", errors="replace")
        lines = stdout.strip().splitlines()
        try:
            if len(lines) != 1:
                raise ValueError(f"{len(lines)} lines")
            doc = json.loads(lines[0])
        except ValueError as e:
            raise ProtocolError(f"agent-browser {command} did not print one JSON document ({e}); exit {done.returncode}; stderr: {stderr[-500:]}",
                                stdout=stdout, stderr=stderr, exit_status=done.returncode) from None
        if not isinstance(doc, dict) or not isinstance(doc.get("ok"), bool):
            raise ProtocolError(f"agent-browser {command}: the JSON document has no boolean 'ok'", stdout=stdout, stderr=stderr, exit_status=done.returncode)
        if doc["ok"] is False:
            err = doc.get("error")
            if not isinstance(err, dict) or not isinstance(err.get("code"), str) or not isinstance(err.get("message"), str) or done.returncode == 0:
                raise ProtocolError(f"agent-browser {command}: malformed error document", stdout=stdout, stderr=stderr, exit_status=done.returncode)
            cls = ERRORS_BY_CODE.get(err["code"], CLIError)
            raise cls(err["code"], err["message"], command=command, exit_status=done.returncode, stderr=stderr)
        if done.returncode != 0 or doc.get("command") != command:
            raise ProtocolError(f"agent-browser {command}: exit {done.returncode} with a success document for {doc.get('command')!r}",
                                stdout=stdout, stderr=stderr, exit_status=done.returncode)
        try:
            return parse(doc)
        except ProtocolError as e:
            raise ProtocolError(f"agent-browser {command}: unexpected JSON shape: {e}", stdout=stdout, stderr=stderr, exit_status=done.returncode) from None

    # ---------- the commands (one each; COMMAND_SPECS in src/commands.ts lists them) ----------

    def status(self, notify: bool = False) -> StatusResult:
        """Read-only connection status of agent mode's endpoint; when it does not answer, `detail` says why, and `notify`
        sends one message to the notify command."""
        return self._run("status", ["--notify"] if notify else [], StatusResult.from_json)

    def window(self, pin: Optional[str] = None, unpin: bool = False, any_scope: bool = False) -> WindowResult:
        """Show the pinned window; `pin` pins the window that holds that tab; `unpin` clears the pin.

        Under a tab scope, `pin` and `unpin` need any_scope=True: the pin confines every scope.
        """
        if pin is not None and unpin:
            raise ValueError("window: pin or unpin, not both")
        return self._run("window", [*(["pin", pin] if pin is not None else ["unpin"] if unpin else []), *_scope(any_scope)], WindowResult.from_json)

    def tabs(self, any_scope: bool = False) -> TabsResult:
        """Allowlisted tabs only (other tabs are never shown). With a tab scope, the scope's tabs and a count of the others."""
        return self._run("tabs", _scope(any_scope), TabsResult.from_json)

    def open(self, url: str, name: Optional[str] = None, tab: bool = False) -> OpenResult:
        """Open an allowlisted URL; `name` remembers the tab.

        On Linux the page gets a window of its own. `tab=True` asks for a tab rather than a window; the
        relay decides: a window on Linux (one window per page), a tab on the Mac.
        """
        return self._run("open", [url, *(["--name", name] if name is not None else []), *(["--tab"] if tab else [])], OpenResult.from_json)

    # Each method that takes a `tab` also takes `any_scope`: True reaches a tab outside this tab scope.

    def goto(self, tab: str, url: str, any_scope: bool = False) -> GotoResult:
        """Navigate a tab to an allowlisted URL."""
        return self._run("goto", [tab, url, *_scope(any_scope)], GotoResult.from_json)

    def outline(self, tab: str, all: bool = False, any_scope: bool = False) -> OutlineResult:
        """Number the interactive elements on screen (`all`: the whole page). Read this before a screenshot.

        In agent mode on Linux a read of a hidden window page brings its tab in front inside the input lock, so it can wait
        for another agent's input command, as `text` and `eval` do. That wait is part of the call's timeout (at most all
        but 30 s of it, at least half of it, and never more than `lockWaitMs` of `input_timing`): a longer wait fails
        with the lock's own error. A `lockWaitMs` of 0 or less, which the CLI refuses, is replaced by 1 ms for a read.
        """
        return self._run("outline", [tab, *(["--all"] if all else []), *_scope(any_scope)], OutlineResult.from_json, lock_wait_ms=self._read_lock_wait_ms())

    def _timing(self, name: str, default: float, index: Optional[int] = None) -> float:
        """A number of the input timing (`index`: one end of a range), else the default."""
        v = (self.input_timing or {}).get(name)
        try:
            return float(v[index] if index is not None else v)  # type: ignore[index]
        except (TypeError, ValueError, IndexError, KeyError):
            return default

    def _input_wait(self, chars: int = 0) -> float:
        """The time an input command may add to `timeout`: the input lock's wait, and the typing of `chars` characters
        at the slowest pace of the input timing (in agent mode on Linux a person's typing takes about 0.2 to 0.3 s a
        character for the first 12 s of a run, then about 0.12 s)."""
        key = self._timing("keyMs", 300.0, 1) + self._timing("holdMs", 50.0, 1)
        return self._timing("lockWaitMs", LOCK_WAIT_MS) / 1000.0 + chars * (key if self.input_timing else KEY_MS) / 1000.0

    def _read_lock_wait_ms(self) -> int:
        """A read's wait for the input lock (text, outline, eval), inside its timeout (READ_WORK; review-52 note 5), in ms.
        At least 1 ms: a caller's lockWaitMs of 0 or less (the CLI refuses it) is replaced by 1 ms."""
        share = max(self.timeout / 2.0, self.timeout - READ_WORK)
        return max(1, int(min(self._timing("lockWaitMs", LOCK_WAIT_MS), share * 1000.0)))

    def click(self, tab: str, target: Optional[str] = None, text: Optional[str] = None, any_scope: bool = False,
              *, download: Optional[PathLike] = None, timeout: Optional[int] = None) -> ClickResult:
        """Trusted click on `target` (#N or CSS), or exact `text`.

        `download` captures a file in that directory. `timeout` is its positive wait in milliseconds
        (default 120000), and needs `download`. The adapter adds this wait to its process timeout.
        """
        if (target is None) == (text is None):
            raise ValueError("click needs target or text, not both")
        args = [tab, target] if target is not None else [tab, "--text", text or ""]
        directory = _path("download", download)
        if timeout is not None and (directory is None or isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0 or timeout > 2_147_483_647):
            raise ValueError("timeout needs download and a positive integer of at most 2147483647 milliseconds")
        if directory is not None:
            args += ["--download", os.fspath(directory)]
        if timeout is not None:
            args += ["--timeout", str(timeout)]
        wait = (120.0 if timeout is None else timeout / 1000.0) if directory is not None else 0.0
        return self._run("click", [*args, *_scope(any_scope)], ClickResult.from_json, extra_timeout=self._input_wait() + wait)

    def hover(self, tab: str, target: str, any_scope: bool = False) -> HoverResult:
        """Move the mouse over `target` (#N or a CSS selector)."""
        return self._run("hover", [tab, target, *_scope(any_scope)], HoverResult.from_json, extra_timeout=self._input_wait())

    def type(self, tab: str, text: str, into: Optional[str] = None, any_scope: bool = False) -> TypeResult:
        """Type `text` into `into` (else the focused field); fails when the text did not arrive. The text goes on stdin, never into argv.

        The call's timeout grows with the text and the input lock's wait: in agent mode on Linux each character takes
        about 0.2 to 0.3 s for the first 12 s of a run, then about 0.12 s (a person's typing), and another input command
        can hold the lock for up to `lockWaitMs`.
        """
        return self._run("type", [tab, "--stdin", *(["--into", into] if into is not None else []), *_scope(any_scope)], TypeResult.from_json,
                         stdin=text, extra_timeout=self._input_wait(len(text)))

    def press(self, tab: str, key: str, any_scope: bool = False) -> PressResult:
        """Press Enter, Tab, Escape, Backspace, Delete, an arrow key, Home, End, PageUp, PageDown, or F1 to F12."""
        return self._run("press", [tab, key, *_scope(any_scope)], PressResult.from_json, extra_timeout=self._input_wait())

    def text(self, tab: str, selector: Optional[str] = None, any_scope: bool = False) -> TextResult:
        """Visible text of the page, or of `selector` (#N or CSS). Read this before a screenshot. It can wait for the input lock inside its timeout (see `outline`)."""
        return self._run("text", [tab, *([selector] if selector is not None else []), *_scope(any_scope)], TextResult.from_json,
                         lock_wait_ms=self._read_lock_wait_ms())

    # Not Python's eval(): the CLI runs the expression inside the allowlisted page (CDP Runtime.evaluate).
    def eval(self, tab: str, expression: str, any_scope: bool = False) -> EvalResult:
        """Evaluate a JavaScript expression in the page and return its JSON value. The expression goes on stdin.
        It can wait for the input lock inside its timeout (see `outline`)."""
        return self._run("eval", [tab, "--stdin", *_scope(any_scope)], EvalResult.from_json, stdin=expression, lock_wait_ms=self._read_lock_wait_ms())

    def shot(self, tab: str, path: Optional[PathLike] = None, full: bool = False, size: Optional[str] = None,
             scale: Optional[float] = None, any_scope: bool = False) -> ShotResult:
        """A PNG screenshot, refused until outline or text has read the page at its current URL.

        `size` ("1920x1080", CSS pixels) and `scale` (the device pixel ratio) lay the page out at exactly
        that size for the shot only, so the PNG is width x scale by height x scale pixels.
        """
        args = [tab, *([os.fspath(path)] if path is not None else []), *(["--full"] if full else [])]
        if size is not None:
            args += ["--size", size]
        if scale is not None:
            args += ["--scale", repr(float(scale))]
        return self._run("shot", [*args, *_scope(any_scope)], ShotResult.from_json)

    def fetch(self, tab: str, url: str, path: PathLike, any_scope: bool = False) -> FetchResult:
        """Save `url` with the page's fetch() and cookies (same-origin and CORS rules apply)."""
        return self._run("fetch", [tab, url, os.fspath(path), *_scope(any_scope)], FetchResult.from_json)

    def download(self, tab: str, url: str, path: PathLike, any_scope: bool = False) -> DownloadResult:
        """Save `url` through Chrome's network stack (cross-origin CDN media)."""
        return self._run("download", [tab, url, os.fspath(path), *_scope(any_scope)], DownloadResult.from_json)

    def close(self, tab: str, any_scope: bool = False) -> CloseResult:
        """Close a tab."""
        return self._run("close", [tab, *_scope(any_scope)], CloseResult.from_json)

    def net(self, tab: str, seconds: Optional[float] = None, match: Optional[str] = None, max: Optional[int] = None,
            any_scope: bool = False) -> NetResult:
        """Record the tab's fetch/XHR/WebSocket traffic for `seconds` (default 60); never headers, bodies redacted."""
        args = [tab]
        if seconds is not None:
            args += ["--seconds", repr(float(seconds))]
        if match is not None:
            args += ["--match", match]
        if max is not None:
            args += ["--max", str(int(max))]
        return self._run("net", [*args, *_scope(any_scope)], NetResult.from_json, extra_timeout=60.0 if seconds is None else float(seconds))

    def record(self, tab: str, out: PathLike, script: Optional[PathLike] = None, setup: Optional[PathLike] = None, size: Optional[str] = None,
               fps: Optional[int] = None, scale: Optional[float] = None, no_cursor: bool = False, settle: Optional[float] = None,
               seed: Optional[int] = None, ffmpeg: Optional[PathLike] = None, any_scope: bool = False) -> RecordResult:
        """Record the tab to the MP4 `out` while the step script drives it; the provenance JSON goes beside it.

        `setup` steps run first, off camera. `size` is the page size in CSS pixels ("1920x1080"), `scale`
        the device pixel ratio, `settle` the ms of still page before the first step and after the last,
        and `seed` the seed of the cursor paths and typing pace. Needs ffmpeg (on PATH, or `ffmpeg`).
        """
        args = [tab, "--out", os.fspath(out)]
        for flag, path in (("--script", script), ("--setup", setup), ("--ffmpeg", ffmpeg)):
            if path is not None:
                args += [flag, os.fspath(path)]
        if size is not None:
            args += ["--size", size]
        if fps is not None:
            args += ["--fps", str(int(fps))]
        if scale is not None:
            args += ["--scale", repr(float(scale))]
        if no_cursor:
            args.append("--no-cursor")
        if settle is not None:
            args += ["--settle", repr(float(settle))]
        if seed is not None:
            args += ["--seed", str(int(seed))]
        return self._run("record", [*args, *_scope(any_scope)], RecordResult.from_json, extra_timeout=RECORD_WAIT + self._input_wait())


    def commands(self) -> CommandsResult:
        """Every CLI command with its parameters (the CLI's own description of itself)."""
        return self._run("commands", [], CommandsResult.from_json, global_flags=False)

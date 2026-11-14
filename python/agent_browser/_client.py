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
from typing import Callable, Dict, List, Literal, Mapping, Optional, Sequence, Tuple, TypeVar, Union

from ._errors import ERRORS_BY_CODE, CLIError, NodeNotFoundError, NodeVersionError, PackageNotFoundError, ProtocolError
from ._results import (
    ChromesResult, ClickResult, CloseResult, CommandsResult, ConnectResult, DownloadResult, EvalResult, FetchResult, FrontResult, GotoResult,
    HoverResult, LaunchResult, NetResult, OpenResult, OutlineResult, PressResult, QuitResult, RecordResult, ShotResult, StatusResult, StopResult,
    TabsResult, TextResult, TypeResult, WindowResult,
)

PathLike = Union[str, "os.PathLike[str]"]
R = TypeVar("R")

#: The built-in approvers of Chrome's "Allow remote debugging?" dialog: "auto" picks one by platform.
Approver = Literal["auto", "osascript", "xdotool"]
APPROVERS: Tuple[Approver, ...] = ("auto", "osascript", "xdotool")

MIN_NODE_MAJOR = 26

#: How long a call may run, in seconds, by default. `launch` and `net` add their own waiting time.
DEFAULT_TIMEOUT = 120.0

#: `launch` waits up to 10 minutes for the operator to turn remote debugging on.
LAUNCH_WAIT = 600.0

#: `record` runs at most 30 minutes (the CLI's limit), then encodes the MP4.
RECORD_WAIT = 1800.0 + 900.0

#: In agent mode on Linux an input command can wait for another one's input lock (inputTiming.lockWaitMs, 600 s by
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


def _path(name: str, value: Optional[PathLike]) -> Optional[Path]:
    """A path argument as a Path. An empty one is a ValueError: Path("") is ".", the current folder."""
    if value is None:
        return None
    if os.fspath(value) == "":
        raise ValueError(f"{name} is an empty path: give a path, or leave it out")
    return Path(value)


def _argv_list(name: str, value: Optional[Sequence[str]]) -> Optional[List[str]]:
    """A command for the CLI to run: a non-empty argv list, never a shell string."""
    if value is None:
        return None
    if not _strings(value) or not value:
        raise ValueError(f"{name} must be a non-empty sequence of strings (an argv list, not a shell string)")
    return list(value)


class AgentBrowser:
    """This consumer's agent browser, driven through the `agent-browser` CLI.

    state_dir and allowlist belong to this consumer alone: its own Chrome profile (its cookies and
    logins), tab names and proxy socket live under state_dir. The allowlist file is read, never
    written. `node` is the Node 26+ binary, and `package_dir` the agent-browser package folder
    (default: the checkout this module is in).

    `chrome_args` are extra Chrome flags at launch, one string each (no secrets: Chrome flags show in
    `ps`). The CLI refuses, before any launch, every --remote-debugging-* switch, --enable-automation,
    --headless, --user-data-dir and --profile-directory, in every dash, slash and case form
    (assertSafeChromeArgs in src/agent.ts), and raises UsageError. `approve` answers Chrome's "Allow
    remote debugging?" dialog for unattended use: True or "auto" picks the approver by platform,
    "osascript" or "xdotool" forces one. `approve_command` runs a custom approver argv in its place.
    `approve_after_wake=True` (`--approve-after-wake`, macOS): after a Mac sleep, the osascript approver
    answers the new prompt of the agent Chrome that a person approved by hand, only within 12 hours of
    that click; every other prompt waits for a person (README, "After a Mac sleep: approve after wake").

    `tab_scope` (for example the calling session's name) keeps callers that share one agent browser
    apart: `open` records each new tab under the scope, a `tab` argument resolves only among the
    scope's tabs, and `tabs()` lists them with a count of the others. The `any_scope=True` argument of
    a method reaches the tabs outside the scope. The CLI checks the name (1 to 64 letters, digits,
    ".", "_" or "-", starting with a letter or a digit) and raises UsageError for any other; a
    tab_scope that is not a string raises ValueError here, before any call.

    `hidden_drive=True` (`--hidden-drive`) keeps a background tab's page hidden while a command drives
    it: no focus emulation, and click, hover, type, press and shot keep Chrome drawing the hidden page
    with a hidden capture. Without it a command turns on focus emulation for a background tab, so the
    page is visible for the command's length. In agent mode on Linux each page has a window of its own
    and needs neither (README, "One window per agent page"): there the two modes apply only to a tab of
    `open(..., tab=True)`. See the README, "A command on a background tab: two modes". Measured on Linux
    only. A hidden_drive that is not a bool raises ValueError here, before any call.

    `input_timing` (`--input-timing`, a JSON object) changes the shape of a person's input in a window of
    its own (agent mode on Linux and on the Mac): ms ranges such as `{"pressMs": [70, 90], "keyMs": [90, 150]}`,
    and `moveScale`, `activateMs`, `showMs`, `lockWaitMs`. The fields that it names replace the defaults; the CLI
    checks them and raises UsageError. An input_timing that is not a mapping raises ValueError here.

    An empty path argument ("") raises ValueError here, before any call: Path("") would be ".", the
    current folder. A method's empty path goes to the CLI, which raises UsageError.
    """

    def __init__(
        self,
        state_dir: PathLike,
        allowlist: Optional[PathLike] = None,
        *,
        profile: Optional[PathLike] = None,
        socket: Optional[PathLike] = None,
        mode: Literal["agent", "personal"] = "agent",
        chrome_bin: Optional[PathLike] = None,
        chrome_args: Optional[Sequence[str]] = None,
        endpoint: Optional[str] = None,
        cdp_url: Optional[str] = None,
        personal_user_data_dir: Optional[PathLike] = None,
        no_launch: bool = False,
        no_prompt: bool = False,
        notify_command: Optional[Sequence[str]] = None,
        approve: Union[bool, Approver, None] = None,
        approve_command: Optional[Sequence[str]] = None,
        approve_after_wake: bool = False,
        proxy_idle_ms: Optional[int] = None,
        command_name: Optional[str] = None,
        tab_scope: Optional[str] = None,
        hidden_drive: bool = False,
        input_timing: Optional[Mapping[str, object]] = None,
        node: str = "node",
        package_dir: Optional[PathLike] = None,
        timeout: float = DEFAULT_TIMEOUT,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        if mode not in ("agent", "personal"):
            raise ValueError(f'mode must be "agent" or "personal", not {mode!r}')
        notify_argv = _argv_list("notify_command", notify_command)
        approve_argv = _argv_list("approve_command", approve_command)
        if approve is not None and not isinstance(approve, bool) and approve not in APPROVERS:
            raise ValueError(f'approve must be True, False, "auto", "osascript" or "xdotool", not {approve!r}')
        if approve_argv is not None and approve not in (None, False):
            raise ValueError("approve or approve_command, not both")
        if not isinstance(approve_after_wake, bool):
            raise ValueError(f"approve_after_wake must be True or False, not {approve_after_wake!r}")
        if chrome_args is not None and not _strings(chrome_args):
            raise ValueError("chrome_args must be a sequence of strings (one Chrome flag each, not one shell string)")
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
        self.profile = _path("profile", profile)
        self.socket = _path("socket", socket)
        self.mode: Literal["agent", "personal"] = mode
        self.chrome_bin = _path("chrome_bin", chrome_bin)
        self.chrome_args: Optional[List[str]] = list(chrome_args) if chrome_args is not None else None
        self.endpoint = endpoint
        # Agent mode's endpoint (agentwatch's relay): the CLI connects to it in place of the proxy socket.
        self.cdp_url = cdp_url
        self.personal_user_data_dir = _path("personal_user_data_dir", personal_user_data_dir)
        self.no_launch = no_launch
        self.no_prompt = no_prompt
        self.notify_command = notify_argv
        self.approve: Union[bool, Approver, None] = approve
        self.approve_command = approve_argv
        self.approve_after_wake = approve_after_wake
        self.proxy_idle_ms = proxy_idle_ms
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
        paths: List[Tuple[str, Optional[Path]]] = [("--allowlist", self.allowlist), ("--profile", self.profile), ("--socket", self.socket),
                                                   ("--chrome-bin", self.chrome_bin), ("--personal-user-data-dir", self.personal_user_data_dir)]
        for flag, path in paths:
            if path is not None:
                flags += [flag, os.fspath(path)]
        if self.chrome_args is not None:
            flags += ["--chrome-args", json.dumps(self.chrome_args)]
        if self.mode != "agent":
            flags += ["--mode", self.mode]
        if self.endpoint is not None:
            flags += ["--endpoint", self.endpoint]
        if self.cdp_url is not None:
            flags += ["--cdp-url", self.cdp_url]
        if self.no_launch:
            flags.append("--no-launch")
        if self.no_prompt:
            flags.append("--no-prompt")
        if self.notify_command is not None:
            flags += ["--notify-command", json.dumps(self.notify_command)]
        if self.approve_command is not None:
            flags += ["--approve-command", json.dumps(self.approve_command)]
        elif self.approve is True:
            flags += ["--approve", "auto"]
        elif isinstance(self.approve, str):
            flags += ["--approve", self.approve]
        if self.approve_after_wake:
            flags.append("--approve-after-wake")
        if self.proxy_idle_ms is not None:
            flags += ["--proxy-idle-ms", str(self.proxy_idle_ms)]
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

    def launch(self, login: bool = False) -> LaunchResult:
        """Start the agent browser; `login` opens every allowlisted site so the operator can sign in."""
        return self._run("launch", ["--login"] if login else [], LaunchResult.from_json, extra_timeout=LAUNCH_WAIT)

    def quit(self) -> QuitResult:
        """Stop the proxy and close the agent browser (never the operator's Chrome)."""
        return self._run("quit", [], QuitResult.from_json)

    def status(self, notify: bool = False) -> StatusResult:
        """Read-only connection status; `notify` sends one message to the notify command when no proxy works."""
        return self._run("status", ["--notify"] if notify else [], StatusResult.from_json)

    def connect(self, endpoint: str) -> ConnectResult:
        """Personal mode: remember the operator's Chrome endpoint (ws://127.0.0.1:<port>/devtools/browser/<id>) and connect."""
        return self._run("connect", [endpoint], ConnectResult.from_json)

    def stop(self) -> StopResult:
        """Stop this consumer's proxy (the next command restarts it, with one more approval)."""
        return self._run("stop", [], StopResult.from_json)

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

        In agent mode on Linux the page gets a window of its own. `tab=True` opens a tab rather than a
        window: in personal mode, in the pinned window; in agent mode on Linux, a background tab that
        keeps the old modes (focus emulation, or hidden_drive), which a site can detect.
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
        A capture is for agent mode only: personal mode refuses it with `UsageError`, before it connects,
        because a capture changes download behavior for the operator's whole Chrome.
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

    def chromes(self) -> ChromesResult:
        """Every agent-browser Chrome of this user on the machine (not only this consumer's): read-only, it connects to none."""
        return self._run("chromes", [], ChromesResult.from_json, global_flags=False)

    def front(self) -> FrontResult:
        """macOS: bring this consumer's agent browser to the front, so that a person finds its "Allow remote debugging?" prompt.

        It takes the operator's focus: only a person asks for it, never an agent on its own. It never
        connects to a Chrome. Off macOS it raises UsageError.
        """
        return self._run("front", [], FrontResult.from_json)

    def commands(self) -> CommandsResult:
        """Every CLI command with its parameters (the CLI's own description of itself)."""
        return self._run("commands", [], CommandsResult.from_json, global_flags=False)

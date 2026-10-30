"""The adapter: one method for each `agent-browser` CLI command, with the same options.

Each call runs the CLI with subprocess (an argv list, never a shell string), reads its one JSON
document, and returns a typed result. Text that can be a secret (the text of `type`, the
expression of `eval`) goes to the CLI's standard input, never into argv.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Dict, List, Literal, Mapping, Optional, Sequence, Tuple, TypeVar, Union

from ._errors import ERRORS_BY_CODE, CLIError, NodeNotFoundError, NodeVersionError, PackageNotFoundError, ProtocolError
from ._results import (
    ClickResult, CloseResult, CommandsResult, ConnectResult, DownloadResult, EvalResult, FetchResult, GotoResult, HoverResult,
    LaunchResult, NetResult, OpenResult, OutlineResult, PressResult, QuitResult, RecordResult, ShotResult, StatusResult, StopResult,
    TabsResult, TextResult, TypeResult, WindowResult,
)

PathLike = Union[str, "os.PathLike[str]"]
R = TypeVar("R")

MIN_NODE_MAJOR = 26

#: How long a call may run, in seconds, by default. `launch` and `net` add their own waiting time.
DEFAULT_TIMEOUT = 120.0

#: `launch` waits up to 10 minutes for the operator to turn remote debugging on.
LAUNCH_WAIT = 600.0

#: `record` runs at most 30 minutes (the CLI's limit), then encodes the MP4.
RECORD_WAIT = 1800.0 + 900.0


def default_package_dir() -> Optional[Path]:
    """The checkout this adapter came from (python/agent_browser/ is two levels below it), if it holds the CLI."""
    root = Path(__file__).resolve().parents[2]
    return root if _is_package(root) else None


def _is_package(path: Path) -> bool:
    try:
        name = json.loads((path / "package.json").read_text(encoding="utf-8")).get("name")
    except (OSError, ValueError, AttributeError):
        return False
    return name == "agent-browser" and (path / "bin" / "agent-browser.js").is_file()


class AgentBrowser:
    """This consumer's agent browser, driven through the `agent-browser` CLI.

    state_dir and allowlist belong to this consumer alone: its own Chrome profile (its cookies and
    logins), tab names and proxy socket live under state_dir. The allowlist file is read, never
    written. `node` is the Node 26+ binary, and `package_dir` the agent-browser package folder
    (default: the checkout this module is in).
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
        endpoint: Optional[str] = None,
        personal_user_data_dir: Optional[PathLike] = None,
        no_launch: bool = False,
        no_prompt: bool = False,
        notify_command: Optional[Sequence[str]] = None,
        proxy_idle_ms: Optional[int] = None,
        command_name: Optional[str] = None,
        node: str = "node",
        package_dir: Optional[PathLike] = None,
        timeout: float = DEFAULT_TIMEOUT,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        if mode not in ("agent", "personal"):
            raise ValueError(f'mode must be "agent" or "personal", not {mode!r}')
        if notify_command is not None and (isinstance(notify_command, str) or not all(isinstance(a, str) for a in notify_command) or not notify_command):
            raise ValueError("notify_command must be a non-empty sequence of strings (an argv list, not a shell string)")
        self.state_dir = Path(state_dir)
        self.allowlist = Path(allowlist) if allowlist is not None else None
        self.profile = Path(profile) if profile is not None else None
        self.socket = Path(socket) if socket is not None else None
        self.mode: Literal["agent", "personal"] = mode
        self.chrome_bin = Path(chrome_bin) if chrome_bin is not None else None
        self.endpoint = endpoint
        self.personal_user_data_dir = Path(personal_user_data_dir) if personal_user_data_dir is not None else None
        self.no_launch = no_launch
        self.no_prompt = no_prompt
        self.notify_command: Optional[List[str]] = list(notify_command) if notify_command is not None else None
        self.proxy_idle_ms = proxy_idle_ms
        self.command_name = command_name
        self.node = node
        self.package_dir = Path(package_dir) if package_dir is not None else None
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

    def _global_flags(self) -> List[str]:
        flags = ["--state-dir", os.fspath(self.state_dir)]
        paths: List[Tuple[str, Optional[Path]]] = [("--allowlist", self.allowlist), ("--profile", self.profile), ("--socket", self.socket),
                                                   ("--chrome-bin", self.chrome_bin), ("--personal-user-data-dir", self.personal_user_data_dir)]
        for flag, path in paths:
            if path is not None:
                flags += [flag, os.fspath(path)]
        if self.mode != "agent":
            flags += ["--mode", self.mode]
        if self.endpoint is not None:
            flags += ["--endpoint", self.endpoint]
        if self.no_launch:
            flags.append("--no-launch")
        if self.no_prompt:
            flags.append("--no-prompt")
        if self.notify_command is not None:
            flags += ["--notify-command", json.dumps(self.notify_command)]
        if self.proxy_idle_ms is not None:
            flags += ["--proxy-idle-ms", str(self.proxy_idle_ms)]
        if self.command_name is not None:
            flags += ["--command-name", self.command_name]
        return flags

    def _run(self, command: str, args: Sequence[str], parse: Callable[[Mapping[str, object]], R], *, stdin: Optional[str] = None,
             extra_timeout: float = 0.0, global_flags: bool = True) -> R:
        if self._node_checked is None:
            self.node_version()
            self._node_checked = self._node_path()
        argv = [self._node_checked, os.fspath(self._bin()), command, *args, *(self._global_flags() if global_flags else []), "--json"]
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

    def window(self, pin: Optional[str] = None, unpin: bool = False) -> WindowResult:
        """Show the pinned window; `pin` pins the window that holds that tab; `unpin` clears the pin."""
        if pin is not None and unpin:
            raise ValueError("window: pin or unpin, not both")
        return self._run("window", ["pin", pin] if pin is not None else ["unpin"] if unpin else [], WindowResult.from_json)

    def tabs(self) -> TabsResult:
        """Allowlisted tabs only (other tabs are never shown)."""
        return self._run("tabs", [], TabsResult.from_json)

    def open(self, url: str, name: Optional[str] = None, tab: bool = False) -> OpenResult:
        """Open an allowlisted URL; `name` remembers the tab; `tab` (personal mode) uses the pinned window."""
        return self._run("open", [url, *(["--name", name] if name is not None else []), *(["--tab"] if tab else [])], OpenResult.from_json)

    def goto(self, tab: str, url: str) -> GotoResult:
        """Navigate a tab to an allowlisted URL."""
        return self._run("goto", [tab, url], GotoResult.from_json)

    def outline(self, tab: str, all: bool = False) -> OutlineResult:
        """Number the interactive elements on screen (`all`: the whole page). Read this before a screenshot."""
        return self._run("outline", [tab, *(["--all"] if all else [])], OutlineResult.from_json)

    def click(self, tab: str, target: Optional[str] = None, text: Optional[str] = None) -> ClickResult:
        """Trusted click on `target` (#N from outline, or a CSS selector), or on the element whose text is `text`."""
        if (target is None) == (text is None):
            raise ValueError("click needs target or text, not both")
        return self._run("click", [tab, target] if target is not None else [tab, "--text", text or ""], ClickResult.from_json)

    def hover(self, tab: str, target: str) -> HoverResult:
        """Move the mouse over `target` (#N or a CSS selector)."""
        return self._run("hover", [tab, target], HoverResult.from_json)

    def type(self, tab: str, text: str, into: Optional[str] = None) -> TypeResult:
        """Type `text` into `into` (else the focused field); fails when the text did not arrive. The text goes on stdin, never into argv."""
        return self._run("type", [tab, "--stdin", *(["--into", into] if into is not None else [])], TypeResult.from_json, stdin=text)

    def press(self, tab: str, key: str) -> PressResult:
        """Press Enter, Tab, Escape, Backspace, Delete, an arrow key, Home, End, PageUp, PageDown or F2."""
        return self._run("press", [tab, key], PressResult.from_json)

    def text(self, tab: str, selector: Optional[str] = None) -> TextResult:
        """Visible text of the page, or of `selector` (#N or CSS). Read this before a screenshot."""
        return self._run("text", [tab, *([selector] if selector is not None else [])], TextResult.from_json)

    # Not Python's eval(): the CLI runs the expression inside the allowlisted page (CDP Runtime.evaluate).
    def eval(self, tab: str, expression: str) -> EvalResult:
        """Evaluate a JavaScript expression in the page and return its JSON value. The expression goes on stdin."""
        return self._run("eval", [tab, "--stdin"], EvalResult.from_json, stdin=expression)

    def shot(self, tab: str, path: Optional[PathLike] = None, full: bool = False, size: Optional[str] = None,
             scale: Optional[float] = None) -> ShotResult:
        """A PNG screenshot, refused until outline or text has read the page at its current URL.

        `size` ("1920x1080", CSS pixels) and `scale` (the device pixel ratio) lay the page out at exactly
        that size for the shot only, so the PNG is width x scale by height x scale pixels.
        """
        args = [tab, *([os.fspath(path)] if path is not None else []), *(["--full"] if full else [])]
        if size is not None:
            args += ["--size", size]
        if scale is not None:
            args += ["--scale", repr(float(scale))]
        return self._run("shot", args, ShotResult.from_json)

    def fetch(self, tab: str, url: str, path: PathLike) -> FetchResult:
        """Save `url` with the page's fetch() and cookies (same-origin and CORS rules apply)."""
        return self._run("fetch", [tab, url, os.fspath(path)], FetchResult.from_json)

    def download(self, tab: str, url: str, path: PathLike) -> DownloadResult:
        """Save `url` through Chrome's network stack (cross-origin CDN media)."""
        return self._run("download", [tab, url, os.fspath(path)], DownloadResult.from_json)

    def close(self, tab: str) -> CloseResult:
        """Close a tab."""
        return self._run("close", [tab], CloseResult.from_json)

    def net(self, tab: str, seconds: Optional[float] = None, match: Optional[str] = None, max: Optional[int] = None) -> NetResult:
        """Record the tab's fetch/XHR/WebSocket traffic for `seconds` (default 60); never headers, bodies redacted."""
        args = [tab]
        if seconds is not None:
            args += ["--seconds", repr(float(seconds))]
        if match is not None:
            args += ["--match", match]
        if max is not None:
            args += ["--max", str(int(max))]
        return self._run("net", args, NetResult.from_json, extra_timeout=60.0 if seconds is None else float(seconds))

    def record(self, tab: str, out: PathLike, script: Optional[PathLike] = None, setup: Optional[PathLike] = None, size: Optional[str] = None,
               fps: Optional[int] = None, scale: Optional[float] = None, no_cursor: bool = False, settle: Optional[float] = None,
               seed: Optional[int] = None, ffmpeg: Optional[PathLike] = None) -> RecordResult:
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
        return self._run("record", args, RecordResult.from_json, extra_timeout=RECORD_WAIT)

    def commands(self) -> CommandsResult:
        """Every CLI command with its parameters (the CLI's own description of itself)."""
        return self._run("commands", [], CommandsResult.from_json, global_flags=False)

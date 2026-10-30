"""Typed results: one dataclass for each CLI command's JSON document.

Each `from_json` checks the shape strictly and raises ProtocolError on any difference, so a CLI and
an adapter from different commits fail loudly instead of returning wrong values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Literal, Mapping, Optional, TypeVar, Union, cast

from ._errors import ProtocolError

JSONValue = Union[None, bool, int, float, str, List["JSONValue"], Dict[str, "JSONValue"]]
Mode = Literal["agent", "personal"]

T = TypeVar("T")


def _obj(value: object, where: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{where}: expected an object, got {type(value).__name__}")
    return cast(Mapping[str, object], value)


def _field(d: Mapping[str, object], key: str, where: str) -> object:
    if key not in d:
        raise ProtocolError(f"{where}: missing field {key!r}")
    return d[key]


def _str(d: Mapping[str, object], key: str, where: str) -> str:
    v = _field(d, key, where)
    if not isinstance(v, str):
        raise ProtocolError(f"{where}.{key}: expected a string")
    return v


def _opt_str(d: Mapping[str, object], key: str, where: str) -> Optional[str]:
    v = _field(d, key, where)
    if v is not None and not isinstance(v, str):
        raise ProtocolError(f"{where}.{key}: expected a string or null")
    return v


def _bool(d: Mapping[str, object], key: str, where: str) -> bool:
    v = _field(d, key, where)
    if not isinstance(v, bool):
        raise ProtocolError(f"{where}.{key}: expected a boolean")
    return v


def _int(d: Mapping[str, object], key: str, where: str) -> int:
    v = _field(d, key, where)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ProtocolError(f"{where}.{key}: expected an integer")
    return v


def _opt_int(d: Mapping[str, object], key: str, where: str) -> Optional[int]:
    return None if _field(d, key, where) is None else _int(d, key, where)


def _num(d: Mapping[str, object], key: str, where: str) -> float:
    v = _field(d, key, where)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ProtocolError(f"{where}.{key}: expected a number")
    return float(v)


def _list(d: Mapping[str, object], key: str, where: str, item: Callable[[object, str], T]) -> List[T]:
    v = _field(d, key, where)
    if not isinstance(v, list):
        raise ProtocolError(f"{where}.{key}: expected a list")
    return [item(x, f"{where}.{key}[{i}]") for i, x in enumerate(v)]


def _string_item(v: object, where: str) -> str:
    if not isinstance(v, str):
        raise ProtocolError(f"{where}: expected a string")
    return v


def _one_of(d: Mapping[str, object], key: str, where: str, allowed: tuple[str, ...]) -> str:
    v = _str(d, key, where)
    if v not in allowed:
        raise ProtocolError(f"{where}.{key}: expected one of {', '.join(allowed)}")
    return v


@dataclass(frozen=True)
class TabRef:
    """An allowlisted tab: `id` is the first 8 characters of `target_id`."""

    id: str
    target_id: str
    name: Optional[str]
    url: str
    title: str

    @classmethod
    def from_json(cls, value: object, where: str = "tab") -> "TabRef":
        d = _obj(value, where)
        return cls(id=_str(d, "id", where), target_id=_str(d, "targetId", where), name=_opt_str(d, "name", where),
                   url=_str(d, "url", where), title=_str(d, "title", where))


def _tab(d: Mapping[str, object], where: str) -> TabRef:
    return TabRef.from_json(_field(d, "tab", where), f"{where}.tab")


def _opt_tab_list(d: Mapping[str, object], key: str, where: str) -> List[TabRef]:
    return _list(d, key, where, TabRef.from_json)


@dataclass(frozen=True)
class LaunchError:
    url: str
    error: str

    @classmethod
    def from_json(cls, value: object, where: str) -> "LaunchError":
        d = _obj(value, where)
        return cls(url=_str(d, "url", where), error=_str(d, "error", where))


@dataclass(frozen=True)
class LaunchResult:
    started: bool
    endpoint: str
    profile_dir: str
    login: bool
    opened: List[str]
    errors: List[LaunchError]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "launch") -> "LaunchResult":
        return cls(started=_bool(d, "started", where), endpoint=_str(d, "endpoint", where), profile_dir=_str(d, "profileDir", where),
                   login=_bool(d, "login", where), opened=_list(d, "opened", where, _string_item),
                   errors=_list(d, "errors", where, LaunchError.from_json))


@dataclass(frozen=True)
class QuitResult:
    proxy_stopped: bool
    chrome_pid: Optional[int]
    closed: bool

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "quit") -> "QuitResult":
        return cls(proxy_stopped=_bool(d, "proxyStopped", where), chrome_pid=_opt_int(d, "chromePid", where), closed=_bool(d, "closed", where))


@dataclass(frozen=True)
class ProxyInfo:
    pid: int
    upstream: str


@dataclass(frozen=True)
class Notification:
    delivery: Literal["queued", "unconfirmed"]
    detail: str


@dataclass(frozen=True)
class StatusResult:
    """`connected` is False when no existing proxy works; then `detail` explains, and the tab counts are None."""

    connected: bool
    mode: Mode
    target: str
    detail: Optional[str]
    product: Optional[str]
    proxy: Optional[ProxyInfo]
    profile_dir: Optional[str]
    allowed_tabs: Optional[int]
    other_tabs: Optional[int]
    allowlist: List[str]
    window: Optional[int]
    notification: Optional[Notification]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "status") -> "StatusResult":
        proxy_value = _field(d, "proxy", where)
        proxy = None
        if proxy_value is not None:
            p = _obj(proxy_value, f"{where}.proxy")
            proxy = ProxyInfo(pid=_int(p, "pid", f"{where}.proxy"), upstream=_str(p, "upstream", f"{where}.proxy"))
        notification_value = _field(d, "notification", where)
        notification = None
        if notification_value is not None:
            n = _obj(notification_value, f"{where}.notification")
            delivery = cast(Literal["queued", "unconfirmed"], _one_of(n, "delivery", f"{where}.notification", ("queued", "unconfirmed")))
            notification = Notification(delivery=delivery, detail=_str(n, "detail", f"{where}.notification"))
        return cls(connected=_bool(d, "connected", where), mode=cast(Mode, _one_of(d, "mode", where, ("agent", "personal"))),
                   target=_str(d, "target", where), detail=_opt_str(d, "detail", where), product=_opt_str(d, "product", where),
                   proxy=proxy, profile_dir=_opt_str(d, "profileDir", where), allowed_tabs=_opt_int(d, "allowedTabs", where),
                   other_tabs=_opt_int(d, "otherTabs", where), allowlist=_list(d, "allowlist", where, _string_item),
                   window=_opt_int(d, "window", where), notification=notification)


@dataclass(frozen=True)
class ConnectResult:
    endpoint: str
    product: str

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "connect") -> "ConnectResult":
        return cls(endpoint=_str(d, "endpoint", where), product=_str(d, "product", where))


@dataclass(frozen=True)
class StopResult:
    stopped: bool

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "stop") -> "StopResult":
        return cls(stopped=_bool(d, "stopped", where))


@dataclass(frozen=True)
class WindowResult:
    window: Optional[int]
    tabs: List[TabRef]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "window") -> "WindowResult":
        return cls(window=_opt_int(d, "window", where), tabs=_opt_tab_list(d, "tabs", where))


@dataclass(frozen=True)
class TabsResult:
    tabs: List[TabRef]
    window: Optional[int]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "tabs") -> "TabsResult":
        return cls(tabs=_opt_tab_list(d, "tabs", where), window=_opt_int(d, "window", where))


@dataclass(frozen=True)
class OpenResult:
    tab: TabRef
    window: Optional[int]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "open") -> "OpenResult":
        return cls(tab=_tab(d, where), window=_opt_int(d, "window", where))


@dataclass(frozen=True)
class GotoResult:
    tab: TabRef

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "goto") -> "GotoResult":
        return cls(tab=_tab(d, where))


@dataclass(frozen=True)
class OutlineElement:
    """One numbered element: click it with `#<index>`."""

    index: int
    role: str
    type: Optional[str]
    label: str
    href: Optional[str]

    @classmethod
    def from_json(cls, value: object, where: str) -> "OutlineElement":
        d = _obj(value, where)
        return cls(index=_int(d, "index", where), role=_str(d, "role", where), type=_opt_str(d, "type", where),
                   label=_str(d, "label", where), href=_opt_str(d, "href", where))


@dataclass(frozen=True)
class OutlineResult:
    tab: TabRef
    elements: List[OutlineElement]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "outline") -> "OutlineResult":
        return cls(tab=_tab(d, where), elements=_list(d, "elements", where, OutlineElement.from_json))


@dataclass(frozen=True)
class ClickResult:
    tab: TabRef
    target: Optional[str]
    text: Optional[str]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "click") -> "ClickResult":
        return cls(tab=_tab(d, where), target=_opt_str(d, "target", where), text=_opt_str(d, "text", where))


@dataclass(frozen=True)
class HoverResult:
    tab: TabRef
    target: str

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "hover") -> "HoverResult":
        return cls(tab=_tab(d, where), target=_str(d, "target", where))


@dataclass(frozen=True)
class TypeResult:
    """The typed text itself is never echoed: only its length."""

    tab: TabRef
    into: Optional[str]
    length: int

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "type") -> "TypeResult":
        return cls(tab=_tab(d, where), into=_opt_str(d, "into", where), length=_int(d, "length", where))


@dataclass(frozen=True)
class PressResult:
    tab: TabRef
    key: str

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "press") -> "PressResult":
        return cls(tab=_tab(d, where), key=_str(d, "key", where))


@dataclass(frozen=True)
class TextResult:
    tab: TabRef
    selector: Optional[str]
    text: str

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "text") -> "TextResult":
        return cls(tab=_tab(d, where), selector=_opt_str(d, "selector", where), text=_str(d, "text", where))


@dataclass(frozen=True)
class EvalResult:
    tab: TabRef
    value: JSONValue

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "eval") -> "EvalResult":
        return cls(tab=_tab(d, where), value=cast(JSONValue, _field(d, "value", where)))


@dataclass(frozen=True)
class ShotResult:
    tab: TabRef
    path: str
    full_page: bool

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "shot") -> "ShotResult":
        return cls(tab=_tab(d, where), path=_str(d, "path", where), full_page=_bool(d, "fullPage", where))


@dataclass(frozen=True)
class FetchResult:
    tab: TabRef
    url: str
    path: str
    bytes: int
    content_type: str

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "fetch") -> "FetchResult":
        return cls(tab=_tab(d, where), url=_str(d, "url", where), path=_str(d, "path", where), bytes=_int(d, "bytes", where),
                   content_type=_str(d, "contentType", where))


@dataclass(frozen=True)
class DownloadResult:
    tab: TabRef
    url: str
    path: str
    bytes: int
    status: int

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "download") -> "DownloadResult":
        return cls(tab=_tab(d, where), url=_str(d, "url", where), path=_str(d, "path", where), bytes=_int(d, "bytes", where),
                   status=_int(d, "status", where))


@dataclass(frozen=True)
class CloseResult:
    tab: TabRef

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "close") -> "CloseResult":
        return cls(tab=_tab(d, where))


@dataclass(frozen=True)
class NetHttp:
    """A fetch/XHR/EventSource request. Headers are never recorded; bodies are redacted and clipped."""

    method: str
    url: str
    body: Optional[str]
    status: Optional[int]
    mime: Optional[str]
    resp: Optional[str]


@dataclass(frozen=True)
class NetWs:
    """A WebSocket frame, redacted and clipped."""

    direction: Literal["recv", "sent"]
    data: Optional[str]


NetEntry = Union[NetHttp, NetWs]


def _net_entry(value: object, where: str) -> NetEntry:
    d = _obj(value, where)
    kind = _one_of(d, "kind", where, ("http", "ws"))
    if kind == "http":
        return NetHttp(method=_str(d, "method", where), url=_str(d, "url", where), body=_opt_str(d, "body", where),
                       status=_opt_int(d, "status", where), mime=_opt_str(d, "mime", where), resp=_opt_str(d, "resp", where))
    direction = cast(Literal["recv", "sent"], _one_of(d, "direction", where, ("recv", "sent")))
    return NetWs(direction=direction, data=_opt_str(d, "data", where))


@dataclass(frozen=True)
class NetResult:
    tab: TabRef
    seconds: float
    entries: List[NetEntry]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "net") -> "NetResult":
        return cls(tab=_tab(d, where), seconds=_num(d, "seconds", where), entries=_list(d, "entries", where, _net_entry))


def _opt_num(d: Mapping[str, object], key: str, where: str) -> Optional[float]:
    return _num(d, key, where) if key in d else None


def _num_item(v: object, where: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ProtocolError(f"{where}: expected a number")
    return float(v)


@dataclass(frozen=True)
class RecordEvent:
    """When a recorded step ran, in seconds from the first frame of the MP4.

    `press` is a click's press; `keys` holds each key of a press step; `first` and `last` are a type
    step's first and last character; `requests` is how many matching requests a waitIdle step saw;
    `changes` and `settled` are how many times a waitStill box changed and when it last changed;
    `changed` is when a waitChange box changed. Each is None for the other kinds of step.
    """

    step: int
    kind: str
    start: float
    end: float
    press: Optional[float] = None
    keys: Optional[List[float]] = None
    first: Optional[float] = None
    last: Optional[float] = None
    requests: Optional[int] = None
    changes: Optional[int] = None
    settled: Optional[float] = None
    changed: Optional[float] = None

    @classmethod
    def from_json(cls, value: object, where: str) -> "RecordEvent":
        d = _obj(value, where)
        return cls(step=_int(d, "step", where), kind=_str(d, "kind", where), start=_num(d, "start", where), end=_num(d, "end", where),
                   press=_opt_num(d, "press", where), keys=_list(d, "keys", where, _num_item) if "keys" in d else None,
                   first=_opt_num(d, "first", where), last=_opt_num(d, "last", where),
                   requests=_int(d, "requests", where) if "requests" in d else None,
                   changes=_int(d, "changes", where) if "changes" in d else None, settled=_opt_num(d, "settled", where),
                   changed=_opt_num(d, "changed", where))


@dataclass(frozen=True)
class RecordResult:
    """A recording: the MP4 (`path`), its provenance JSON beside it, the sizes, and when each step ran."""

    tab: TabRef
    path: str
    provenance: str
    width: int
    height: int
    scale: float
    fps: int
    video_width: int
    video_height: int
    frames: int
    seconds: float
    max_frame_gap_ms: int
    steps: int
    events: List[RecordEvent]
    warnings: List[str]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "record") -> "RecordResult":
        return cls(tab=_tab(d, where), path=_str(d, "path", where), provenance=_str(d, "provenance", where), width=_int(d, "width", where),
                   height=_int(d, "height", where), scale=_num(d, "scale", where), fps=_int(d, "fps", where),
                   video_width=_int(d, "videoWidth", where), video_height=_int(d, "videoHeight", where), frames=_int(d, "frames", where),
                   seconds=_num(d, "seconds", where), max_frame_gap_ms=_int(d, "maxFrameGapMs", where), steps=_int(d, "steps", where),
                   events=_list(d, "events", where, RecordEvent.from_json), warnings=_list(d, "warnings", where, _string_item))


@dataclass(frozen=True)
class ParamSpec:
    """A command parameter: `name` is camelCase in JSON; the Python method takes its snake_case form."""

    name: str
    type: Literal["string", "boolean", "number"]
    required: bool
    cli: str
    stdin: bool
    description: str

    @classmethod
    def from_json(cls, value: object, where: str) -> "ParamSpec":
        d = _obj(value, where)
        stdin = d.get("stdin", False)
        if not isinstance(stdin, bool):
            raise ProtocolError(f"{where}.stdin: expected a boolean")
        kind = cast(Literal["string", "boolean", "number"], _one_of(d, "type", where, ("string", "boolean", "number")))
        return cls(name=_str(d, "name", where), type=kind, required=_bool(d, "required", where), cli=_str(d, "cli", where),
                   stdin=stdin, description=_str(d, "description", where))


@dataclass(frozen=True)
class CommandSpec:
    name: str
    summary: str
    usage: str
    params: List[ParamSpec]

    @classmethod
    def from_json(cls, value: object, where: str) -> "CommandSpec":
        d = _obj(value, where)
        return cls(name=_str(d, "name", where), summary=_str(d, "summary", where), usage=_str(d, "usage", where),
                   params=_list(d, "params", where, ParamSpec.from_json))


@dataclass(frozen=True)
class CommandsResult:
    commands: List[CommandSpec]

    @classmethod
    def from_json(cls, d: Mapping[str, object], where: str = "commands") -> "CommandsResult":
        return cls(commands=_list(d, "commands", where, CommandSpec.from_json))

"""Python adapter for agent-browser: typed methods that run the `agent-browser` CLI.

    from agent_browser import AgentBrowser

    browser = AgentBrowser(state_dir="/abs/state/browser", allowlist="/abs/config/allow.json")
    tab = browser.open("https://example.org/", name="work").tab
    for element in browser.outline("work").elements:
        print(element.index, element.role, element.label)

Python 3.10+, standard library only. Needs Node 26+ and the agent-browser package folder.
"""

from ._client import DEFAULT_TIMEOUT, MIN_NODE_MAJOR, AgentBrowser, default_package_dir
from ._errors import (
    AgentBrowserError, ChromeUnreachableError, CLIError, NodeNotFoundError, NodeVersionError, NotAllowedError, PackageNotFoundError,
    PinRequiredError, ProtocolError, ReadFirstError, TabNotFoundError, UsageError,
)
from ._results import (
    ClickResult, CloseResult, CommandSpec, CommandsResult, ConnectResult, DownloadResult, EvalResult, FetchResult, GotoResult,
    HoverResult, JSONValue, LaunchError, LaunchResult, NetEntry, NetHttp, NetResult, NetWs, Notification, OpenResult,
    OutlineElement, OutlineResult, ParamSpec, PressResult, ProxyInfo, QuitResult, ShotResult, StatusResult, StopResult, TabRef,
    TabsResult, TextResult, TypeResult, WindowResult,
)

__version__ = "0.1.6"

__all__ = [
    "AgentBrowser", "DEFAULT_TIMEOUT", "MIN_NODE_MAJOR", "default_package_dir",
    "AgentBrowserError", "ChromeUnreachableError", "CLIError", "NodeNotFoundError", "NodeVersionError", "NotAllowedError",
    "PackageNotFoundError", "PinRequiredError", "ProtocolError", "ReadFirstError", "TabNotFoundError", "UsageError",
    "ClickResult", "CloseResult", "CommandSpec", "CommandsResult", "ConnectResult", "DownloadResult", "EvalResult", "FetchResult",
    "GotoResult", "HoverResult", "JSONValue", "LaunchError", "LaunchResult", "NetEntry", "NetHttp", "NetResult", "NetWs",
    "Notification", "OpenResult", "OutlineElement", "OutlineResult", "ParamSpec", "PressResult", "ProxyInfo", "QuitResult",
    "ShotResult", "StatusResult", "StopResult", "TabRef", "TabsResult", "TextResult", "TypeResult", "WindowResult",
]

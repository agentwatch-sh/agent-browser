"""Python adapter for agent-browser: typed methods that run the `agent-browser` CLI.

    from agent_browser import AgentBrowser

    browser = AgentBrowser(state_dir="/abs/state/browser", allowlist="/abs/config/allow.json",
                           cdp_url="ws+unix:///abs/run/relay.sock:/devtools/browser/my-session")
    tab = browser.open("https://example.org/", name="work").tab
    for element in browser.outline("work").elements:
        print(element.index, element.role, element.label)

`cdp_url` is agent mode's endpoint (from `agentwatch browser endpoint`): the only way to drive the agent browser.
Python 3.10+, standard library only. Needs Node 26+ and the agent-browser package folder.
"""

from ._client import DEFAULT_TIMEOUT, MIN_NODE_MAJOR, AgentBrowser, default_package_dir
from ._errors import (
    AgentBrowserError, ChromeUnreachableError, CLIError, NodeNotFoundError, NodeVersionError, NotAllowedError, PackageNotFoundError,
    ProtocolError, ReadFirstError, TabNotFoundError, UsageError,
)
from ._results import (
    CapturedDownload, ClickResult, CloseResult, CommandSpec, CommandsResult, DownloadResult, EvalResult, FetchResult,
    GotoResult, HoverResult, JSONValue, NetEntry, NetHttp, NetResult, NetWs, OpenResult,
    OutlineElement, OutlineResult, ParamSpec, PressResult, RecordEvent, RecordResult, ShotResult, StatusResult,
    TabRef, TabsResult, TextResult, TypeResult, WindowResult,
)

__version__ = "0.2.9"

__all__ = [
    "AgentBrowser", "DEFAULT_TIMEOUT", "MIN_NODE_MAJOR", "default_package_dir",
    "AgentBrowserError", "ChromeUnreachableError", "CLIError", "NodeNotFoundError", "NodeVersionError", "NotAllowedError",
    "PackageNotFoundError", "ProtocolError", "ReadFirstError", "TabNotFoundError", "UsageError",
    "CapturedDownload", "ClickResult", "CloseResult", "CommandSpec", "CommandsResult", "DownloadResult", "EvalResult",
    "FetchResult", "GotoResult", "HoverResult", "JSONValue", "NetEntry", "NetHttp", "NetResult", "NetWs",
    "OpenResult", "OutlineElement", "OutlineResult", "ParamSpec", "PressResult",
    "RecordEvent", "RecordResult", "ShotResult", "StatusResult", "TabRef", "TabsResult", "TextResult", "TypeResult", "WindowResult",
]

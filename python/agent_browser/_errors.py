"""Exceptions of the Python adapter.

Every exception is an AgentBrowserError. A failed CLI call raises a CLIError subclass chosen by the
stable error code in the CLI's JSON document, so callers never match on English text.
"""

from __future__ import annotations

from typing import Dict, Optional, Type


class AgentBrowserError(Exception):
    """Base class of every error this package raises."""


class NodeNotFoundError(AgentBrowserError):
    """The node binary is missing or cannot run."""


class NodeVersionError(AgentBrowserError):
    """The node binary is older than Node 26 (the package needs its TypeScript type stripping)."""


class PackageNotFoundError(AgentBrowserError):
    """The agent-browser Node package folder (with bin/agent-browser.js) was not found."""


class ProtocolError(AgentBrowserError):
    """The CLI's output is not the one JSON document of the expected shape."""

    def __init__(self, message: str, *, stdout: str = "", stderr: str = "", exit_status: Optional[int] = None) -> None:
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.exit_status = exit_status


class CLIError(AgentBrowserError):
    """The CLI ran and reported a failure: `code` is its stable error code."""

    def __init__(self, code: str, message: str, *, command: Optional[str], exit_status: Optional[int], stderr: str) -> None:
        super().__init__(f"{command or 'agent-browser'}: {message}")
        self.code = code
        self.message = message
        self.command = command
        self.exit_status = exit_status
        self.stderr = stderr


class UsageError(CLIError):
    """code "usage": a command line or option that cannot run as given."""


class NotAllowedError(CLIError):
    """code "not_allowed": a URL or tab off the allowlist (or a mail, account or admin host)."""


class PinRequiredError(CLIError):
    """code "pin_required": personal mode acts only in the caller's own pinned window."""


class ReadFirstError(CLIError):
    """code "read_first": a screenshot before outline or text read the page at its current URL."""


class TabNotFoundError(CLIError):
    """code "tab_not_found": no allowlisted tab matches the reference."""


class ChromeUnreachableError(CLIError):
    """code "unreachable": no Chrome endpoint answered and no proxy could start."""


ERRORS_BY_CODE: Dict[str, Type[CLIError]] = {
    "usage": UsageError,
    "not_allowed": NotAllowedError,
    "pin_required": PinRequiredError,
    "read_first": ReadFirstError,
    "tab_not_found": TabNotFoundError,
    "unreachable": ChromeUnreachableError,
}

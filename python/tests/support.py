"""Test support: the fake Chrome process (test/fake-chrome-main.ts) and stand-in node binaries."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node") or "node"


@dataclass
class FakeChrome:
    """The fake Chrome and its fixture site, in a node process that ends when its stdin closes."""

    proc: "subprocess.Popen[bytes]"
    ws: str
    base: str
    control: str

    @classmethod
    def start(cls) -> "FakeChrome":
        proc = subprocess.Popen([NODE, str(ROOT / "test" / "fake-chrome-main.ts")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=ROOT)
        assert proc.stdout is not None
        info = json.loads(proc.stdout.readline())
        return cls(proc=proc, ws=info["ws"], base=info["base"], control=info["control"])

    def stop(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        if self.proc.stdout is not None:
            self.proc.stdout.close()

    def _post(self, path: str, body: Optional[Dict[str, object]] = None) -> Dict[str, object]:
        data = json.dumps(body or {}).encode()
        with urllib.request.urlopen(urllib.request.Request(self.control + path, data=data, method="POST")) as r:
            result: Dict[str, object] = json.loads(r.read())
            return result

    def add_page(self, url: str) -> str:
        """A tab "the operator" opened by hand; returns its target id."""
        return str(self._post("/page?url=" + urllib.parse.quote(url, safe=""))["targetId"])

    def traffic(self, target: str, **request: object) -> None:
        self._post("/traffic", {"target": target, **request})

    def calls(self, target: str) -> List[Dict[str, object]]:
        with urllib.request.urlopen(self.control + "/calls?target=" + target) as r:
            result: List[Dict[str, object]] = json.loads(r.read())
            return result


class Consumer:
    """A consumer of its own: a short temp folder (socket paths stay under 104 bytes) and an allowlist."""

    def __init__(self, allow: Optional[List[str]] = None) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="ab-py-"))
        self.state_dir = self.dir / "state"
        self.allowlist = self.dir / "allow.json"
        self.allowlist.write_text(json.dumps({"allow": allow or ["127.0.0.1"]}))

    def remove(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def stand_in_node(folder: Path, name: str, version: str, output: str) -> Path:
    """A script that answers `--version` with `version` and anything else with `output` (exit 0)."""
    path = folder / name
    path.write_text(
        "#!/bin/sh\n"
        f'if [ "$1" = "--version" ]; then echo {version}; exit 0; fi\n'
        f"cat <<'OUT'\n{output}\nOUT\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def no_proxies_left() -> bool:
    out = subprocess.run(["ps", "axww", "-o", "command="], capture_output=True, text=True, check=True).stdout
    return not any("agent-browser.js proxy" in line and os.fspath(tempfile.gettempdir()) in line for line in out.splitlines())

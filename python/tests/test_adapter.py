"""The Python adapter against the real CLI and the fake Chrome (no browser starts, no site is contacted)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from agent_browser import (
    AgentBrowser, AgentChrome, ApprovalNeededError, ChromesResult, ClickResult, CLIError, FrontResult, NetHttp, NodeNotFoundError, NodeVersionError,
    NotAllowedError, PackageNotFoundError, PinRequiredError, ProtocolError, ProxyInfo, ReadFirstError, RecordEvent, RecordResult, TabNotFoundError, TabRef,
    UsageError,
)

from .support import FakeChrome, Consumer, ROOT, stand_in_node


class AdapterTest(unittest.TestCase):
    fake: FakeChrome
    consumer: Consumer
    browser: AgentBrowser

    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeChrome.start()
        cls.consumer = Consumer()
        cls.browser = AgentBrowser(cls.consumer.state_dir, cls.consumer.allowlist, endpoint=cls.fake.ws, no_launch=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.stop()
        cls.fake.stop()
        cls.consumer.remove()

    def test_a_full_session_returns_typed_results(self) -> None:
        b, base = self.browser, self.fake.base
        self.assertEqual(b.tabs().tabs, [])
        opened = b.open(base + "/", name="work")
        self.assertIsInstance(opened.tab, TabRef)
        self.assertEqual((opened.tab.name, opened.tab.url, opened.tab.title), ("work", base + "/", "t"))
        self.assertEqual(opened.tab.id, opened.tab.target_id[:8])
        self.assertEqual([t.name for t in b.tabs().tabs], ["work"])

        with self.assertRaises(ReadFirstError) as caught:
            b.shot("work")
        self.assertEqual(caught.exception.code, "read_first")

        outline = b.outline("work")
        self.assertEqual((outline.elements[0].index, outline.elements[0].role, outline.elements[0].label), (1, "button", "Go"))
        self.assertEqual(outline.elements[1].type, "text")
        self.assertTrue(any(e.href == "/next" for e in outline.elements))
        self.assertTrue(any(e.label == "Below the fold" for e in b.outline("work", all=True).elements))

        self.assertIsInstance(b.click("work", "#1"), ClickResult)
        self.assertEqual(b.eval("work", "document.title").value, "clicked")
        self.assertEqual(b.click("work", text="Go").text, "Go")
        self.assertEqual(b.hover("work", "#1").target, "#1")
        self.assertEqual(b.eval("work", "({a: [1, 2], b: null})").value, {"a": [1, 2], "b": None})

        secret = "s3cret-for-the-form"
        calls: List[List[str]] = []
        real_run = subprocess.run

        def recording_run(argv: List[str], *args: object, **kwargs: object) -> object:
            calls.append(list(argv))
            return real_run(argv, *args, **kwargs)  # type: ignore[call-overload]

        with mock.patch("agent_browser._client.subprocess.run", side_effect=recording_run):
            typed = b.type("work", secret, into="#2")
        self.assertEqual((typed.into, typed.length), ("#2", len(secret)))
        self.assertTrue(calls and all(secret not in arg for argv in calls for arg in argv), "the text never goes into argv")
        self.assertEqual(b.eval("work", "document.querySelector('#i').value").value, secret)
        self.assertEqual(b.press("work", "Enter").key, "Enter")

        text = b.text("work")
        self.assertIn("Fixture page", text.text)
        self.assertIsNone(text.selector)
        shot = b.shot("work", self.consumer.dir / "s.png", full=True)
        self.assertTrue(shot.full_page)
        self.assertEqual(Path(shot.path).read_bytes()[:4], b"\x89PNG")

        fetched = b.fetch("work", base + "/small.txt", self.consumer.dir / "small.txt")
        self.assertEqual((fetched.bytes, fetched.content_type), (11, "text/plain"))
        with self.assertRaises(NotAllowedError):
            b.download("work", "https://cdn.elsewhere.invalid/media.bin", self.consumer.dir / "media.bin")
        downloaded = b.download("work", base + "/file.bin", self.consumer.dir / "file.bin")
        self.assertEqual((downloaded.status, downloaded.bytes), (200, 9 * 1024 * 1024 + 123))

        self.assertIsNone(b.window().window)
        pinned = b.window(pin="work")
        self.assertIsInstance(pinned.window, int)
        self.assertEqual([t.name for t in pinned.tabs], ["work"])
        self.assertIsNone(b.window(unpin=True).window)

        self.assertEqual(b.goto("work", base + "/next").tab.title, "next")
        with self.assertRaises(NotAllowedError) as refused:
            b.goto("work", "https://example.com/")
        self.assertEqual(refused.exception.exit_status, 1)
        self.assertIn("example.com is not on the allowlist", refused.exception.message)

        status = b.status()
        self.assertTrue(status.connected)
        self.assertEqual((status.mode, status.product, status.allowed_tabs, status.allowlist), ("agent", "FakeChrome/1.0", 1, ["127.0.0.1"]))
        self.assertIsNotNone(status.proxy)

        self.assertEqual(b.close("work").tab.name, "work")
        with self.assertRaises(TabNotFoundError):
            b.text("work")

    def test_net_returns_redacted_entries(self) -> None:
        b = self.browser
        target = b.open(self.fake.base + "/", name="netted").tab.target_id
        timer = threading.Timer(0.8, lambda: self.fake.traffic(target, method="POST", url=self.fake.base + "/api/x?token=T0K", postData='{"password":"pw"}', body="{}"))
        timer.start()
        try:
            result = b.net("netted", seconds=1.5, match="/api/")
        finally:
            timer.join()
        self.assertEqual(result.seconds, 1.5)
        self.assertEqual(result.entries, [NetHttp(method="POST", url=self.fake.base + "/api/x?token=<redacted>", body='{"password":"<redacted>"}',
                                                  status=200, mime="application/json", resp="{}")])
        b.close("netted")

    @unittest.skipUnless(shutil.which("ffmpeg"), "record needs ffmpeg on PATH")
    def test_record_writes_an_mp4_and_returns_its_events(self) -> None:
        b = self.browser
        b.open(self.fake.base + "/", name="filmed")
        steps = self.consumer.dir / "film-steps.json"
        steps.write_text(json.dumps([{"click": "#b", "duration": 150}, {"type": "hi", "into": "#i", "delay": 10}, {"press": "Enter"}]))
        out = self.consumer.dir / "film" / "clip.mp4"
        result = b.record("filmed", out, script=steps, size="320x240", fps=10, scale=1, settle=100, seed=5)
        self.assertIsInstance(result, RecordResult)
        self.assertEqual((result.path, result.video_width, result.video_height, result.fps, result.steps), (str(out), 320, 240, 10, 3))
        self.assertEqual(result.provenance, str(out.with_suffix(".json")))
        self.assertTrue(out.read_bytes()[4:8] == b"ftyp", "an MP4")
        self.assertEqual([(e.step, e.kind) for e in result.events], [(1, "click"), (2, "type"), (3, "press")])
        self.assertIsInstance(result.events[0], RecordEvent)
        self.assertIsNotNone(result.events[0].press)
        self.assertEqual(len(result.events[2].keys or []), 1)
        self.assertEqual(result.warnings, [])
        self.assertEqual(b.eval("filmed", "document.querySelector('#i').value").value, "hi")
        with self.assertRaises(UsageError):
            b.record("filmed", self.consumer.dir / "film-steps.mp4", script=steps)
        b.close("filmed")

    def test_an_off_list_tab_is_never_listed_or_touched(self) -> None:
        mail = self.fake.add_page("https://mail.example.org/inbox")
        self.assertNotIn(mail, [t.target_id for t in self.browser.tabs().tabs])
        with self.assertRaises(TabNotFoundError):
            self.browser.text("inbox")
        self.assertGreaterEqual(self.browser.status().other_tabs or 0, 1)
        self.assertEqual(self.fake.calls(mail), [])

    def test_personal_mode_needs_its_own_pinned_window(self) -> None:
        other = Consumer()
        personal = AgentBrowser(other.state_dir, other.allowlist, mode="personal", endpoint=self.fake.ws)
        try:
            self.fake.add_page(self.fake.base + "/?operator")
            with self.assertRaises(PinRequiredError):
                personal.text("operator")
            opened = personal.open(self.fake.base + "/", name="mine")
            self.assertIsInstance(opened.window, int)
            self.assertEqual([t.name for t in personal.tabs().tabs], ["mine"])
            with self.assertRaises(UsageError):
                personal.quit()
        finally:
            personal.stop()
            other.remove()

    def test_cdp_url_goes_to_the_cli_in_place_of_the_proxy(self) -> None:
        url = "ws+unix:///run/user/1000/agentwatch/browser-cdp.sock:/devtools/browser/my-repo"
        b = AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, cdp_url=url)
        flags = b._global_flags()
        self.assertEqual(flags[flags.index("--cdp-url") + 1], url)
        self.assertNotIn("--cdp-url", AgentBrowser(self.consumer.state_dir, self.consumer.allowlist)._global_flags())

    def test_click_captures_a_download(self) -> None:
        b = self.browser
        b.open(self.fake.base + "/", name="export-download")
        try:
            result = b.click("export-download", "#dl", download=self.consumer.dir / "downloads", timeout=5000)
            self.assertEqual(result.download.suggested_filename, "out.bin")
            self.assertEqual(result.download.url, self.fake.base + "/file.bin")
            self.assertEqual(Path(result.download.path).stat().st_size, result.download.bytes)
            self.assertGreater(result.download.bytes, 0)
            self.assertIsNone(b.click("export-download", text="Go").download)
            self.assertIsNone(b.click("export-download", "#b", None, True).download,
                              "any_scope keeps its existing fourth positional slot")
            with self.assertRaises(TypeError):
                b.click("export-download", "#b", None, False, self.consumer.dir / "downloads", 5000)
        finally:
            b.close("export-download")

    def test_cli_failures_raise_typed_errors(self) -> None:
        with self.assertRaises(UsageError) as caught:
            self.browser.net("any-tab", seconds=0)
        self.assertEqual((caught.exception.code, caught.exception.exit_status), ("usage", 2))
        with self.assertRaises(TabNotFoundError) as missing:
            self.browser.text("no-such-tab")
        self.assertIsInstance(missing.exception, CLIError)
        with self.assertRaises(ValueError):
            self.browser.click("x")
        with self.assertRaises(ValueError):
            AgentBrowser(self.consumer.state_dir, notify_command="agentwatch inbox")  # a shell string, not an argv list
        no_allowlist = AgentBrowser(self.consumer.state_dir, endpoint=self.fake.ws, no_launch=True)
        with self.assertRaises(UsageError) as caught:
            no_allowlist.tabs()
        self.assertIn("allowlist is required", caught.exception.message)

    def test_no_prompt_fails_at_once_without_an_approved_connection(self) -> None:
        other = Consumer()
        try:
            b = AgentBrowser(other.state_dir, other.allowlist, endpoint=self.fake.ws, no_launch=True, no_prompt=True)
            with self.assertRaises(ApprovalNeededError) as caught:
                b.tabs()
            self.assertEqual(caught.exception.code, "approval_needed")
            self.assertIn("--no-prompt", caught.exception.message)
            self.assertFalse(b.status().connected, "and it started no proxy")
        finally:
            other.remove()

    def test_approve_command_runs_when_the_proxy_connects(self) -> None:
        other = Consumer()
        out = other.dir / "approved.txt"
        b = AgentBrowser(other.state_dir, other.allowlist, endpoint=self.fake.ws, no_launch=True,
                         approve_command=["/bin/sh", "-c", 'echo approved > "$0"', str(out)])
        try:
            self.assertEqual(b.tabs().tabs, [])
            deadline = time.monotonic() + 10
            while not out.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(out.read_text(), "approved\n", "the proxy ran the custom approver as it connected")
        finally:
            b.stop()
            other.remove()

    def test_the_cli_parses_and_checks_the_new_options(self) -> None:
        # Each refusal comes from the CLI's own checks, so the CLI read each flag in the form the adapter sent.
        other = Consumer()
        try:
            with self.assertRaises(UsageError) as personal:
                AgentBrowser(other.state_dir, other.allowlist, mode="personal", endpoint=self.fake.ws, approve="xdotool").tabs()
            self.assertIn("approve is only for the agent browser", personal.exception.message)
            with self.assertRaises(UsageError) as no_program:
                AgentBrowser(other.state_dir, other.allowlist, endpoint=self.fake.ws, no_launch=True, approve_command=["", "--once"]).tabs()
            self.assertIn("approve must be", no_program.exception.message)
            with self.assertRaises(UsageError) as empty_flag:
                AgentBrowser(other.state_dir, other.allowlist, endpoint=self.fake.ws, no_launch=True, chrome_args=["--lang=en-US", ""]).tabs()
            self.assertIn("chromeArgs must be an array of non-empty strings", empty_flag.exception.message)
        finally:
            other.remove()

    def test_status_notify_runs_the_notify_command(self) -> None:
        other = Consumer()
        out = other.dir / "notified.txt"
        b = AgentBrowser(other.state_dir, other.allowlist, endpoint=self.fake.ws, no_launch=True, command_name="agentwatch browser",
                         notify_command=["/bin/sh", "-c", 'cat > "$0"', str(out)])
        try:
            status = b.status(notify=True)
            self.assertFalse(status.connected)
            assert status.notification is not None
            self.assertEqual(status.notification.delivery, "queued")
            self.assertTrue(out.read_text().startswith("agentwatch browser connection needs attention: "))
        finally:
            other.remove()


class OptionArgvTest(unittest.TestCase):
    """The argv the adapter builds for each option. subprocess.run is faked, so no CLI and no Chrome run."""

    def setUp(self) -> None:
        self.consumer = Consumer()

    def tearDown(self) -> None:
        self.consumer.remove()

    def argv(self, **options: Any) -> List[str]:
        """The argv of one `tabs` call with these AgentBrowser options."""
        calls: List[List[str]] = []

        def fake_run(argv: List[str], *args: object, **kwargs: object) -> "subprocess.CompletedProcess[Any]":
            calls.append(list(argv))
            if argv[1:] == ["--version"]:
                return subprocess.CompletedProcess(argv, 0, stdout="v26.0.0\n", stderr="")
            return subprocess.CompletedProcess(argv, 0, stdout=b'{"ok": true, "command": "tabs", "tabs": [], "window": null}\n', stderr=b"")

        with mock.patch("agent_browser._client.subprocess.run", side_effect=fake_run):
            AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, **options).tabs()
        self.assertEqual(calls[-1][2], "tabs")
        return calls[-1]

    def value(self, argv: List[str], flag: str) -> str:
        """The one value that follows `flag` in argv."""
        self.assertEqual(argv.count(flag), 1, f"{flag} once in {argv}")
        return argv[argv.index(flag) + 1]

    def test_no_new_flag_by_default(self) -> None:
        argv = self.argv()
        for flag in ("--approve", "--approve-command", "--chrome-args", "--hidden-drive", "--input-timing"):
            self.assertNotIn(flag, argv)
        self.assertEqual(argv[-1], "--json")

    def test_approve(self) -> None:
        for choice in ("auto", "osascript", "xdotool"):
            self.assertEqual(self.value(self.argv(approve=choice), "--approve"), choice)
        self.assertEqual(self.value(self.argv(approve=True), "--approve"), "auto", "True picks the approver by platform, as in the library")
        argv = self.argv(approve=False)
        self.assertNotIn("--approve", argv)
        self.assertNotIn("--approve-command", argv)

    def test_approve_command(self) -> None:
        command = ["/opt/approve dialog.sh", "--pid", "it's \"quoted\"", "é"]
        argv = self.argv(approve_command=command)
        self.assertEqual(json.loads(self.value(argv, "--approve-command")), command, "one JSON array, every argument kept whole")
        self.assertNotIn("--approve", argv)
        self.assertEqual(json.loads(self.value(self.argv(approve_command=("/opt/approve.sh",)), "--approve-command")), ["/opt/approve.sh"])
        self.assertIn("--approve-command", self.argv(approve=False, approve_command=["/opt/approve.sh"]))

    def test_hidden_drive(self) -> None:
        self.assertEqual(self.argv(hidden_drive=True).count("--hidden-drive"), 1, "a flag with no value")
        self.assertNotIn("--hidden-drive", self.argv(hidden_drive=False))

    def test_input_timing(self) -> None:
        timing = {"pressMs": [70, 90], "moveScale": 0.5}
        self.assertEqual(json.loads(self.value(self.argv(input_timing=timing), "--input-timing")), timing, "one JSON object")
        self.assertNotIn("--input-timing", self.argv(input_timing=None))

    def test_input_commands_wait_for_the_lock_and_the_text(self) -> None:
        """A 1000-character type and a wait for the input lock fit in the call's timeout (about 0.12 s a character on Linux).
        text, outline and eval wait for the lock inside the call's timeout, with the lock's own error (review-52 note 5)."""
        timeouts: Dict[str, float] = {}
        timings: Dict[str, Optional[Dict[str, Any]]] = {}

        def fake_run(argv: List[str], *args: object, **kwargs: Any) -> "subprocess.CompletedProcess[Any]":
            if argv[1:] == ["--version"]:
                return subprocess.CompletedProcess(argv, 0, stdout="v26.0.0\n", stderr="")
            timeouts[argv[2]] = kwargs["timeout"]
            timings[argv[2]] = json.loads(argv[argv.index("--input-timing") + 1]) if "--input-timing" in argv else None
            tab = '"tab": {"id": "a", "targetId": "a", "name": null, "url": "u", "title": "t"}'
            out = {"type": '{"ok": true, "command": "type", ' + tab + ', "into": null, "length": 1000}',
                   "click": '{"ok": true, "command": "click", ' + tab + ', "target": "#b", "text": null}',
                   "text": '{"ok": true, "command": "text", ' + tab + ', "selector": null, "text": "x"}',
                   "outline": '{"ok": true, "command": "outline", ' + tab + ', "elements": []}',
                   "eval": '{"ok": true, "command": "eval", ' + tab + ', "value": 1}'}
            return subprocess.CompletedProcess(argv, 0, stdout=(out[argv[2]] + "\n").encode(), stderr=b"")

        def reads(**options: Any) -> None:
            b = AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, **options)
            b.text("a")
            b.outline("a")
            b.eval("a", "1")

        with mock.patch("agent_browser._client.subprocess.run", side_effect=fake_run):
            b = AgentBrowser(self.consumer.state_dir, self.consumer.allowlist)
            b.type("a", "x" * 1000)
            b.click("a", "#b")
            # A read of a hidden window page brings its tab in front inside the input lock (Tab.toFront), so it can wait for
            # another agent's input. That wait is part of the call's timeout, as Tab.waitFor's is: a read that hangs for
            # another reason fails at the timeout, and a long wait for the lock fails with the lock's own error.
            reads()
        self.assertGreaterEqual(timeouts["type"], 120 + 600 + 1000 * 0.15)
        self.assertGreaterEqual(timeouts["click"], 120 + 600)
        self.assertIsNone(timings["click"], "no --input-timing for an input command by default")
        for read in ("text", "outline", "eval"):
            self.assertEqual(timeouts[read], 120, read)
            self.assertEqual(timings[read], {"lockWaitMs": 90_000}, read)
        with mock.patch("agent_browser._client.subprocess.run", side_effect=fake_run):
            AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, input_timing={"lockWaitMs": 5000, "keyMs": [10, 20]}).type("a", "x" * 1000)
            reads(input_timing={"lockWaitMs": 5000, "keyMs": [10, 20]})
        self.assertAlmostEqual(timeouts["type"], 120 + 5 + 1000 * (20 + 50) / 1000)
        self.assertEqual(timings["text"], {"lockWaitMs": 5000, "keyMs": [10, 20]}, "a shorter lockWaitMs of the caller stays")
        with mock.patch("agent_browser._client.subprocess.run", side_effect=fake_run):
            reads(timeout=20)
        self.assertEqual(timeouts["eval"], 20)
        self.assertEqual(timings["eval"], {"lockWaitMs": 10_000}, "a short timeout: half of it for the lock")

    def test_chrome_args(self) -> None:
        flags = ["--enable-unsafe-swiftshader", "--lang=en-US", "--window-name=a b"]
        argv = self.argv(chrome_args=flags)
        self.assertEqual(json.loads(self.value(argv, "--chrome-args")), flags)
        self.assertFalse(any(arg in argv for arg in flags), "the Chrome flags go inside the one JSON value, never loose in argv")
        self.assertEqual(json.loads(self.value(self.argv(chrome_args=()), "--chrome-args")), [])

    def test_invalid_options_raise_before_any_call(self) -> None:
        state, allowlist = self.consumer.state_dir, self.consumer.allowlist
        bad: List[Dict[str, Any]] = [
            {"approve": "yes"}, {"approve": "XDOTOOL"}, {"approve": 1}, {"approve": ["xdotool"]},
            {"approve_command": "/opt/approve.sh --once"}, {"approve_command": []}, {"approve_command": ["/opt/approve.sh", 1]},
            {"approve_command": {"/opt/approve.sh"}}, {"approve": "xdotool", "approve_command": ["/opt/approve.sh"]},
            {"approve": True, "approve_command": ["/opt/approve.sh"]},
            {"chrome_args": "--lang=en-US"}, {"chrome_args": ["--lang=en-US", None]}, {"chrome_args": b"--lang=en-US"}, {"chrome_args": 3},
            {"hidden_drive": "yes"}, {"hidden_drive": 1},
            {"input_timing": '{"pressMs": [70, 90]}'}, {"input_timing": [["pressMs", [70, 90]]]},
        ]
        with mock.patch("agent_browser._client.subprocess.run") as run:
            for options in bad:
                with self.assertRaises(ValueError, msg=repr(options)):
                    AgentBrowser(state, allowlist, **options)
            run.assert_not_called()


class NodeAndOutputTest(unittest.TestCase):
    def setUp(self) -> None:
        self.consumer = Consumer()
        self.folder = self.consumer.dir

    def tearDown(self) -> None:
        self.consumer.remove()

    def test_missing_node(self) -> None:
        with self.assertRaises(NodeNotFoundError):
            AgentBrowser(self.consumer.state_dir, node=str(self.folder / "no-such-node")).tabs()
        with self.assertRaises(NodeNotFoundError):
            AgentBrowser(self.consumer.state_dir, node="no-such-node-binary-anywhere").commands()

    def test_node_older_than_26(self) -> None:
        old = stand_in_node(self.folder, "node24", "v24.11.0", "{}")
        with self.assertRaises(NodeVersionError) as caught:
            AgentBrowser(self.consumer.state_dir, node=str(old)).tabs()
        self.assertIn("Node 26", str(caught.exception))
        self.assertEqual(AgentBrowser(self.consumer.state_dir).node_version()[0] >= 26, True)

    def test_output_that_is_not_one_json_document(self) -> None:
        for output in ["not json", '{"ok": true, "command": "tabs"}\n{"ok": true, "command": "tabs"}', "[1, 2]"]:
            node = stand_in_node(self.folder, "node-bad", "v26.0.0", output)
            with self.assertRaises(ProtocolError, msg=output):
                AgentBrowser(self.consumer.state_dir, node=str(node)).tabs()

    def test_json_of_the_wrong_shape(self) -> None:
        cases = [
            '{"ok": true, "command": "tabs", "tabs": "x", "window": null}',
            '{"ok": true, "command": "tabs", "tabs": [{"id": "1", "targetId": "1", "name": null, "url": "u"}], "window": null}',
            '{"ok": true, "command": "tabs", "tabs": [], "window": "1"}',
            '{"ok": true, "command": "open", "tab": null, "window": null}',
            '{"ok": false, "command": "tabs", "error": "x"}',
        ]
        for output in cases:
            node = stand_in_node(self.folder, "node-shape", "v26.0.0", output)
            with self.assertRaises(ProtocolError, msg=output):
                AgentBrowser(self.consumer.state_dir, node=str(node)).tabs()

    def test_package_dir(self) -> None:
        self.assertEqual(AgentBrowser(self.consumer.state_dir, package_dir=ROOT).commands().commands[0].name, "launch")
        with self.assertRaises(PackageNotFoundError):
            AgentBrowser(self.consumer.state_dir, package_dir=self.folder).commands()


class EmptyPathTest(unittest.TestCase):
    """An empty path argument is refused before any call: Path("") would be ".", the current folder."""

    def test_an_empty_path_argument_is_a_value_error_before_any_call(self) -> None:
        with mock.patch("agent_browser._client.subprocess.run") as run:
            for name in ("allowlist", "profile", "socket", "chrome_bin", "personal_user_data_dir", "package_dir"):
                with self.assertRaises(ValueError, msg=name) as caught:
                    AgentBrowser("state", **{name: ""})
                self.assertIn(f"{name} is an empty path", str(caught.exception))
            with self.assertRaises(ValueError) as caught:
                AgentBrowser("")
            self.assertIn("state_dir is an empty path", str(caught.exception))
            AgentBrowser("state", profile=Path("."))  # an explicit current folder stays allowed
        run.assert_not_called()


class PathsTest(unittest.TestCase):
    """README, Paths: the adapter passes its paths to the CLI as they are, in the caller's current folder."""

    def test_relative_paths_reach_the_cli_unchanged_and_the_cli_runs_in_the_current_folder(self) -> None:
        calls: List[Any] = []

        def fake_run(argv: List[str], **kwargs: Any) -> "subprocess.CompletedProcess[Any]":
            if argv[1:] == ["--version"]:
                return subprocess.CompletedProcess(argv, 0, stdout="v26.12.0\n", stderr="")
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, stdout=b'{"ok":true,"command":"tabs","tabs":[],"window":null}\n', stderr=b"")

        with mock.patch("agent_browser._client.subprocess.run", side_effect=fake_run):
            AgentBrowser("state", "allow.json", profile="p", socket="s.sock", no_launch=True).tabs()
        [(argv, kwargs)] = calls
        for flag, value in (("--state-dir", "state"), ("--allowlist", "allow.json"), ("--profile", "p"), ("--socket", "s.sock")):
            self.assertEqual(argv[argv.index(flag) + 1], value, flag)
        self.assertNotIn("cwd", kwargs, "the CLI runs in the caller's current folder, so a relative path means the same there")


class ChromesTest(unittest.TestCase):
    """`chromes()` through the real CLI, with a stand-in `ps` first on PATH: the CLI reads crafted rows."""

    def setUp(self) -> None:
        self.consumer = Consumer()
        self.folder = self.consumer.dir

    def tearDown(self) -> None:
        self.consumer.remove()

    def test_chromes_lists_the_agent_chromes_of_this_user_with_typed_fields(self) -> None:
        uid = os.getuid()
        state = self.folder / "state"
        (state / "profile").mkdir(parents=True)
        (state / "chrome-proxy.json").write_text(json.dumps({"pid": 4500, "upstream": "ws://127.0.0.1:9/devtools/browser/p"}))
        launch = "--no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows"
        inspect = "chrome://inspect/#remote-debugging"
        rows = [
            f"{uid:5d}  4100 /opt/google/chrome/chrome {launch} --user-data-dir={state}/profile --window-name=vedlo browser: {state} {inspect}",
            f"{uid:5d}  4101 /opt/google/chrome/chrome --type=renderer --user-data-dir={state}/profile",
            f"{uid:5d}  4200 /opt/google/chrome/chrome {launch} --user-data-dir={self.folder}/old/profile {inspect}",
            f"{uid:5d}  4500 /usr/bin/node /opt/agent-browser/bin/agent-browser.js proxy ws://127.0.0.1:9/devtools/browser/p --state-dir {state} "
            f"--socket {state}/chrome-proxy.sock --profile {state}/profile --mode agent --proxy-idle-ms 1000 --command-name vedlo browser "
            "--attempt a --timeout-ms 1",
            f"{uid + 1:5d}  5100 /opt/google/chrome/chrome {launch} --user-data-dir=/example/other/profile {inspect}",
        ]
        (self.folder / "ps.txt").write_text("\n".join(rows) + "\n")
        bin_dir = self.folder / "bin"
        bin_dir.mkdir()
        (bin_dir / "ps").write_text(f"#!/bin/sh\ncat '{self.folder / 'ps.txt'}'\n")
        (bin_dir / "ps").chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
        result = AgentBrowser(self.consumer.state_dir, env=env).chromes()
        self.assertIsInstance(result, ChromesResult)
        self.assertEqual(result.chromes, [
            AgentChrome(pid=4100, profile_dir=f"{state}/profile", state_dir=str(state), window_name=f"vedlo browser: {state}",
                        command_name="vedlo browser", proxy=ProxyInfo(pid=4500, upstream="ws://127.0.0.1:9/devtools/browser/p")),
            AgentChrome(pid=4200, profile_dir=f"{self.folder}/old/profile", state_dir=None, window_name=None, command_name=None, proxy=None),
        ])

    def test_chromes_checks_the_shape(self) -> None:
        for output in ['{"ok": true, "command": "chromes", "chromes": [{"pid": "1"}]}', '{"ok": true, "command": "chromes", "chromes": {}}']:
            node = stand_in_node(self.folder, "node-chromes", "v26.0.0", output)
            with self.assertRaises(ProtocolError, msg=output):
                AgentBrowser(self.consumer.state_dir, node=str(node)).chromes()


class FrontTest(unittest.TestCase):
    """`front()`: refused off macOS through the real CLI; its typed result from a stand-in node (nothing is activated)."""

    def setUp(self) -> None:
        self.consumer = Consumer()
        self.folder = self.consumer.dir

    def tearDown(self) -> None:
        self.consumer.remove()

    @unittest.skipIf(sys.platform == "darwin", "on macOS the real CLI would bring a window forward")
    def test_front_is_refused_off_macos_with_a_usage_error(self) -> None:
        with self.assertRaises(UsageError) as caught:
            AgentBrowser(self.consumer.state_dir).front()
        self.assertIn("front brings a window forward on macOS only", str(caught.exception))

    def test_front_returns_typed_fields_and_checks_the_shape(self) -> None:
        good = ('{"ok": true, "command": "front", "chromePid": 4100, "profileDir": "/s/profile", "stateDir": "/s", '
                '"windowName": "agent-browser: /s", "via": "activate-from"}')
        node = stand_in_node(self.folder, "node-front", "v26.0.0", good)
        self.assertEqual(AgentBrowser(self.consumer.state_dir, node=str(node)).front(),
                         FrontResult(chrome_pid=4100, profile_dir="/s/profile", state_dir="/s", window_name="agent-browser: /s", via="activate-from"))
        for i, output in enumerate([
            '{"ok": true, "command": "front", "chromePid": 4100, "profileDir": "/s/profile", "stateDir": null, "windowName": null, "via": "open"}',
            '{"ok": true, "command": "front", "chromePid": "4100", "profileDir": "/s/profile", "stateDir": null, "windowName": null, "via": "activate"}',
        ]):
            node = stand_in_node(self.folder, f"node-front-{i}", "v26.0.0", output)
            with self.assertRaises(ProtocolError, msg=output):
                AgentBrowser(self.consumer.state_dir, node=str(node)).front()


if __name__ == "__main__":
    unittest.main()

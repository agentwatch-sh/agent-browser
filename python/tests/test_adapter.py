"""The Python adapter against the real CLI and the fake Chrome (no browser starts, no site is contacted)."""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import unittest
from pathlib import Path
from typing import List
from unittest import mock

from agent_browser import (
    AgentBrowser, ClickResult, CLIError, NetHttp, NodeNotFoundError, NodeVersionError, NotAllowedError, PackageNotFoundError,
    PinRequiredError, ProtocolError, ReadFirstError, RecordEvent, RecordResult, TabNotFoundError, TabRef, UsageError,
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


if __name__ == "__main__":
    unittest.main()

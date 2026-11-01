"""Tab scopes through the Python adapter: the real CLI and the fake Chrome (no browser starts, no site is contacted)."""

from __future__ import annotations

import subprocess
import unittest
from typing import List
from unittest import mock

from agent_browser import AgentBrowser, ProtocolError, TabNotFoundError, TabRef, TabsResult, UsageError

from .support import Consumer, FakeChrome, stand_in_node


class TabScopeTest(unittest.TestCase):
    fake: FakeChrome
    consumer: Consumer
    a: AgentBrowser
    b: AgentBrowser
    unscoped: AgentBrowser

    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeChrome.start()
        cls.consumer = Consumer()
        # Three callers of one state folder (one agent browser): two sessions, and one with no scope.
        state, allow, ws = cls.consumer.state_dir, cls.consumer.allowlist, cls.fake.ws
        cls.a = AgentBrowser(state, allow, endpoint=ws, no_launch=True, tab_scope="py-a")
        cls.b = AgentBrowser(state, allow, endpoint=ws, no_launch=True, tab_scope="py-b")
        cls.unscoped = AgentBrowser(state, allow, endpoint=ws, no_launch=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.unscoped.stop()
        cls.fake.stop()
        cls.consumer.remove()

    def test_each_scope_sees_only_its_own_tabs(self) -> None:
        base = self.fake.base
        mine = self.a.open(base + "/", name="main").tab
        theirs = self.b.open(base + "/next", name="main").tab
        try:
            self.assertEqual((mine.scope, theirs.scope), ("py-a", "py-b"))
            listed = self.a.tabs()
            self.assertEqual([t.target_id for t in listed.tabs], [mine.target_id])
            self.assertEqual((listed.scope, listed.out_of_scope), ("py-a", 1))
            self.assertEqual(self.a.eval("main", "location.href").value, base + "/", "both scopes name a tab main")
            self.assertEqual(self.b.eval("main", "location.href").value, base + "/next")
            with self.assertRaises(TabNotFoundError) as caught:
                self.a.text(theirs.id)
            self.assertIn("a tab outside this scope does", caught.exception.message)
            self.assertIn("--any-scope", caught.exception.message)
            self.assertNotIn(base, caught.exception.message, "never the other tab's URL")
            # A URL substring that matches only outside the scope gets no hint: it would be an oracle on other scopes' URLs.
            with self.assertRaises(TabNotFoundError) as caught:
                self.a.text("/next")
            self.assertEqual(caught.exception.message, 'no allowlisted tab of scope "py-a" matches "/next" (see: agent-browser tabs)')
            reached = self.a.text(theirs.id, any_scope=True)
            self.assertEqual((reached.tab.name, reached.tab.scope), ("main", "py-b"))
            self.assertEqual(sorted(t.target_id for t in self.a.tabs(any_scope=True).tabs), sorted([mine.target_id, theirs.target_id]))
        finally:
            self.a.close("main")
            self.b.close("main")
        self.assertEqual(self.a.tabs().tabs, [])

    def test_no_scope_sees_every_tab_and_no_scope_fields(self) -> None:
        mine = self.a.open(self.fake.base + "/", name="scoped").tab
        plain = self.unscoped.open(self.fake.base + "/", name="plain").tab
        try:
            listed = self.unscoped.tabs()
            self.assertEqual((listed.scope, listed.out_of_scope), (None, None))
            self.assertEqual({t.target_id: t.scope for t in listed.tabs}, {mine.target_id: "py-a", plain.target_id: None})
            self.assertIsNone(plain.scope)
            self.assertEqual(self.unscoped.text("scoped").tab.target_id, mine.target_id, "with no scope a scoped name reaches its tab")
        finally:
            self.unscoped.close("plain")
            self.a.close("scoped")

    def test_the_scope_and_the_flag_go_into_argv(self) -> None:
        calls: List[List[str]] = []
        real_run = subprocess.run

        def recording_run(argv: List[str], *args: object, **kwargs: object) -> object:
            calls.append(list(argv))
            return real_run(argv, *args, **kwargs)  # type: ignore[call-overload]

        with mock.patch("agent_browser._client.subprocess.run", side_effect=recording_run):
            self.a.tabs()
            self.a.tabs(any_scope=True)
            with self.assertRaises(TabNotFoundError):
                self.a.click("nothing-here", "#1", any_scope=True)
            self.unscoped.tabs()
        runs = [argv for argv in calls if "--json" in argv]
        self.assertEqual(len(runs), 4)
        scoped, flagged, clicked, plain = runs
        self.assertEqual(scoped[scoped.index("--tab-scope") + 1], "py-a")
        self.assertNotIn("--any-scope", scoped)
        self.assertIn("--any-scope", flagged)
        self.assertEqual(clicked[2:6], ["click", "nothing-here", "#1", "--any-scope"])
        self.assertNotIn("--tab-scope", plain)
        self.assertNotIn("--any-scope", plain)

    def test_a_scope_that_is_not_a_string_is_a_value_error_before_any_call(self) -> None:
        with mock.patch("agent_browser._client.subprocess.run") as run:
            for bad in (5, 1.5, b"py-a", ["py-a"], ("py-a",), {"scope": "py-a"}, True, object()):
                with self.assertRaises(ValueError, msg=repr(bad)) as caught:
                    AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, endpoint=self.fake.ws, no_launch=True, tab_scope=bad)  # type: ignore[arg-type]
                self.assertIn("tab_scope must be a string", str(caught.exception))
            self.assertEqual(AgentBrowser(self.consumer.state_dir, tab_scope=None).tab_scope, None)
            self.assertEqual(AgentBrowser(self.consumer.state_dir, tab_scope="py-a").tab_scope, "py-a")
        run.assert_not_called()

    def test_an_invalid_scope_is_a_usage_error(self) -> None:
        for bad in ("two words", "", "-flag", "a/b", "x" * 65):
            with self.assertRaises(UsageError, msg=bad) as caught:
                AgentBrowser(self.consumer.state_dir, self.consumer.allowlist, endpoint=self.fake.ws, no_launch=True, tab_scope=bad).tabs()
            # "-flag" is refused one step earlier, by the CLI's argument parser (a value that looks like a flag).
            self.assertIn("argument is ambiguous" if bad.startswith("-") else "tabScope must be 1 to 64 letters", caught.exception.message)


class TabScopeShapeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.consumer = Consumer()

    def tearDown(self) -> None:
        self.consumer.remove()

    def tabs(self, output: str) -> TabsResult:
        node = stand_in_node(self.consumer.dir, "node-scope", "v26.0.0", output)
        return AgentBrowser(self.consumer.state_dir, node=str(node), tab_scope="s").tabs()

    def test_scope_fields_are_parsed_and_checked(self) -> None:
        tab = '{"id": "AB", "targetId": "AB", "name": null, "scope": "s", "url": "u", "title": "t"}'
        result = self.tabs('{"ok": true, "command": "tabs", "tabs": [' + tab + '], "window": null, "scope": "s", "outOfScope": 2}')
        self.assertEqual((result.scope, result.out_of_scope), ("s", 2))
        self.assertEqual(result.tabs, [TabRef(id="AB", target_id="AB", name=None, url="u", title="t", scope="s")])
        for output in [
            '{"ok": true, "command": "tabs", "tabs": [], "window": null, "scope": "s"}',
            '{"ok": true, "command": "tabs", "tabs": [], "window": null, "outOfScope": 1}',
            '{"ok": true, "command": "tabs", "tabs": [], "window": null, "scope": 1, "outOfScope": 1}',
            '{"ok": true, "command": "tabs", "tabs": [], "window": null, "scope": "s", "outOfScope": "1"}',
            '{"ok": true, "command": "tabs", "tabs": [{"id": "AB", "targetId": "AB", "name": null, "scope": null, "url": "u", "title": "t"}], "window": null}',
        ]:
            with self.assertRaises(ProtocolError, msg=output):
                self.tabs(output)


if __name__ == "__main__":
    unittest.main()

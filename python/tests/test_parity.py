"""Parity: every operation of the Node library and CLI has a Python method with the same options.

The list of operations comes from the CLI itself (`agent-browser commands --json`, which prints
COMMAND_SPECS from src/commands.ts). A new command, or a new option of one, fails this test until
the adapter has it too.
"""

from __future__ import annotations

import inspect
import re
import unittest

import agent_browser
from agent_browser import AgentBrowser, CommandSpec

from .support import Consumer

PLUMBING = {"node_version"}


def snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


class ParityTest(unittest.TestCase):
    specs: list[CommandSpec]

    @classmethod
    def setUpClass(cls) -> None:
        consumer = Consumer()
        try:
            cls.specs = AgentBrowser(consumer.state_dir).commands().commands
        finally:
            consumer.remove()

    def test_every_command_has_a_method_with_the_same_parameters(self) -> None:
        self.assertGreaterEqual(len(self.specs), 20)
        for spec in self.specs:
            method = getattr(AgentBrowser, snake(spec.name), None)
            self.assertTrue(callable(method), f"AgentBrowser has no method for `{spec.name}`")
            assert method is not None
            params = inspect.signature(method).parameters
            names = [p for p in params if p != "self"]
            self.assertEqual(names, [snake(p.name) for p in spec.params], f"{spec.name}: parameters differ from the CLI's")
            for p in spec.params:
                has_default = params[snake(p.name)].default is not inspect.Parameter.empty
                self.assertEqual(not has_default, p.required, f"{spec.name}.{p.name}: required must match")

    def test_no_method_without_a_command(self) -> None:
        commands = {snake(s.name) for s in self.specs}
        public = {n for n, v in vars(AgentBrowser).items() if callable(v) and not n.startswith("_")}
        self.assertEqual(public - commands - PLUMBING, set())

    def test_every_result_type_is_exported(self) -> None:
        for spec in self.specs:
            name = "".join(part.capitalize() for part in spec.name.split("_")) + "Result"
            self.assertTrue(hasattr(agent_browser, name), f"agent_browser.{name}")


if __name__ == "__main__":
    unittest.main()

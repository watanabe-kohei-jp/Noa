import os
import sys
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from integrations.registry import ToolDefinition, ToolRegistry  # noqa: E402


async def _dummy_handler(args: dict, ctx: dict) -> dict:
    return {"ok": True, **args}


class ToolRegistryBasicTests(unittest.TestCase):
    def setUp(self):
        self.registry = ToolRegistry()

    def test_register_and_get(self):
        tool = ToolDefinition(
            name="test_tool",
            description="A test tool",
            args_description='{{ "x": 1 }}',
            handler=_dummy_handler,
        )
        self.registry.register(tool)
        self.assertIs(self.registry.get("test_tool"), tool)

    def test_get_unknown_returns_none(self):
        self.assertIsNone(self.registry.get("nonexistent"))

    def test_tool_names(self):
        for name in ["a", "b", "c"]:
            self.registry.register(ToolDefinition(
                name=name, description="", args_description="",
                handler=_dummy_handler,
            ))
        self.assertEqual(self.registry.tool_names, ["a", "b", "c"])

    def test_reset_clears_all(self):
        self.registry.register(ToolDefinition(
            name="x", description="", args_description="",
            handler=_dummy_handler,
        ))
        self.assertEqual(len(self.registry.tool_names), 1)
        self.registry.reset()
        self.assertEqual(len(self.registry.tool_names), 0)


class ToolRegistryExecuteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.registry = ToolRegistry()

    async def test_execute_calls_handler(self):
        self.registry.register(ToolDefinition(
            name="echo",
            description="Echo tool",
            args_description="",
            handler=_dummy_handler,
        ))
        result = await self.registry.execute("echo", {"msg": "hello"}, {})
        self.assertEqual(result, {"ok": True, "msg": "hello"})

    async def test_execute_unknown_raises(self):
        with self.assertRaises(ValueError):
            await self.registry.execute("missing", {}, {})


class ToolRegistryPromptTests(unittest.TestCase):
    def setUp(self):
        self.registry = ToolRegistry()
        self.registry.register(ToolDefinition(
            name="tool_a",
            description="Description A",
            args_description='{{{{ "key": "val" }}}}',
            handler=_dummy_handler,
            follow_up_allowed=True,
        ))
        self.registry.register(ToolDefinition(
            name="tool_b",
            description="Description B",
            args_description='{{{{}}}}',
            handler=_dummy_handler,
            follow_up_allowed=False,
        ))

    def test_build_tool_prompt_contains_all_tools(self):
        prompt = self.registry.build_tool_prompt()
        self.assertIn("tool_a", prompt)
        self.assertIn("Description A", prompt)
        self.assertIn("tool_b", prompt)
        self.assertIn("Description B", prompt)

    def test_get_follow_up_allowed(self):
        allowed = self.registry.get_follow_up_allowed()
        self.assertEqual(allowed, {"tool_a"})

    def test_build_follow_up_tool_list(self):
        tool_list = self.registry.build_follow_up_tool_list()
        self.assertIn("tool_a", tool_list)
        self.assertNotIn("tool_b", tool_list)


if __name__ == "__main__":
    unittest.main()

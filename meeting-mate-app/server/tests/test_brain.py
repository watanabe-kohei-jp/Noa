import os
import sys
import unittest
from unittest.mock import AsyncMock, patch


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from brain import extract_actions, execute_tool


class ExtractActionsTests(unittest.TestCase):
    def test_create_task_action_shape(self):
        result = {
            "success": True,
            "task": {
                "title": "Write tests",
                "assignee": "Alice",
                "due_date": "2026-03-20",
                "priority": "high",
            },
        }

        actions = extract_actions("create_task", result)

        self.assertEqual(
            actions,
            [
                {
                    "action": "create_task",
                    "data": {
                        "title": "Write tests",
                        "assignee": "Alice",
                        "due_date": "2026-03-20",
                        "priority": "high",
                    },
                }
            ],
        )

    def test_generate_diagram_action_includes_mermaid_code_description_and_title(self):
        result = {
            "success": True,
            "mermaid_code": "graph TD\nA --> B",
            "description": "Project flow",
            "title": "概要図: Project flow",
        }

        actions = extract_actions("generate_diagram", result)

        self.assertEqual(
            actions,
            [
                {
                    "action": "generate_diagram",
                    "data": {
                        "mermaid_code": "graph TD\nA --> B",
                        "description": "Project flow",
                        "title": "概要図: Project flow",
                    },
                }
            ],
        )

    def test_generate_diagram_failure_returns_no_actions(self):
        self.assertEqual(
            extract_actions("generate_diagram", {"success": False}),
            [],
        )


class GenerateDiagramRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_succeeds_on_first_attempt(self):
        with patch("brain.llm_complete", AsyncMock(return_value="graph TD\nA-->B")) as mock_llm, \
             patch("brain.validate_and_clean_mermaid", return_value="graph TD\nA-->B"), \
             patch("brain.get_default_api_key", return_value="test-key"):
            result = await execute_tool("generate_diagram", {"description": "test"}, {})

        self.assertTrue(result["success"])
        mock_llm.assert_awaited_once()

    async def test_succeeds_on_retry(self):
        with patch("brain.llm_complete", AsyncMock(return_value="some output")) as mock_llm, \
             patch("brain.validate_and_clean_mermaid", side_effect=[None, "graph TD\nA-->B"]), \
             patch("brain.get_default_api_key", return_value="test-key"):
            result = await execute_tool("generate_diagram", {"description": "test"}, {})

        self.assertTrue(result["success"])
        self.assertEqual(mock_llm.await_count, 2)

    async def test_fails_after_all_retries(self):
        with patch("brain.llm_complete", AsyncMock(return_value="bad output")) as mock_llm, \
             patch("brain.validate_and_clean_mermaid", return_value=None), \
             patch("brain.get_default_api_key", return_value="test-key"):
            result = await execute_tool("generate_diagram", {"description": "test"}, {})

        self.assertFalse(result["success"])
        self.assertEqual(mock_llm.await_count, 2)

    async def test_no_retry_on_exception(self):
        with patch("brain.llm_complete", AsyncMock(side_effect=Exception("API Error"))) as mock_llm, \
             patch("brain.get_default_api_key", return_value="test-key"):
            result = await execute_tool("generate_diagram", {"description": "test"}, {})

        self.assertFalse(result["success"])
        mock_llm.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()

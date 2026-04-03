import os
import sys
import unittest
from unittest.mock import AsyncMock, patch


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from brain import extract_actions, execute_tool  # noqa: E402
from integrations.registry import registry  # noqa: E402


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


class ToolRegistryTests(unittest.TestCase):
    def test_all_builtin_tools_registered(self):
        expected = {
            "knowledge_base_search", "calculate", "get_current_time",
            "get_meeting_context", "summarize_discussion", "create_task",
            "generate_diagram", "search_past_meetings", "deep_analysis",
            "google_calendar_create",
        }
        self.assertEqual(set(registry.tool_names), expected)

    def test_follow_up_allowed_matches_expected(self):
        expected = {
            "knowledge_base_search", "calculate", "get_current_time",
            "get_meeting_context", "summarize_discussion", "search_past_meetings",
        }
        self.assertEqual(registry.get_follow_up_allowed(), expected)

    def test_follow_up_excludes_write_tools(self):
        disallowed = {"create_task", "generate_diagram", "deep_analysis", "google_calendar_create"}
        allowed = registry.get_follow_up_allowed()
        self.assertTrue(disallowed.isdisjoint(allowed))

    def test_build_tool_prompt_contains_all_tools(self):
        prompt = registry.build_tool_prompt()
        for name in registry.tool_names:
            self.assertIn(name, prompt)

    def test_get_returns_none_for_unknown(self):
        self.assertIsNone(registry.get("nonexistent_tool"))


class ExecuteToolRegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_current_time_via_registry(self):
        result = await execute_tool("get_current_time", {}, {})
        self.assertIn("datetime", result)
        self.assertIn("formatted", result)
        self.assertEqual(result["timezone"], "Asia/Tokyo")

    async def test_calculate_via_registry(self):
        result = await execute_tool("calculate", {"expression": "2+3"}, {})
        self.assertTrue(result["success"])
        self.assertEqual(result["result"], 5)

    async def test_unknown_tool_returns_error(self):
        result = await execute_tool("nonexistent_tool", {}, {})
        self.assertIn("error", result)


class GoogleCalendarCreateTests(unittest.IsolatedAsyncioTestCase):
    async def test_generates_valid_url(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "定例会議",
            "start": "2026-04-03T15:00",
            "end": "2026-04-03T16:00",
        }, {})
        self.assertTrue(result["success"])
        self.assertIn("calendar.google.com", result["calendar_url"])
        self.assertIn("action=TEMPLATE", result["calendar_url"])
        self.assertIn("20260403T150000", result["calendar_url"])
        self.assertIn("20260403T160000", result["calendar_url"])
        self.assertIn("ctz=Asia/Tokyo", result["calendar_url"])

    async def test_url_encodes_summary(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "プロジェクト レビュー",
            "start": "2026-04-03T10:00",
            "end": "2026-04-03T11:00",
        }, {})
        self.assertTrue(result["success"])
        self.assertIn("calendar_url", result)

    async def test_includes_optional_fields(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "ランチ",
            "start": "2026-04-03T12:00",
            "end": "2026-04-03T13:00",
            "description": "チームランチ",
            "location": "カフェ",
        }, {})
        self.assertTrue(result["success"])
        self.assertIn("details=", result["calendar_url"])
        self.assertIn("location=", result["calendar_url"])

    async def test_rejects_missing_summary(self):
        result = await execute_tool("google_calendar_create", {
            "start": "2026-04-03T15:00",
            "end": "2026-04-03T16:00",
        }, {})
        self.assertFalse(result["success"])

    async def test_rejects_missing_times(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "会議",
        }, {})
        self.assertFalse(result["success"])

    async def test_rejects_end_before_start(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "会議",
            "start": "2026-04-03T16:00",
            "end": "2026-04-03T15:00",
        }, {})
        self.assertFalse(result["success"])

    async def test_rejects_invalid_datetime(self):
        result = await execute_tool("google_calendar_create", {
            "summary": "会議",
            "start": "not-a-date",
            "end": "also-not-a-date",
        }, {})
        self.assertFalse(result["success"])


class CalendarLinkExtractActionsTests(unittest.TestCase):
    def test_extracts_calendar_link_action(self):
        result = {
            "success": True,
            "calendar_url": "https://calendar.google.com/calendar/render?action=TEMPLATE&text=test",
            "summary": "テスト会議",
            "start": "2026-04-03T15:00",
            "end": "2026-04-03T16:00",
            "timezone": "Asia/Tokyo",
        }
        actions = extract_actions("google_calendar_create", result)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["action"], "calendar_link")
        self.assertEqual(actions[0]["data"]["summary"], "テスト会議")
        self.assertIn("calendar_url", actions[0]["data"])

    def test_no_action_on_failure(self):
        result = {"success": False, "message": "エラー"}
        actions = extract_actions("google_calendar_create", result)
        self.assertEqual(actions, [])


if __name__ == "__main__":
    unittest.main()

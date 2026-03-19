import os
import sys
import json
import unittest
from unittest.mock import AsyncMock, patch

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from brain import process_proactive_check


class ProcessProactiveCheckTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_transcript_returns_no_intervene(self):
        result = await process_proactive_check([], {}, [])
        self.assertFalse(result["intervene"])
        self.assertEqual(result["reason"], "transcript is empty")

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_intervene_true_when_llm_says_so(self, mock_llm):
        mock_llm.return_value = json.dumps({
            "intervene": True,
            "suggestion": "売上データを確認できます",
            "dedupe_key": "data_available_sales",
            "confidence": 0.85,
            "action_type": "data_available",
            "reason": "売上に関する議論が行われている",
        })

        transcript = [
            {"speaker": "田中", "text": "先月の売上はどうだった？", "timestamp": "2026-03-19T10:00:00Z"},
            {"speaker": "鈴木", "text": "ちょっと確認しないとわからない", "timestamp": "2026-03-19T10:00:30Z"},
        ]
        result = await process_proactive_check(transcript, {"title": "営業会議"}, [])

        self.assertTrue(result["intervene"])
        self.assertEqual(result["dedupe_key"], "data_available_sales")
        self.assertGreaterEqual(result["confidence"], 0.7)

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_no_intervene_for_casual_chat(self, mock_llm):
        mock_llm.return_value = json.dumps({
            "intervene": False,
            "suggestion": "",
            "dedupe_key": "",
            "confidence": 0.1,
            "action_type": "",
            "reason": "雑談のため介入不要",
        })

        transcript = [
            {"speaker": "田中", "text": "今日はいい天気だね", "timestamp": "2026-03-19T10:00:00Z"},
            {"speaker": "鈴木", "text": "そうだね、春っぽい", "timestamp": "2026-03-19T10:00:10Z"},
        ]
        result = await process_proactive_check(transcript, {}, [])

        self.assertFalse(result["intervene"])

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_already_suggested_keys_passed_to_prompt(self, mock_llm):
        mock_llm.return_value = json.dumps({
            "intervene": False,
            "suggestion": "",
            "dedupe_key": "",
            "confidence": 0.0,
            "action_type": "",
            "reason": "already suggested",
        })

        transcript = [
            {"speaker": "田中", "text": "売上の話", "timestamp": "2026-03-19T10:00:00Z"},
            {"speaker": "鈴木", "text": "もっと詳しく", "timestamp": "2026-03-19T10:00:30Z"},
        ]
        await process_proactive_check(transcript, {}, ["data_available_sales"])

        # Verify the already_suggested_keys were included in the prompt
        call_args = mock_llm.call_args
        prompt = call_args.kwargs.get("prompt", call_args[1].get("prompt", ""))
        self.assertIn("data_available_sales", prompt)

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_returns_no_intervene_on_llm_failure(self, mock_llm):
        mock_llm.side_effect = Exception("API error")

        transcript = [
            {"speaker": "田中", "text": "テスト", "timestamp": "2026-03-19T10:00:00Z"},
        ]
        result = await process_proactive_check(transcript, {}, [])

        self.assertFalse(result["intervene"])
        self.assertIn("analysis failed", result["reason"])

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_handles_invalid_json_response(self, mock_llm):
        mock_llm.return_value = "not valid json {{"

        transcript = [
            {"speaker": "田中", "text": "テスト", "timestamp": "2026-03-19T10:00:00Z"},
        ]
        result = await process_proactive_check(transcript, {}, [])

        self.assertFalse(result["intervene"])
        self.assertIn("analysis failed", result["reason"])


if __name__ == "__main__":
    unittest.main()

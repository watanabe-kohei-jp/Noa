import json
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from brain import process_proactive_check


class ProcessProactiveCheckTests(unittest.IsolatedAsyncioTestCase):
    """process_proactive_check() のユニットテスト"""

    async def test_empty_transcript_returns_no_intervene(self):
        """空の transcript では介入しない"""
        result = await process_proactive_check([], {}, [])
        self.assertFalse(result["intervene"])
        self.assertEqual(result["reason"], "transcript is empty")

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_intervene_true_when_llm_says_so(self, mock_llm):
        """LLM が intervene=True を返した場合"""
        mock_llm.return_value = json.dumps({
            "intervene": True,
            "suggestion": "売上データを確認しましょうか？",
            "dedupe_key": "fact_check_売上",
            "confidence": 0.85,
            "action_type": "fact_check",
            "reason": "売上に関する主張が検証可能",
        })

        transcript = [
            {"speaker": "田中", "text": "売上は前年比10%増えたはずですよね？"},
            {"speaker": "鈴木", "text": "そうだったかな、確認したいですね"},
        ]

        result = await process_proactive_check(transcript, {}, [])
        self.assertTrue(result["intervene"])
        self.assertIn("売上", result["suggestion"])
        self.assertEqual(result["action_type"], "fact_check")

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_no_intervene_for_casual_chat(self, mock_llm):
        """雑談では介入しない"""
        mock_llm.return_value = json.dumps({
            "intervene": False,
            "suggestion": "",
            "dedupe_key": "",
            "confidence": 0.1,
            "action_type": "",
            "reason": "雑談のため介入不要",
        })

        transcript = [
            {"speaker": "田中", "text": "今日はいい天気ですね"},
            {"speaker": "鈴木", "text": "そうですね、暖かくなりました"},
        ]

        result = await process_proactive_check(transcript, {}, [])
        self.assertFalse(result["intervene"])

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_already_suggested_keys_passed_to_prompt(self, mock_llm):
        """already_suggested_keys がプロンプトに含まれる"""
        mock_llm.return_value = json.dumps({
            "intervene": False,
            "suggestion": "",
            "dedupe_key": "",
            "confidence": 0.3,
            "action_type": "",
            "reason": "既に提案済み",
        })

        await process_proactive_check(
            [{"speaker": "A", "text": "test"}],
            {},
            ["fact_check_売上", "data_available_予算"],
        )

        prompt_arg = mock_llm.call_args[1]["prompt"]
        self.assertIn("fact_check_売上", prompt_arg)
        self.assertIn("data_available_予算", prompt_arg)

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_returns_no_intervene_on_llm_failure(self, mock_llm):
        """LLM API エラー時は安全に intervene=False"""
        mock_llm.side_effect = Exception("API connection failed")

        result = await process_proactive_check(
            [{"speaker": "A", "text": "test"}], {}, []
        )
        self.assertFalse(result["intervene"])
        self.assertIn("failed", result.get("reason", ""))

    @patch("brain.llm_complete", new_callable=AsyncMock)
    async def test_handles_invalid_json_response(self, mock_llm):
        """JSON パース失敗時は安全に処理"""
        mock_llm.return_value = "This is not valid JSON at all"

        result = await process_proactive_check(
            [{"speaker": "A", "text": "test"}], {}, []
        )
        self.assertFalse(result["intervene"])
        self.assertIn("failed", result.get("reason", ""))

    async def test_transcript_max_20_entries(self):
        """process_proactive_check は直近20件のみ使用"""
        # 25件の transcript を作成
        transcript = [
            {"speaker": f"speaker_{i}", "text": f"message_{i}"}
            for i in range(25)
        ]

        with patch("brain.llm_complete", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = json.dumps({
                "intervene": False,
                "suggestion": "",
                "dedupe_key": "",
                "confidence": 0.1,
                "action_type": "",
                "reason": "test",
            })

            await process_proactive_check(transcript, {}, [])

            # プロンプトに最後の20件のみ含まれることを確認
            prompt_arg = mock_llm.call_args[1]["prompt"]
            self.assertIn("speaker_24", prompt_arg)  # 最後のエントリ
            self.assertIn("speaker_5", prompt_arg)    # 20件前
            self.assertNotIn("speaker_4", prompt_arg)  # 21件前は含まれない


if __name__ == "__main__":
    unittest.main()

"""Issue #131: agenda 遷移 hook の検知ロジックのテスト。

実際の `_schedule_overview_closing_update_if_agenda_changed` は asyncio.create_task で
fire-and-forget するため副作用検証が難しい。純粋関数 `detect_agenda_topic_change` を
分離し、こちらでカバレッジを取る。
"""
import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from main import detect_agenda_topic_change  # noqa: E402


class DetectAgendaTopicChangeTests(unittest.TestCase):
    def test_returns_none_when_no_old_session(self):
        self.assertEqual(detect_agenda_topic_change(None, {"data": {"currentAgenda": {"mainTopic": "X"}}}), (None, None))

    def test_returns_none_when_no_agenda_result(self):
        self.assertEqual(detect_agenda_topic_change({"currentAgenda": {"mainTopic": "X"}}, None), (None, None))

    def test_returns_none_when_main_topic_unchanged(self):
        old = {"currentAgenda": {"mainTopic": "設計議論"}}
        result = {"data": {"currentAgenda": {"mainTopic": "設計議論"}}}
        self.assertEqual(detect_agenda_topic_change(old, result), (None, None))

    def test_returns_none_when_first_topic(self):
        """旧 mainTopic が空 (= 初回設定) なら closing update 不要。"""
        old = {"currentAgenda": {"mainTopic": ""}}
        result = {"data": {"currentAgenda": {"mainTopic": "新しい話題"}}}
        self.assertEqual(detect_agenda_topic_change(old, result), (None, None))

    def test_returns_old_and_new_on_transition(self):
        old = {"currentAgenda": {"mainTopic": "設計議論"}}
        result = {"data": {"currentAgenda": {"mainTopic": "実装方針"}}}
        self.assertEqual(detect_agenda_topic_change(old, result), ("設計議論", "実装方針"))

    def test_handles_missing_currentAgenda_in_result(self):
        old = {"currentAgenda": {"mainTopic": "設計議論"}}
        result = {"data": {}}
        self.assertEqual(detect_agenda_topic_change(old, result), (None, None))

    def test_handles_malformed_agenda_result(self):
        old = {"currentAgenda": {"mainTopic": "設計議論"}}
        # result.data が dict でない
        self.assertEqual(detect_agenda_topic_change(old, {"data": "not a dict"}), (None, None))
        # agenda_result 自体が dict でない
        self.assertEqual(detect_agenda_topic_change(old, "not a dict"), (None, None))

    def test_trims_whitespace(self):
        """空白だけの mainTopic は無視。"""
        old = {"currentAgenda": {"mainTopic": "  "}}
        result = {"data": {"currentAgenda": {"mainTopic": "新"}}}
        self.assertEqual(detect_agenda_topic_change(old, result), (None, None))


if __name__ == "__main__":
    unittest.main()

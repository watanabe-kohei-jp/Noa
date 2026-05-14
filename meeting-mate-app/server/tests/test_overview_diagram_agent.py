import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from agents import overview_diagram_agent  # noqa: E402
from agents.overview_diagram_utils import LEGACY_TOPIC_ID, slugify_topic_id  # noqa: E402


def _entry(topic_id: str, mermaid: str, title: str = "T", status: str = "active") -> dict:
    return {
        "topicId": topic_id,
        "title": title,
        "mermaidDefinition": mermaid,
        "status": status,
        "createdAt": "2026-01-01T00:00:00Z",
        "lastUpdated": "2026-01-01T00:00:00Z",
    }


class OverviewDiagramAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_singular_input_normalized_and_updated(self):
        """既存テスト改修: legacy 単数入力を受けて新リスト形式で返す。"""
        conversation_history = [
            SimpleNamespace(role="user", parts=[{"text": "Please update the diagram"}]),
        ]
        current_data = {
            "overviewDiagram": {
                "mermaidDefinition": "graph TD\nA[Old] --> B[Diagram]",
                "title": "Current diagram",
            }
        }
        llm_output = "```mermaid\ngraph TD\nA[New] --> B[Diagram]\n```"
        cleaned_output = "graph TD\nA[New] --> B[Diagram]"

        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value=llm_output),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value=cleaned_output,
        ) as mock_validator:
            result, _message = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="Refresh the project overview",
                conversation_history=conversation_history,
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
            )

        mock_llm.assert_awaited_once()
        mock_validator.assert_called_once_with(llm_output, allowed_types=["flowchart"])
        diagrams = result["overviewDiagrams"]
        self.assertEqual(len(diagrams), 1)
        # legacy topicId が存続し、上書きされる
        self.assertEqual(diagrams[0]["topicId"], LEGACY_TOPIC_ID)
        self.assertEqual(diagrams[0]["mermaidDefinition"], cleaned_output)

    async def test_falls_back_to_empty_diff_when_all_retries_fail(self):
        """P0 fix: validation 失敗時は差分なし (空リスト) を返し、writer は何も書かない。"""
        current_data = {
            "overviewDiagram": {
                "mermaidDefinition": "graph TD\nA[Existing]",
                "title": "Existing title",
            }
        }
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="not mermaid"),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value=None,
        ):
            result, message = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="Try update",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
            )

        self.assertEqual(mock_llm.await_count, 2)
        # 差分なし → writer は何も書かない (旧 entry は DB 上で生き残る)
        self.assertEqual(result["overviewDiagrams"], [])
        self.assertIn("expected Mermaid format", message)

    async def test_succeeds_on_retry(self):
        current_data = {
            "overviewDiagram": {
                "mermaidDefinition": "graph TD\nA[Old]",
                "title": "Old title",
            }
        }
        cleaned = "graph TD\nA[New] --> B[Updated]"

        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="some output"),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            side_effect=[None, cleaned],
        ):
            result, _message = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="Update diagram",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
            )

        self.assertEqual(mock_llm.await_count, 2)
        diagrams = result["overviewDiagrams"]
        self.assertEqual(diagrams[0]["mermaidDefinition"], cleaned)

    async def test_no_retry_on_exception(self):
        """P0 fix: LLM 例外時も差分なし (空リスト)。writer は旧 entry に触らない。"""
        current_data = {
            "overviewDiagram": {
                "mermaidDefinition": "graph TD\nA[Existing]",
                "title": "Existing title",
            }
        }
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(side_effect=Exception("API Error")),
        ) as mock_llm:
            result, message = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="Try update",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
            )

        mock_llm.assert_awaited_once()
        self.assertEqual(result["overviewDiagrams"], [])
        self.assertIn("エラー", message)

    # ---- 新規テスト ----

    async def test_target_topic_id_routes_to_specific_entry(self):
        """P0 fix: 差分 semantics — 指定 topicId の差分のみを返し、他 topic は payload に含めない。"""
        current_data = {
            "overviewDiagrams": [
                _entry("topic_a", "graph TD\nA"),
                _entry("topic_b", "graph TD\nB"),
            ]
        }
        cleaned = "graph TD\nA-->A2"
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="anything"),
        ), patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value=cleaned,
        ):
            result, _ = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="topic_a を更新",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="topic_a",
            )
        diagrams = result["overviewDiagrams"]
        # 差分のみ → topic_a 1 件
        self.assertEqual(len(diagrams), 1)
        self.assertEqual(diagrams[0]["topicId"], "topic_a")
        self.assertEqual(diagrams[0]["mermaidDefinition"], cleaned)

    async def test_wildcard_updates_all_topics_in_parallel(self):
        current_data = {
            "overviewDiagrams": [
                _entry("topic_a", "graph TD\nA"),
                _entry("topic_b", "graph TD\nB"),
                _entry("topic_c", "graph TD\nC"),
            ]
        }
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="anything"),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nupdated",
        ):
            result, msg = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="全部更新",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="*",
            )
        self.assertEqual(mock_llm.await_count, 3)
        diagrams = result["overviewDiagrams"]
        for d in diagrams:
            self.assertEqual(d["mermaidDefinition"], "graph TD\nupdated")
        self.assertIn("3 件", msg)

    async def test_wildcard_caps_at_limit(self):
        many = [_entry(f"t{i}", f"graph TD\n{i}") for i in range(10)]
        current_data = {"overviewDiagrams": many}
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nok",
        ):
            await overview_diagram_agent.handle_overview_diagram_request(
                instruction="全部",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="*",
            )
        # WILDCARD_CAP=5 までしか並列実行されない
        self.assertEqual(mock_llm.await_count, overview_diagram_agent.WILDCARD_CAP)

    async def test_create_new_entry_when_topic_missing(self):
        """P0 fix: 新規 entry も差分のみ返却 (topic_x 1 件)。topic_a は payload に含めない。"""
        current_data = {"overviewDiagrams": [_entry("topic_a", "graph TD\nA")]}
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ), patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nnew",
        ):
            result, _ = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="新しい論点 X について",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="topic_x",
            )
        diagrams = result["overviewDiagrams"]
        self.assertEqual(len(diagrams), 1)
        self.assertEqual(diagrams[0]["topicId"], "topic_x")
        self.assertEqual(diagrams[0]["mermaidDefinition"], "graph TD\nnew")

    async def test_closing_update_skips_when_topic_missing(self):
        current_data = {"overviewDiagrams": [_entry("topic_a", "graph TD\nA")]}
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ) as mock_llm, patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nupdated",
        ):
            result, msg = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="締めくくり",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="topic_missing",
                closing_update=True,
            )
        mock_llm.assert_not_awaited()
        # P0 fix: no-op → 差分なし (空リスト)
        self.assertEqual(result["overviewDiagrams"], [])
        self.assertIn("スキップ", msg)

    async def test_closing_update_marks_status_closed(self):
        current_data = {"overviewDiagrams": [_entry("topic_a", "graph TD\nA")]}
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ), patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nfinal",
        ):
            result, _ = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="締めくくり",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="topic_a",
                closing_update=True,
            )
        entry = result["overviewDiagrams"][0]
        self.assertEqual(entry["status"], "closed")
        self.assertEqual(entry["mermaidDefinition"], "graph TD\nfinal")

    async def test_target_topic_id_sanitized_by_agent_defense(self):
        """P0 fix: dispatcher が validation を漏らした場合でも agent 内で slugify される
        (Firebase path injection / nested path 化を防ぐ二重防御)。"""
        current_data = {"overviewDiagrams": []}
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ), patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nok",
        ):
            result, _ = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="injection 試行",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
                target_topic_id="path/with#bad$chars",
            )
        # 危険な path セパレータが '_' に置換されて safe な topicId になっている
        self.assertEqual(len(result["overviewDiagrams"]), 1)
        topic_id = result["overviewDiagrams"][0]["topicId"]
        self.assertNotIn("/", topic_id)
        self.assertNotIn("#", topic_id)
        self.assertNotIn("$", topic_id)
        self.assertEqual(topic_id, "path_with_bad_chars")

    async def test_default_uses_main_topic_slug(self):
        current_data = {
            "agenda": {"mainTopic": "設計議論"},
            "overviewDiagrams": [],
        }
        with patch.object(
            overview_diagram_agent,
            "llm_complete",
            AsyncMock(return_value="x"),
        ), patch.object(
            overview_diagram_agent,
            "validate_and_clean_mermaid",
            return_value="graph TD\nnew",
        ):
            result, _ = await overview_diagram_agent.handle_overview_diagram_request(
                instruction="更新",
                conversation_history=[],
                current_data=current_data,
                model_name="gemini-2.5-flash",
                api_key="test-key",
            )
        self.assertEqual(len(result["overviewDiagrams"]), 1)
        self.assertEqual(result["overviewDiagrams"][0]["topicId"], slugify_topic_id("設計議論"))


if __name__ == "__main__":
    unittest.main()

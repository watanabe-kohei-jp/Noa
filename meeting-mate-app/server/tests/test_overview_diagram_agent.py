import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from agents import overview_diagram_agent


class OverviewDiagramAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_shared_mermaid_validator_and_persists_cleaned_result(self):
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
        mock_validator.assert_called_once_with(llm_output)
        self.assertEqual(
            result["overviewDiagram"],
            {
                "mermaidDefinition": cleaned_output,
                "title": "概要図: Refresh the project overview",
            },
        )

    async def test_falls_back_to_existing_diagram_when_all_retries_fail(self):
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
        self.assertEqual(
            result["overviewDiagram"],
            {
                "mermaidDefinition": "graph TD\nA[Existing]",
                "title": "Existing title",
            },
        )
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
        self.assertEqual(result["overviewDiagram"]["mermaidDefinition"], cleaned)

    async def test_no_retry_on_exception(self):
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
        self.assertEqual(
            result["overviewDiagram"]["mermaidDefinition"],
            "graph TD\nA[Existing]",
        )
        self.assertIn("expected Mermaid format", message)


if __name__ == "__main__":
    unittest.main()

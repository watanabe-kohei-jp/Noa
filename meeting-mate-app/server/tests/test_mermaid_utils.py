import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from mermaid_utils import validate_and_clean_mermaid  # noqa: E402


class ValidateAndCleanMermaidTests(unittest.TestCase):
    def test_returns_none_for_empty_input(self):
        self.assertIsNone(validate_and_clean_mermaid(""))
        self.assertIsNone(validate_and_clean_mermaid("   \n  "))

    def test_strips_markdown_code_fences(self):
        raw = "```mermaid\ngraph TD\n    A[Start] --> B[End]\n```"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "graph TD\n    A[Start] --> B[End]")

    def test_strips_inline_backticks(self):
        raw = "`graph LR\nA --> B`"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "graph LR\nA --> B")

    def test_rejects_non_graph_td_or_lr(self):
        self.assertIsNone(validate_and_clean_mermaid("sequenceDiagram\nA->>B: hi"))

    def test_normalizes_flowchart_to_graph(self):
        self.assertEqual(
            validate_and_clean_mermaid("flowchart TD\n    A-->B"),
            "graph TD\n    A-->B",
        )
        self.assertEqual(
            validate_and_clean_mermaid("flowchart LR\n    A-->B"),
            "graph LR\n    A-->B",
        )

    def test_removes_dangerous_directives(self):
        raw = "\n".join(
            [
                "graph TD",
                "A[Start] --> B[End]",
                "click A \"https://example.com\"",
                "A --> C[javascript:alert(1)]",
                "href \"https://example.com\"",
                "%%{init: {'theme':'dark'}}%%",
            ]
        )

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "graph TD\nA[Start] --> B[End]")

    def test_sanitizes_double_percent_comment_to_ascii(self):
        raw = "graph TD\n%% コメント\nA --> B"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "graph TD\n%% Comment\nA --> B")

    def test_normalizes_single_percent_comment_and_sanitizes_unicode(self):
        raw = "graph TD\n% コメント\nA --> B"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "graph TD\n%% Comment\nA --> B")


if __name__ == "__main__":
    unittest.main()

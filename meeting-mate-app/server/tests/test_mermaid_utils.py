import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from mermaid_utils import validate_and_clean_mermaid  # noqa: E402


class ValidateAndCleanMermaidTests(unittest.TestCase):
    # === 既存テスト (flowchart) ===

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

    # === 新図タイプ受け入れテスト ===

    def test_accepts_sequence_diagram(self):
        raw = "sequenceDiagram\n    Alice->>Bob: Hello"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "sequenceDiagram\n    Alice->>Bob: Hello")

    def test_accepts_gantt(self):
        raw = "gantt\n    title A Gantt\n    section Tasks\n    Task1 :a1, 2024-01-01, 30d"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("gantt"))

    def test_accepts_mindmap(self):
        raw = "mindmap\n  root((Meeting))\n    Topic A\n    Topic B"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("mindmap"))

    def test_accepts_pie(self):
        raw = "pie title Tasks\n    \"Done\" : 70\n    \"Todo\" : 30"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("pie"))

    # === 未知タイプ reject テスト ===

    def test_rejects_unknown_diagram_type(self):
        self.assertIsNone(validate_and_clean_mermaid("erDiagram\n    A ||--o{ B : has"))
        self.assertIsNone(validate_and_clean_mermaid("classDiagram\n    class A"))

    # === allowed_types パラメータテスト ===

    def test_allowed_types_restricts_to_flowchart(self):
        """overview_diagram_agent 互換: flowchart のみ許可"""
        self.assertIsNotNone(
            validate_and_clean_mermaid("graph TD\n    A-->B", allowed_types=["flowchart"])
        )
        self.assertIsNone(
            validate_and_clean_mermaid("sequenceDiagram\n    A->>B: hi", allowed_types=["flowchart"])
        )
        self.assertIsNone(
            validate_and_clean_mermaid("gantt\n    title G", allowed_types=["flowchart"])
        )

    def test_allowed_types_none_allows_all(self):
        """allowed_types=None はデフォルトで全タイプ許可"""
        self.assertIsNotNone(validate_and_clean_mermaid("graph TD\n    A-->B"))
        self.assertIsNotNone(validate_and_clean_mermaid("sequenceDiagram\n    A->>B: hi"))
        self.assertIsNotNone(validate_and_clean_mermaid("gantt\n    title G"))
        self.assertIsNotNone(validate_and_clean_mermaid("mindmap\n  root((R))"))
        self.assertIsNotNone(validate_and_clean_mermaid("pie title P\n    \"A\" : 50"))

    # === 新図タイプのセキュリティテスト ===

    def test_removes_dangerous_directives_from_sequence(self):
        raw = "sequenceDiagram\n    Alice->>Bob: Hi\n    click Alice \"https://evil.com\""

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "sequenceDiagram\n    Alice->>Bob: Hi")

    def test_removes_generic_directive_from_all_types(self):
        """%%{...}%% directive は図タイプに関わらず除去"""
        raw = "sequenceDiagram\n    %%{config: {theme: 'dark'}}%%\n    Alice->>Bob: Hi"

        cleaned = validate_and_clean_mermaid(raw)

        self.assertEqual(cleaned, "sequenceDiagram\n    Alice->>Bob: Hi")


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from mermaid_utils import (  # noqa: E402
    validate_and_clean_mermaid,
    _scan_top_level_arrows,
    _count_arrows_in_line,
    _split_line_by_arrows,
)


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


    # === #94: フローチャートコロンラベル修正テスト ===

    def test_fixes_colon_label_bare_ids(self):
        """A --> B : "label" → A -->|"label"| B"""
        raw = 'graph TD\n    A --> B : "影響を与える"'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"影響を与える"|', cleaned)
        self.assertIn("A", cleaned)
        self.assertIn("B", cleaned)

    def test_fixes_colon_label_bracket_nodes(self):
        """A["開始"] --> B["終了"] : "label" → A["開始"] -->|"label"| B["終了"]"""
        raw = 'graph TD\n    A["開始"] --> B["終了"] : "ラベル"'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"ラベル"|', cleaned)
        self.assertIn('A["開始"]', cleaned)
        self.assertIn('B["終了"]', cleaned)

    def test_no_label_edge_unchanged(self):
        """A --> B (ラベルなし) は変更しない"""
        raw = "graph TD\n    A --> B"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertEqual(cleaned, "graph TD\n    A --> B")

    def test_pipe_label_already_correct(self):
        """既に正しい A -->|"label"| B は変更しない"""
        raw = 'graph TD\n    A -->|"label"| B'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"label"|', cleaned)

    def test_dash_label_already_correct(self):
        """既に正しい A -- "label" --> B は変更しない"""
        raw = 'graph TD\n    A -- "label" --> B'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-- "label" -->', cleaned)

    def test_sequence_diagram_colon_untouched(self):
        """シーケンス図の Alice->>Bob: Hello は変更しない"""
        raw = "sequenceDiagram\n    Alice->>Bob: Hello"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertEqual(cleaned, "sequenceDiagram\n    Alice->>Bob: Hello")

    def test_fixes_unquoted_colon_label(self):
        """未クォートラベル A --> B : label → A -->|"label"| B"""
        raw = "graph TD\n    A --> B : some label"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"some label"|', cleaned)

    def test_fixes_colon_label_with_thick_arrow(self):
        """A ==> B : "label" → A ==>|"label"| B"""
        raw = 'graph TD\n    A ==> B : "heavy"'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('==>|"heavy"|', cleaned)

    def test_fixes_colon_label_with_dotted_arrow(self):
        """A -.-> B : "label" → A -.->|"label"| B"""
        raw = 'graph TD\n    A -.-> B : "dotted"'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-.->|"dotted"|', cleaned)

    def test_multiple_edges_with_colon_labels(self):
        """複数行のコロンラベルがすべて修正される"""
        raw = 'graph TD\n    A --> B : "first"\n    B --> C : "second"\n    C --> D'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"first"|', cleaned)
        self.assertIn('-->|"second"|', cleaned)
        self.assertIn("C --> D", cleaned)

    def test_preserves_colon_inside_bracket_label(self):
        """ブラケット内のコロン A --> B["項目: 説明"] は保持"""
        raw = 'graph TD\n    A --> B["項目: 説明"]'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('B["項目: 説明"]', cleaned)

    def test_issue94_reproduction(self):
        """Issue #94 の再現ケース: SYSTEM_MONITOR : "影響を与える" """
        raw = 'graph TD\n    A["システム"] --> SYSTEM_MONITOR : "影響を与える"'
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"影響を与える"|', cleaned)
        self.assertIn("SYSTEM_MONITOR", cleaned)

    # === #94: flowchart 正規化拡張テスト ===

    def test_normalizes_flowchart_tb(self):
        raw = "flowchart TB\n    A --> B"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("graph TB"))

    def test_normalizes_flowchart_bt(self):
        raw = "flowchart BT\n    A --> B"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("graph BT"))

    def test_normalizes_flowchart_rl(self):
        raw = "flowchart RL\n    A --> B"
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertTrue(cleaned.startswith("graph RL"))


class TopLevelArrowScannerTests(unittest.TestCase):
    # === #112: top-level arrow scanner 直接テスト ===

    def test_count_simple_chain(self):
        self.assertEqual(_count_arrows_in_line("A --> B -.-> C"), 2)

    def test_count_three_mixed_arrows(self):
        self.assertEqual(_count_arrows_in_line("A -.-> B ==> C --> D"), 3)

    def test_count_ignores_arrow_inside_bracket(self):
        self.assertEqual(_count_arrows_in_line('A["x --> y: z"] --> B'), 1)

    def test_count_ignores_arrow_inside_pipe_label(self):
        self.assertEqual(_count_arrows_in_line('A -->|"label --> inner"| B'), 1)

    def test_count_no_arrows_in_subgraph_line(self):
        self.assertEqual(_count_arrows_in_line("subgraph cluster"), 0)

    def test_split_into_three_segments(self):
        self.assertEqual(_split_line_by_arrows("A --> B -.-> C"), ["A ", " B ", " C"])

    def test_split_empty_when_no_arrows(self):
        self.assertEqual(_split_line_by_arrows("A"), [])

    def test_odd_backslash_keeps_quote_open(self):
        """奇数本 `\\` 直後の `"` は escape 扱いで quote トグルしない。"""
        self.assertEqual(_count_arrows_in_line(r'A["x \" --> y"] --> B'), 1)

    def test_count_arrow_after_pipe_label(self):
        self.assertEqual(_count_arrows_in_line('A -->|x: y| B -.-> C'), 2)

    def test_unclosed_pipe_is_unsafe_terminal(self):
        scan = _scan_top_level_arrows('A -->|unclosed B --> C')
        self.assertTrue(scan.unsafe_terminal)

    def test_pipe_label_with_mixed_brackets(self):
        """pipe 中は bracket depth を更新しないため、pipe 外の矢印は正しくカウントされる。"""
        self.assertEqual(
            _count_arrows_in_line('A -->|"x [y] (z) {w}: q"| B -.-> C'),
            2,
        )

    def test_even_backslash_closes_quote(self):
        """偶数本 `\\` 直後の `"` は閉じ引用符として quote トグルする。"""
        self.assertEqual(_count_arrows_in_line(r'A["x\\"] --> B'), 1)

    def test_empty_pipe_label_counts_both_arrows(self):
        self.assertEqual(_count_arrows_in_line('A -->|| B -.-> C'), 2)

    def test_unclosed_quote_is_unsafe_terminal(self):
        scan = _scan_top_level_arrows('A --> B : "unclosed')
        self.assertTrue(scan.unsafe_terminal)

    def test_unclosed_bracket_is_unsafe_terminal(self):
        scan = _scan_top_level_arrows('A --> B["x : y')
        self.assertTrue(scan.unsafe_terminal)


class ResidualColonOnChainedEdgeTests(unittest.TestCase):
    # === #112: チェーン記法 + コロン残留の振る舞いテスト ===

    def _body(self, body: str) -> str:
        return f"graph TD\n    {body}"

    def test_issue112_reproduction_colon_before_arrow(self):
        raw = self._body("TASK_DESIGN_DRAFT: 担当 PERSON_TANAKA -.-> TASK_REVIEW")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_colon_between_arrows(self):
        raw = self._body("A --> B: ラベル C -.-> D")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_colon_only_before_arrow(self):
        raw = self._body("A: label --> B")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_japanese_label_in_chain(self):
        raw = self._body("開始 --> 中間: 処理中 -.-> 終了")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_colon_in_trailing_segment(self):
        raw = self._body("A --> B --> C: トレイリング")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_multiple_colons_in_chain(self):
        raw = self._body("A --> B: x --> C: y --> D")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_accepts_bracket_colon_in_chain(self):
        raw = self._body('A --> B["項目: 説明"] -.-> C')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_accepts_quoted_colon_in_last_node(self):
        raw = self._body('A --> B -.-> C["key:value"]')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_accepts_pipe_label_with_colon_inside(self):
        raw = self._body('A -->|"比率 70:30"| B')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_accepts_pure_chain_without_colon(self):
        raw = self._body("A --> B -.-> C ==> D")
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_accepts_arrow_inside_bracket_label(self):
        """ブラケット内の偽矢印を誤ってチェーン判定しない。"""
        raw = self._body('A["x --> y: z"] --> B')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_fixes_colon_label_with_bracket_arrow_in_target(self):
        """ブラケット内に矢印 + 矢印後コロンラベルが正しくパイプ形式に修正される。"""
        raw = self._body('A --> B["x -.-> y: z"] : "label"')
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"label"|', cleaned)

    def test_accepts_unquoted_colon_in_pipe_label(self):
        raw = self._body('A -->|70:30| B')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_accepts_pipe_label_followed_by_chain(self):
        raw = self._body('A -->|"x: y"| B -.-> C')
        self.assertIsNotNone(validate_and_clean_mermaid(raw))

    def test_fixes_colon_label_with_escaped_quote_in_bracket(self):
        raw = self._body(r'A["x \" --> y: z"] --> B : "label"')
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"label"|', cleaned)

    def test_rejects_unclosed_pipe(self):
        raw = self._body("A -->|unclosed B --> C")
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_fixes_colon_label_with_mixed_brackets_in_pipe(self):
        raw = self._body('A -->|"x [y] (z) {w}: q"| B : "label"')
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"label"|', cleaned)

    def test_fixes_colon_label_with_pipe_inside_bracket(self):
        """ブラケット内の `|` は pipe delimiter ではない (in_pipe トグルしない)。"""
        raw = self._body('A --> B["x | y"] : "label"')
        cleaned = validate_and_clean_mermaid(raw)
        self.assertIsNotNone(cleaned)
        self.assertIn('-->|"label"|', cleaned)

    def test_rejects_label_containing_pipe(self):
        """ラベル文字列に `|` がある場合は no-fix → 残留コロンで reject。"""
        raw = self._body('A --> B : "x | y"')
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_unclosed_quote(self):
        raw = self._body('A --> B : "unclosed')
        self.assertIsNone(validate_and_clean_mermaid(raw))

    def test_rejects_unclosed_bracket(self):
        raw = self._body('A --> B["x : y')
        self.assertIsNone(validate_and_clean_mermaid(raw))


if __name__ == "__main__":
    unittest.main()

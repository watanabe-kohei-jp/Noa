import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from agents.overview_diagram_utils import (  # noqa: E402
    LEGACY_TOPIC_ID,
    fnv1a_hex6,
    is_safe_topic_id,
    normalize_overview_diagrams,
    sanitize_target_topic_id,
    slugify_topic_id,
)


class NormalizeOverviewDiagramsTests(unittest.TestCase):
    def test_empty_session_returns_empty_list(self):
        self.assertEqual(normalize_overview_diagrams({}), [])
        self.assertEqual(normalize_overview_diagrams(None), [])

    def test_legacy_singular_is_wrapped_into_list(self):
        session = {
            "overviewDiagram": {
                "title": "旧概要図",
                "mermaidDefinition": "graph TD\nA-->B",
            }
        }
        result = normalize_overview_diagrams(session)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["topicId"], LEGACY_TOPIC_ID)
        self.assertEqual(result[0]["title"], "旧概要図")
        self.assertEqual(result[0]["mermaidDefinition"], "graph TD\nA-->B")
        self.assertEqual(result[0]["status"], "active")
        self.assertIn("createdAt", result[0])
        self.assertIn("lastUpdated", result[0])

    def test_new_field_as_list_is_passed_through(self):
        entries = [
            {"topicId": "t1", "title": "T1", "mermaidDefinition": "graph TD\nA",
             "status": "active", "createdAt": "2026-01-01T00:00:00Z", "lastUpdated": "2026-01-01T00:00:00Z"},
            {"topicId": "t2", "title": "T2", "mermaidDefinition": "graph TD\nB",
             "status": "closed", "createdAt": "2026-01-02T00:00:00Z", "lastUpdated": "2026-01-02T00:00:00Z"},
        ]
        result = normalize_overview_diagrams({"overviewDiagrams": entries})
        self.assertEqual(result, entries)

    def test_new_field_as_keyed_dict_sorted_by_created_at(self):
        keyed = {
            "t2": {"topicId": "t2", "title": "T2", "mermaidDefinition": "graph TD\nB",
                   "status": "active", "createdAt": "2026-01-02T00:00:00Z", "lastUpdated": "2026-01-02T00:00:00Z"},
            "t1": {"topicId": "t1", "title": "T1", "mermaidDefinition": "graph TD\nA",
                   "status": "active", "createdAt": "2026-01-01T00:00:00Z", "lastUpdated": "2026-01-01T00:00:00Z"},
        }
        result = normalize_overview_diagrams({"overviewDiagrams": keyed})
        self.assertEqual([e["topicId"] for e in result], ["t1", "t2"])

    def test_new_field_takes_precedence_over_legacy(self):
        session = {
            "overviewDiagram": {"title": "旧", "mermaidDefinition": "graph TD\nA"},
            "overviewDiagrams": [
                {"topicId": "t1", "title": "新", "mermaidDefinition": "graph TD\nB",
                 "status": "active", "createdAt": "2026-01-01T00:00:00Z", "lastUpdated": "2026-01-01T00:00:00Z"}
            ],
        }
        result = normalize_overview_diagrams(session)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["topicId"], "t1")
        self.assertEqual(result[0]["title"], "新")


class SlugifyTopicIdTests(unittest.TestCase):
    """P1 fix #6: slug は常に末尾に '_xxxxxx' (FNV-1a 6 桁 hex) を持つ。"""

    def test_basic_replacement_with_hash_suffix(self):
        slug = slugify_topic_id("Hello World")
        self.assertTrue(slug.startswith("Hello_World_"))
        # 末尾 hash 部は 6 文字 hex
        self.assertRegex(slug, r"^Hello_World_[0-9a-f]{6}$")

    def test_japanese_preserved_with_hash_suffix(self):
        slug = slugify_topic_id("会議のフェーズ")
        self.assertTrue(slug.startswith("会議のフェーズ_"))
        self.assertRegex(slug, r"^会議のフェーズ_[0-9a-f]{6}$")

    def test_firebase_forbidden_chars_replaced(self):
        slug = slugify_topic_id("a.b#c$d/e[f]g")
        self.assertTrue(slug.startswith("a_b_c_d_e_f_g_"))
        self.assertRegex(slug, r"^a_b_c_d_e_f_g_[0-9a-f]{6}$")

    def test_empty_returns_empty(self):
        self.assertEqual(slugify_topic_id(""), "")
        self.assertEqual(slugify_topic_id(None), "")
        self.assertEqual(slugify_topic_id("   "), "")  # 空白のみは空文字

    def test_long_text_truncated_within_limit(self):
        slug = slugify_topic_id("a" * 200)
        # 80 文字 (= 73 文字 body + '_' + 6 文字 hash) を超えない
        self.assertEqual(len(slug), 80)
        self.assertRegex(slug, r"^a{73}_[0-9a-f]{6}$")

    def test_truncation_collisions_disambiguated_by_hash(self):
        """73 文字を超える 2 つの異なる長文は同じ body prefix を持ちうるが、hash が異なる。"""
        long_a = "x" * 73 + "AAA"
        long_b = "x" * 73 + "BBB"
        slug_a = slugify_topic_id(long_a)
        slug_b = slugify_topic_id(long_b)
        # body 部分 (先頭 73 文字) は一致
        self.assertEqual(slug_a[:73], slug_b[:73])
        # しかし hash 部 (末尾 6 文字) が異なるため slug 全体は別物
        self.assertNotEqual(slug_a, slug_b)

    def test_same_input_produces_same_slug(self):
        """slugify は決定論的: 同じ入力は常に同じ出力。"""
        self.assertEqual(slugify_topic_id("設計議論"), slugify_topic_id("設計議論"))


class SanitizeTargetTopicIdTests(unittest.TestCase):
    """P1 fix #6: safe な ID は round-trip、unsafe なら slugify。"""

    def test_none_returns_none(self):
        self.assertIsNone(sanitize_target_topic_id(None))

    def test_wildcard_passes_through(self):
        self.assertEqual(sanitize_target_topic_id("*"), "*")

    def test_safe_ascii_passes_through(self):
        self.assertEqual(sanitize_target_topic_id("topic_a"), "topic_a")
        self.assertEqual(sanitize_target_topic_id("topic-1"), "topic-1")

    def test_safe_japanese_passes_through(self):
        # 日本語 + slug 風 suffix は path injection でないので round-trip 可能
        self.assertEqual(sanitize_target_topic_id("設計議論_a1b2c3"), "設計議論_a1b2c3")

    def test_path_injection_is_slugified(self):
        result = sanitize_target_topic_id("path/with#bad$chars")
        self.assertIsNotNone(result)
        self.assertNotIn("/", result)
        self.assertNotIn("#", result)
        self.assertNotIn("$", result)
        self.assertRegex(result, r"^path_with_bad_chars_[0-9a-f]{6}$")

    def test_newline_is_slugified(self):
        result = sanitize_target_topic_id("ab\ncd")
        # 改行を含む → unsafe → slugify (空白扱い → '_' 化)
        self.assertNotIn("\n", result)


class IsSafeTopicIdTests(unittest.TestCase):
    def test_safe_cases(self):
        self.assertTrue(is_safe_topic_id("topic_a"))
        self.assertTrue(is_safe_topic_id("設計議論_a1b2c3"))
        self.assertTrue(is_safe_topic_id("a"))

    def test_unsafe_cases(self):
        self.assertFalse(is_safe_topic_id(""))
        self.assertFalse(is_safe_topic_id(None))
        self.assertFalse(is_safe_topic_id("a/b"))
        self.assertFalse(is_safe_topic_id("a.b"))
        self.assertFalse(is_safe_topic_id("a#b"))
        self.assertFalse(is_safe_topic_id("a\nb"))
        self.assertFalse(is_safe_topic_id("a" * 81))


class Fnv1aHex6Tests(unittest.TestCase):
    """P1 fix #6: Python / TS で同一値を返すことが必要 (実装規約)。"""

    def test_known_vector_empty(self):
        # FNV-1a 32bit offset basis 0x811c9dc5 → 末尾 6 桁
        self.assertEqual(fnv1a_hex6(""), "1c9dc5")

    def test_returns_6_hex_chars(self):
        self.assertRegex(fnv1a_hex6("anything"), r"^[0-9a-f]{6}$")

    def test_deterministic(self):
        self.assertEqual(fnv1a_hex6("設計議論"), fnv1a_hex6("設計議論"))

    def test_different_inputs_likely_differ(self):
        self.assertNotEqual(fnv1a_hex6("topic_a"), fnv1a_hex6("topic_b"))


if __name__ == "__main__":
    unittest.main()

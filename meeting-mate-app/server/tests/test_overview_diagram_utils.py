import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from agents.overview_diagram_utils import (  # noqa: E402
    LEGACY_TOPIC_ID,
    normalize_overview_diagrams,
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
    def test_basic_replacement(self):
        self.assertEqual(slugify_topic_id("Hello World"), "Hello_World")

    def test_japanese_preserved(self):
        self.assertEqual(slugify_topic_id("会議のフェーズ"), "会議のフェーズ")

    def test_firebase_forbidden_chars_replaced(self):
        self.assertEqual(slugify_topic_id("a.b#c$d/e[f]g"), "a_b_c_d_e_f_g")

    def test_empty_returns_empty(self):
        self.assertEqual(slugify_topic_id(""), "")
        self.assertEqual(slugify_topic_id(None), "")

    def test_long_text_truncated(self):
        self.assertEqual(len(slugify_topic_id("a" * 200)), 80)


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from knowledge_base import (  # noqa: E402
    MOCK_DATA,
    SNIPPET_MAX_LENGTH,
    VALID_CATEGORIES,
    KnowledgeResult,
    MockKnowledgeBase,
    VectorKnowledgeBase,
    get_knowledge_base,
)


# ================================================================
# MockKnowledgeBase 回帰テスト
# ================================================================

class MockKnowledgeBaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.kb = MockKnowledgeBase()

    async def test_search_returns_results_for_keyword_match(self):
        results = await self.kb.search("売上")
        self.assertTrue(len(results) > 0)
        self.assertIsInstance(results[0], KnowledgeResult)
        self.assertEqual(results[0].source, "mock-knowledge-base")

    async def test_search_with_category_filter(self):
        results = await self.kb.search("売上", category="sales")
        for r in results:
            self.assertEqual(r.category, "sales")

    async def test_search_filters_out_other_categories(self):
        results = await self.kb.search("売上", category="policies")
        # "売上" は sales カテゴリなので policies では見つからない
        for r in results:
            self.assertEqual(r.category, "policies")

    async def test_search_returns_max_3_results(self):
        # 広いクエリでも最大3件
        results = await self.kb.search("プロジェクト 進捗 売上 経費 社員")
        self.assertLessEqual(len(results), 3)

    async def test_search_no_match_returns_empty(self):
        results = await self.kb.search("xyzzy_no_match_12345")
        self.assertEqual(results, [])

    async def test_to_dict_shape(self):
        results = await self.kb.search("売上")
        self.assertTrue(len(results) > 0)
        d = results[0].to_dict()
        self.assertIn("title", d)
        self.assertIn("content", d)
        self.assertIn("category", d)
        self.assertIn("relevance", d)
        self.assertIn("source", d)


# ================================================================
# VectorKnowledgeBase ユニットテスト
# ================================================================

class VectorKnowledgeBaseTests(unittest.IsolatedAsyncioTestCase):
    """ChromaDB と Gemini をモックしてテスト"""

    def _make_vector_kb(self, collection_mock=None):
        """VectorKnowledgeBase を外部依存なしで構築"""
        with patch("knowledge_base.chromadb") as mock_chromadb, \
             patch("knowledge_base.genai") as mock_genai:
            mock_client = MagicMock()
            mock_collection = collection_mock or MagicMock()
            mock_client.get_or_create_collection.return_value = mock_collection
            mock_chromadb.PersistentClient.return_value = mock_client

            mock_genai_client = MagicMock()
            mock_genai.Client.return_value = mock_genai_client

            kb = VectorKnowledgeBase()
            kb._genai_client_mock = mock_genai_client
            return kb

    def _mock_embedding(self, kb, embedding=None):
        """embedding 結果をモック"""
        if embedding is None:
            embedding = [0.1] * 768
        mock_result = MagicMock()
        mock_result.embeddings = [MagicMock(values=embedding)]
        kb._genai_client_mock.models.embed_content.return_value = mock_result
        kb.genai_client.models.embed_content.return_value = mock_result

    async def test_search_empty_collection_returns_empty(self):
        collection = MagicMock()
        collection.count.return_value = 0
        kb = self._make_vector_kb(collection)
        results = await kb.search("test query")
        self.assertEqual(results, [])

    async def test_search_empty_query_returns_empty(self):
        collection = MagicMock()
        collection.count.return_value = 5
        kb = self._make_vector_kb(collection)
        results = await kb.search("")
        self.assertEqual(results, [])

    async def test_search_returns_knowledge_results(self):
        collection = MagicMock()
        collection.count.return_value = 2
        collection.query.return_value = {
            "ids": [["doc1", "doc2"]],
            "distances": [[0.2, 0.5]],
            "documents": [["売上データの内容", "経費ルール"]],
            "metadatas": [[
                {"title": "売上データ", "category": "sales", "source": "test"},
                {"title": "経費ルール", "category": "policies", "source": "test"},
            ]],
        }
        kb = self._make_vector_kb(collection)
        self._mock_embedding(kb)

        results = await kb.search("売上")

        self.assertEqual(len(results), 2)
        self.assertIsInstance(results[0], KnowledgeResult)
        self.assertEqual(results[0].title, "売上データ")
        self.assertEqual(results[0].category, "sales")
        # relevance = 1.0 - distance
        self.assertAlmostEqual(results[0].relevance, 0.8, places=2)

    async def test_search_filters_by_distance_threshold(self):
        collection = MagicMock()
        collection.count.return_value = 2
        collection.query.return_value = {
            "ids": [["doc1", "doc2"]],
            "distances": [[0.3, 0.95]],  # doc2 > 0.8 threshold
            "documents": [["近い結果", "遠い結果"]],
            "metadatas": [[
                {"title": "近い", "category": "general"},
                {"title": "遠い", "category": "general"},
            ]],
        }
        kb = self._make_vector_kb(collection)
        self._mock_embedding(kb)

        results = await kb.search("test")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].title, "近い")

    async def test_search_with_category_passes_where_clause(self):
        collection = MagicMock()
        collection.count.return_value = 5
        collection.query.return_value = {
            "ids": [[]], "distances": [[]], "documents": [[]], "metadatas": [[]],
        }
        kb = self._make_vector_kb(collection)
        self._mock_embedding(kb)

        await kb.search("test", category="sales")

        call_kwargs = collection.query.call_args[1]
        self.assertEqual(call_kwargs["where"], {"category": "sales"})

    async def test_search_without_category_no_where_clause(self):
        collection = MagicMock()
        collection.count.return_value = 5
        collection.query.return_value = {
            "ids": [[]], "distances": [[]], "documents": [[]], "metadatas": [[]],
        }
        kb = self._make_vector_kb(collection)
        self._mock_embedding(kb)

        await kb.search("test")

        call_kwargs = collection.query.call_args[1]
        self.assertNotIn("where", call_kwargs)

    async def test_search_truncates_long_content_to_snippet(self):
        long_content = "あ" * 1000
        collection = MagicMock()
        collection.count.return_value = 1
        collection.query.return_value = {
            "ids": [["doc1"]],
            "distances": [[0.1]],
            "documents": [[long_content]],
            "metadatas": [[{"title": "長文", "category": "general"}]],
        }
        kb = self._make_vector_kb(collection)
        self._mock_embedding(kb)

        results = await kb.search("test")

        self.assertEqual(len(results), 1)
        self.assertLessEqual(len(results[0].content), SNIPPET_MAX_LENGTH + 3)  # +3 for "..."
        self.assertTrue(results[0].content.endswith("..."))

    def test_add_document_validates_category(self):
        kb = self._make_vector_kb()
        self._mock_embedding(kb)

        with self.assertRaises(ValueError) as ctx:
            kb.add_document("doc1", "Test", "Content", category="invalid_cat")
        self.assertIn("invalid_cat", str(ctx.exception))

    def test_add_document_accepts_valid_categories(self):
        kb = self._make_vector_kb()
        self._mock_embedding(kb)

        for cat in VALID_CATEGORIES:
            chunk_count = kb.add_document(f"doc_{cat}", "Test", "Content", category=cat)
            self.assertEqual(chunk_count, 1)

    def test_add_document_chunks_long_content(self):
        kb = self._make_vector_kb()
        self._mock_embedding(kb)

        long_content = "x" * 2500
        chunk_count = kb.add_document("doc1", "Long", long_content, max_chunk_size=1000)

        self.assertEqual(chunk_count, 3)
        # 3 chunks: 1000 + 1000 + 500
        calls = kb.collection.upsert.call_args_list
        self.assertEqual(len(calls), 3)
        # chunk IDs
        self.assertEqual(calls[0][1]["ids"], ["doc1::chunk_0"])
        self.assertEqual(calls[1][1]["ids"], ["doc1::chunk_1"])
        self.assertEqual(calls[2][1]["ids"], ["doc1::chunk_2"])

    def test_add_document_single_chunk_uses_plain_id(self):
        kb = self._make_vector_kb()
        self._mock_embedding(kb)

        chunk_count = kb.add_document("doc1", "Short", "Short content")

        self.assertEqual(chunk_count, 1)
        calls = kb.collection.upsert.call_args_list
        self.assertEqual(calls[0][1]["ids"], ["doc1"])


# ================================================================
# ファクトリ テスト
# ================================================================

class GetKnowledgeBaseTests(unittest.TestCase):

    def tearDown(self):
        # シングルトンをリセット
        import knowledge_base
        knowledge_base._kb_instance = None

    @patch.dict(os.environ, {"KNOWLEDGE_BASE_PROVIDER": "mock"}, clear=False)
    def test_returns_mock_by_default(self):
        # config をリロード
        with patch("knowledge_base.KNOWLEDGE_BASE_PROVIDER", "mock"):
            kb = get_knowledge_base()
            self.assertIsInstance(kb, MockKnowledgeBase)

    @patch("knowledge_base.KNOWLEDGE_BASE_PROVIDER", "vector")
    @patch("knowledge_base.chromadb")
    @patch("knowledge_base.genai")
    def test_returns_vector_when_configured(self, mock_genai, mock_chromadb):
        mock_client = MagicMock()
        mock_client.get_or_create_collection.return_value = MagicMock()
        mock_chromadb.PersistentClient.return_value = mock_client
        mock_genai.Client.return_value = MagicMock()

        kb = get_knowledge_base()
        self.assertIsInstance(kb, VectorKnowledgeBase)

    @patch("knowledge_base.KNOWLEDGE_BASE_PROVIDER", "vector")
    @patch("knowledge_base.chromadb")
    def test_falls_back_to_mock_on_init_failure(self, mock_chromadb):
        mock_chromadb.PersistentClient.side_effect = RuntimeError("ChromaDB init failed")

        kb = get_knowledge_base()
        self.assertIsInstance(kb, MockKnowledgeBase)

    @patch("knowledge_base.KNOWLEDGE_BASE_PROVIDER", "mock")
    def test_singleton_returns_same_instance(self):
        kb1 = get_knowledge_base()
        kb2 = get_knowledge_base()
        self.assertIs(kb1, kb2)


if __name__ == "__main__":
    unittest.main()

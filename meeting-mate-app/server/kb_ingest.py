"""ナレッジベースへのドキュメント投入スクリプト（Phase 1 用）

Usage:
    python kb_ingest.py --seed-mock              # MOCK_DATA を VectorKnowledgeBase に投入
    python kb_ingest.py --query "売上"            # 投入済みデータを検索テスト
    python kb_ingest.py --seed-mock --query "売上" # 投入 + 検索
    python kb_ingest.py --count                   # コレクション内のドキュメント数を表示

Requires:
    KNOWLEDGE_BASE_PROVIDER=vector
    GEMINI_API_KEY=...
"""
import argparse
import asyncio
import logging
import os
import sys

# server/ を sys.path に追加
sys.path.insert(0, os.path.dirname(__file__))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def seed_mock_data():
    """MOCK_DATA を VectorKnowledgeBase に投入"""
    from knowledge_base import MOCK_DATA, VectorKnowledgeBase

    kb = VectorKnowledgeBase()
    total_chunks = 0

    for i, entry in enumerate(MOCK_DATA):
        doc_id = f"mock_{i:03d}"
        chunks = kb.add_document(
            doc_id=doc_id,
            title=entry["title"],
            content=entry["content"],
            category=entry["category"],
            source="mock-seed",
        )
        total_chunks += chunks
        logger.info(f"  [{i + 1}/{len(MOCK_DATA)}] {entry['title']} ({chunks} chunk(s))")

    logger.info(f"Seeded {len(MOCK_DATA)} documents ({total_chunks} chunks total)")
    logger.info(f"Collection count: {kb.collection.count()}")


async def query_test(query: str):
    """VectorKnowledgeBase で検索テスト"""
    from knowledge_base import VectorKnowledgeBase

    kb = VectorKnowledgeBase()
    logger.info(f"Query: '{query}' (collection: {kb.collection.count()} docs)")

    results = await kb.search(query)

    if not results:
        logger.info("No results found.")
        return

    for i, r in enumerate(results):
        print(f"\n--- Result {i + 1} ---")
        print(f"  Title:     {r.title}")
        print(f"  Category:  {r.category}")
        print(f"  Relevance: {r.relevance}")
        print(f"  Source:    {r.source}")
        print(f"  Content:   {r.content[:200]}{'...' if len(r.content) > 200 else ''}")


def show_count():
    """コレクション内のドキュメント数を表示"""
    from knowledge_base import VectorKnowledgeBase
    kb = VectorKnowledgeBase()
    print(f"Collection 'knowledge_base' contains {kb.collection.count()} document(s)")


def main():
    parser = argparse.ArgumentParser(description="Knowledge Base ingestion tool (Phase 1)")
    parser.add_argument("--seed-mock", action="store_true", help="Seed MOCK_DATA into VectorKnowledgeBase")
    parser.add_argument("--query", type=str, help="Search query to test")
    parser.add_argument("--count", action="store_true", help="Show document count")
    args = parser.parse_args()

    if not any([args.seed_mock, args.query, args.count]):
        parser.print_help()
        sys.exit(1)

    if args.seed_mock:
        seed_mock_data()

    if args.query:
        asyncio.run(query_test(args.query))

    if args.count:
        show_count()


if __name__ == "__main__":
    main()

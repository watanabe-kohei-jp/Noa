"""
Knowledge Base — Provider パターンによるナレッジベース検索

- MockKnowledgeBase: ハードコードされたモックデータ（キーワードマッチング）
- VectorKnowledgeBase: ChromaDB + Gemini Embedding によるベクトル検索
- get_knowledge_base(): 環境変数 KNOWLEDGE_BASE_PROVIDER で切替（シングルトン）
"""
import asyncio
import logging
from datetime import datetime
from typing import Protocol, runtime_checkable

import chromadb
from google import genai

from config import (
    CHROMA_PERSIST_DIR,
    DEFAULT_GEMINI_API_KEY,
    EMBEDDING_MODEL,
    KB_MAX_SEARCH_DISTANCE,
    KNOWLEDGE_BASE_PROVIDER,
)

logger = logging.getLogger(__name__)

# ================================================================
# 共通定数
# ================================================================

VALID_CATEGORIES = {"sales", "policies", "projects", "general"}
SNIPPET_MAX_LENGTH = 500


# ================================================================
# データクラス
# ================================================================

class KnowledgeResult:
    def __init__(self, title: str, content: str, category: str, relevance: float, source: str = "mock"):
        self.title = title
        self.content = content
        self.category = category
        self.relevance = relevance
        self.source = source

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "content": self.content,
            "category": self.category,
            "relevance": self.relevance,
            "source": self.source,
        }


# ================================================================
# Protocol（search のみ）
# ================================================================

@runtime_checkable
class KnowledgeBase(Protocol):
    async def search(self, query: str, category: str | None = None) -> list[KnowledgeResult]: ...


# ================================================================
# Mock 実装
# ================================================================

MOCK_DATA = [
    {
        "title": "2025年度 四半期別売上",
        "content": "Q1: 12.5億円, Q2: 14.2億円, Q3: 13.8億円, Q4: 16.1億円。年間合計: 56.6億円。前年比 +8.3%。最も成長した製品はクラウドサービス（+23%）。",
        "category": "sales",
        "keywords": ["売上", "四半期", "年間", "revenue", "2025"],
    },
    {
        "title": "製品別売上構成比（2025年度）",
        "content": "クラウドサービス: 42% (23.7億円), SaaS製品: 28% (15.8億円), コンサルティング: 18% (10.2億円), その他: 12% (6.9億円)",
        "category": "sales",
        "keywords": ["製品", "構成比", "クラウド", "SaaS", "コンサル"],
    },
    {
        "title": "地域別売上（2025年度）",
        "content": "関東: 55%, 関西: 22%, 中部: 12%, 九州: 6%, 海外: 5%。海外売上は前年比+45%と急成長。主要海外市場は東南アジア。",
        "category": "sales",
        "keywords": ["地域", "関東", "関西", "海外", "東南アジア"],
    },
    {
        "title": "リモートワーク規定",
        "content": "週3日までリモートワーク可。コアタイム10:00-15:00。セキュリティ要件: VPN必須、個人端末禁止。月1回のオフィス出社義務あり。申請は1週間前まで。",
        "category": "policies",
        "keywords": ["リモート", "テレワーク", "在宅", "勤務", "VPN"],
    },
    {
        "title": "経費精算ルール",
        "content": "交通費: 実費精算（グリーン車不可）。交際費: 1人5,000円/回まで（事前承認必要）。出張: 日当3,000円。領収書は発生から1ヶ月以内に提出。",
        "category": "policies",
        "keywords": ["経費", "精算", "交通費", "交際費", "出張"],
    },
    {
        "title": "有給休暇制度",
        "content": "入社6ヶ月後に10日付与。最大20日/年。時間単位取得可（1時間単位）。繰越上限: 40日。消化率目標: 80%以上。5日連続取得推奨。",
        "category": "policies",
        "keywords": ["有給", "休暇", "休み", "消化", "繰越"],
    },
    {
        "title": "プロジェクトAlpha（新CRM導入）",
        "content": "進捗: 75%。フェーズ3（テスト）実施中。予算消化率: 68%。リスク: APIの応答速度が要件未達（目標200ms、実測350ms）。対策: キャッシュ層追加を検討中。リリース予定: 2026年4月。",
        "category": "projects",
        "keywords": ["Alpha", "CRM", "進捗", "テスト", "API"],
    },
    {
        "title": "プロジェクトBeta（AI チャットボット）",
        "content": "進捗: 40%。フェーズ2（開発）。予算消化率: 35%。成果: FAQ自動応答の精度92%達成。次ステップ: 多言語対応（英語・中国語）。リリース予定: 2026年7月。",
        "category": "projects",
        "keywords": ["Beta", "AI", "チャットボット", "FAQ", "多言語"],
    },
    {
        "title": "プロジェクトGamma（基幹システム刷新）",
        "content": "進捗: 15%。フェーズ1（要件定義）。予算: 2億円。主要課題: レガシーDBの移行計画。担当: 開発部・情シス合同チーム20名。リリース予定: 2027年3月。",
        "category": "projects",
        "keywords": ["Gamma", "基幹", "システム", "刷新", "レガシー", "DB"],
    },
    {
        "title": "社員数と組織構成",
        "content": "総社員数: 850名。エンジニア: 320名、営業: 180名、企画: 95名、管理: 85名、その他: 170名。平均年齢: 34.2歳。離職率: 8.5%。",
        "category": "general",
        "keywords": ["社員", "組織", "人数", "エンジニア", "離職"],
    },
    {
        "title": "今期の重点施策",
        "content": "1. AI活用推進（全部門でのAIツール導入）、2. 海外展開加速（東南アジア3カ国）、3. 人材育成（DX人材100名育成）、4. ESG経営推進（CO2排出30%削減）。",
        "category": "general",
        "keywords": ["重点", "施策", "AI", "海外", "DX", "ESG"],
    },
]


class MockKnowledgeBase:
    """モックナレッジベース - キーワードマッチングによる簡易検索"""

    async def search(self, query: str, category: str | None = None) -> list[KnowledgeResult]:
        query_lower = query.lower()

        entries = MOCK_DATA
        if category:
            entries = [e for e in entries if e["category"] == category]

        scored = []
        for entry in entries:
            score = 0
            # キーワードがクエリに含まれているかチェック（日本語対応）
            for kw in entry["keywords"]:
                if kw.lower() in query_lower:
                    score += 3
            # タイトルの部分一致
            if entry["title"].lower() in query_lower or query_lower in entry["title"].lower():
                score += 2
            # コンテンツの部分一致
            if query_lower in entry["content"].lower():
                score += 1
            if score > 0:
                scored.append((entry, score))

        scored.sort(key=lambda x: x[1], reverse=True)

        return [
            KnowledgeResult(
                title=e["title"],
                content=e["content"],
                category=e["category"],
                relevance=s,
                source="mock-knowledge-base",
            )
            for e, s in scored[:3]
        ]


# ================================================================
# Vector 実装（ChromaDB + Gemini Embedding）
# ================================================================

class VectorKnowledgeBase:
    """ChromaDB + Gemini Embedding によるベクトル検索ナレッジベース"""

    def __init__(self):
        self.chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
        self.collection = self.chroma_client.get_or_create_collection(
            name="knowledge_base",
            metadata={"hnsw:space": "cosine"},
        )
        self.genai_client = genai.Client(api_key=DEFAULT_GEMINI_API_KEY)
        logger.info(
            f"[KnowledgeBase] VectorKnowledgeBase initialized. "
            f"ChromaDB: {CHROMA_PERSIST_DIR}, Embedding: {EMBEDDING_MODEL}, "
            f"Documents: {self.collection.count()}"
        )

    async def _get_embedding(self, text: str) -> list[float]:
        """Gemini Embedding API でテキストをベクトル化（イベントループ非ブロック）"""
        def _sync_embed():
            result = self.genai_client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=text,
            )
            return result.embeddings[0].values
        return await asyncio.to_thread(_sync_embed)

    async def search(self, query: str, category: str | None = None) -> list[KnowledgeResult]:
        if not query or self.collection.count() == 0:
            return []

        query_embedding = await self._get_embedding(query)

        kwargs: dict = {
            "query_embeddings": [query_embedding],
            "n_results": min(3, self.collection.count()),
        }
        if category:
            kwargs["where"] = {"category": category}

        results = self.collection.query(**kwargs)

        knowledge_results = []
        if results and results["ids"] and results["ids"][0]:
            for i, doc_id in enumerate(results["ids"][0]):
                distance = results["distances"][0][i] if results["distances"] else None
                if distance is not None and distance > KB_MAX_SEARCH_DISTANCE:
                    continue
                meta = results["metadatas"][0][i] if results["metadatas"] else {}
                doc_text = results["documents"][0][i] if results["documents"] else ""

                # snippet: 先頭 SNIPPET_MAX_LENGTH 文字に切り詰め
                snippet = doc_text[:SNIPPET_MAX_LENGTH]
                if len(doc_text) > SNIPPET_MAX_LENGTH:
                    snippet += "..."

                knowledge_results.append(KnowledgeResult(
                    title=meta.get("title", "不明"),
                    content=snippet,
                    category=meta.get("category", "general"),
                    relevance=round(1.0 - (distance or 0.0), 3),
                    source=meta.get("source", "vector-knowledge-base"),
                ))

        return knowledge_results

    def add_document(
        self,
        doc_id: str,
        title: str,
        content: str,
        category: str = "general",
        source: str = "manual",
        max_chunk_size: int = 1000,
    ) -> int:
        """ドキュメントをベクトル化して ChromaDB に追加。長文は chunk 分割。

        Returns:
            投入された chunk 数
        """
        if category not in VALID_CATEGORIES:
            raise ValueError(
                f"Invalid category '{category}'. Must be one of: {sorted(VALID_CATEGORIES)}"
            )

        # chunk 分割
        chunks = []
        if len(content) <= max_chunk_size:
            chunks.append(content)
        else:
            for start in range(0, len(content), max_chunk_size):
                chunks.append(content[start:start + max_chunk_size])

        now = datetime.now().isoformat()
        for i, chunk in enumerate(chunks):
            chunk_id = doc_id if len(chunks) == 1 else f"{doc_id}::chunk_{i}"

            # 同期 embedding（add_document は CLI/バッチ用なので同期で OK）
            result = self.genai_client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=chunk,
            )
            embedding = result.embeddings[0].values

            self.collection.upsert(
                ids=[chunk_id],
                embeddings=[embedding],
                documents=[chunk],
                metadatas=[{
                    "title": title,
                    "category": category,
                    "source": source,
                    "added_at": now,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                }],
            )

        logger.info(
            f"[KnowledgeBase] Added document '{doc_id}' ({len(chunks)} chunk(s), "
            f"category={category})"
        )
        return len(chunks)


# ================================================================
# ファクトリ（シングルトン + フォールバック）
# ================================================================

_kb_instance: KnowledgeBase | None = None


def get_knowledge_base() -> KnowledgeBase:
    """設定に基づいて KnowledgeBase インスタンスを返す（シングルトン）。

    KNOWLEDGE_BASE_PROVIDER=vector の場合、初期化失敗時は MockKnowledgeBase にフォールバック。
    """
    global _kb_instance
    if _kb_instance is not None:
        return _kb_instance

    if KNOWLEDGE_BASE_PROVIDER == "vector":
        try:
            _kb_instance = VectorKnowledgeBase()
        except Exception as e:
            logger.warning(
                f"[KnowledgeBase] VectorKnowledgeBase initialization failed, "
                f"falling back to MockKnowledgeBase: {e}"
            )
            _kb_instance = MockKnowledgeBase()
    else:
        _kb_instance = MockKnowledgeBase()

    logger.info(f"[KnowledgeBase] Provider: {type(_kb_instance).__name__}")
    return _kb_instance

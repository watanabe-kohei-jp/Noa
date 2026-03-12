"""
Meeting Memory (RAG) モジュール

セッション横断メモリ: 会議終了時に要約を生成し、ベクトル検索で過去の会議を参照可能にする。
- 要約生成: gemini-2.5-flash (BRAIN_LLM_MODEL)
- Embedding: Gemini text-embedding-004
- ベクトルDB: ChromaDB (ファイルベース永続化)
"""
import logging
from typing import Optional

import chromadb
from firebase_admin import db as firebase_db
from google import genai

from config import (
    BRAIN_LLM_MODEL,
    CHROMA_PERSIST_DIR,
    DEFAULT_GEMINI_API_KEY,
    EMBEDDING_MODEL,
    get_default_api_key,
)
from llm_provider import detect_provider, llm_complete

logger = logging.getLogger(__name__)

SUMMARY_PROMPT = """以下の会議セッションのデータから、構造化された要約を日本語で生成してください。

## 会議名: {session_name}
## 日時: {started_at} ～ {ended_at}

## 発言記録
{transcript_text}

## タスク
{tasks_text}

## ノート・決定事項
{notes_text}

## 議題
{agenda_text}

以下の形式で要約してください:
1. 概要: 会議の目的と主な話題 (2-3文)
2. 決定事項: 会議で決まったこと (箇条書き)
3. アクションアイテム: 担当者と期限付きのタスク (箇条書き)
4. 未解決課題: 今後検討が必要な事項 (箇条書き)
5. キーワード: 検索用キーワード (カンマ区切り、5-10個)"""


class MeetingMemory:
    """セッション横断メモリ - 要約生成・ベクトル検索"""

    def __init__(self):
        self.chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
        self.collection = self.chroma_client.get_or_create_collection(
            name="meeting_summaries",
            metadata={"hnsw:space": "cosine"},
        )
        self.genai_client = genai.Client(api_key=DEFAULT_GEMINI_API_KEY)
        logger.info(
            f"[MeetingMemory] Initialized. ChromaDB: {CHROMA_PERSIST_DIR}, "
            f"Embedding: {EMBEDDING_MODEL}"
        )

    def _get_embedding(self, text: str) -> list[float]:
        """Gemini Embedding API でテキストをベクトル化"""
        result = self.genai_client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text,
        )
        return result.embeddings[0].values

    async def generate_summary(self, room_id: str, session_id: str) -> tuple[str, dict]:
        """Firebase からセッションデータを取得し、LLM で要約を生成

        Returns:
            (summary_text, metadata_dict)
        """
        session_path = f"rooms/{room_id}/sessions/{session_id}"
        session_data = firebase_db.reference(session_path).get() or {}

        if not session_data:
            logger.warning(f"[MeetingMemory] Session data not found: {session_path}")
            return "", {}

        session_name = session_data.get("name", "無題のセッション")
        started_at = session_data.get("startedAt", "不明")
        ended_at = session_data.get("endedAt", "不明")

        # トランスクリプト整形
        transcript_raw = session_data.get("transcript", {})
        if isinstance(transcript_raw, dict):
            transcript_list = sorted(
                transcript_raw.values(),
                key=lambda t: t.get("timestamp", ""),
            )
        elif isinstance(transcript_raw, list):
            transcript_list = transcript_raw
        else:
            transcript_list = []

        if not transcript_list:
            logger.warning(f"[MeetingMemory] No transcript for session: {session_path}")
            return "", {}

        transcript_text = "\n".join(
            f"{t.get('userName', t.get('userId', '?'))}: {t.get('text', '')}"
            for t in transcript_list
        )
        # トランスクリプトが長すぎる場合は末尾を優先
        if len(transcript_text) > 15000:
            transcript_text = "(...前半省略...)\n" + transcript_text[-15000:]

        # タスク整形
        tasks_raw = session_data.get("tasks", {})
        if isinstance(tasks_raw, dict):
            tasks_list = list(tasks_raw.values())
        elif isinstance(tasks_raw, list):
            tasks_list = tasks_raw
        else:
            tasks_list = []
        tasks_text = "\n".join(
            f"- {t.get('title', '?')} (担当: {t.get('assignee', '未割当')}, "
            f"状態: {t.get('status', '?')})"
            for t in tasks_list
        ) or "なし"

        # ノート整形
        notes_raw = session_data.get("notes", {})
        if isinstance(notes_raw, dict):
            notes_list = list(notes_raw.values())
        elif isinstance(notes_raw, list):
            notes_list = notes_raw
        else:
            notes_list = []
        notes_text = "\n".join(
            f"- [{n.get('type', '?')}] {n.get('text', '')}"
            for n in notes_list
        ) or "なし"

        # 議題整形
        agenda = session_data.get("currentAgenda", {})
        if agenda:
            details = agenda.get("details", [])
            detail_texts = [d.get("text", "") for d in details] if isinstance(details, list) else []
            agenda_text = f"{agenda.get('mainTopic', '?')}\n" + "\n".join(
                f"  - {d}" for d in detail_texts
            )
        else:
            agenda_text = "なし"

        # LLM で要約生成
        provider = detect_provider(BRAIN_LLM_MODEL)
        api_key = get_default_api_key(provider) or DEFAULT_GEMINI_API_KEY

        prompt = SUMMARY_PROMPT.format(
            session_name=session_name,
            started_at=started_at,
            ended_at=ended_at,
            transcript_text=transcript_text,
            tasks_text=tasks_text,
            notes_text=notes_text,
            agenda_text=agenda_text,
        )

        summary = await llm_complete(
            model=BRAIN_LLM_MODEL,
            prompt=prompt,
            api_key=api_key,
            temperature=0.3,
            max_tokens=2000,
        )

        metadata = {
            "room_id": room_id,
            "session_id": session_id,
            "session_name": session_name,
            "started_at": started_at,
            "ended_at": ended_at,
            "transcript_count": len(transcript_list),
            "task_count": len(tasks_list),
        }

        return summary.strip(), metadata

    async def store_summary(
        self,
        room_id: str,
        session_id: str,
        summary: str,
        metadata: dict,
    ) -> None:
        """要約をベクトル化して ChromaDB に保存 + Firebase にも保存"""
        doc_id = f"{room_id}_{session_id}"

        # Embedding 生成
        embedding = self._get_embedding(summary)

        # ChromaDB に upsert
        self.collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[summary],
            metadatas=[metadata],
        )
        logger.info(f"[MeetingMemory] Stored in ChromaDB: {doc_id}")

        # Firebase にも要約を保存
        summary_ref = firebase_db.reference(
            f"rooms/{room_id}/sessions/{session_id}/summary"
        )
        summary_ref.set(summary)
        logger.info(f"[MeetingMemory] Stored summary in Firebase: {room_id}/{session_id}")

    async def search(
        self,
        query: str,
        room_id: Optional[str] = None,
        n_results: int = 3,
    ) -> list[dict]:
        """クエリで過去の会議要約を検索"""
        if not query:
            return []

        # コレクションが空の場合
        if self.collection.count() == 0:
            return []

        query_embedding = self._get_embedding(query)

        kwargs: dict = {
            "query_embeddings": [query_embedding],
            "n_results": min(n_results, self.collection.count()),
        }
        if room_id:
            kwargs["where"] = {"room_id": room_id}

        results = self.collection.query(**kwargs)

        formatted = []
        if results and results["ids"] and results["ids"][0]:
            for i, doc_id in enumerate(results["ids"][0]):
                entry = {
                    "id": doc_id,
                    "summary": results["documents"][0][i] if results["documents"] else "",
                    "distance": results["distances"][0][i] if results["distances"] else None,
                }
                if results["metadatas"] and results["metadatas"][0]:
                    entry["metadata"] = results["metadatas"][0][i]
                formatted.append(entry)

        return formatted

    async def process_ended_session(self, room_id: str, session_id: str) -> dict:
        """セッション終了時の一連の処理: 要約生成 → 保存 → ベクトル化"""
        # ステータス追跡
        status_ref = firebase_db.reference(
            f"rooms/{room_id}/sessions/{session_id}/summary_status"
        )
        status_ref.set("processing")

        try:
            summary, metadata = await self.generate_summary(room_id, session_id)

            if not summary:
                status_ref.set("skipped_no_transcript")
                logger.info(
                    f"[MeetingMemory] Skipped (no transcript): {room_id}/{session_id}"
                )
                return {"status": "skipped", "reason": "no transcript"}

            await self.store_summary(room_id, session_id, summary, metadata)
            status_ref.set("completed")
            logger.info(
                f"[MeetingMemory] Completed: {room_id}/{session_id} "
                f"({len(summary)} chars)"
            )
            return {"status": "completed", "summary_length": len(summary)}

        except Exception as e:
            logger.error(
                f"[MeetingMemory] Failed for {room_id}/{session_id}: {e}",
                exc_info=True,
            )
            status_ref.set(f"error: {str(e)[:200]}")
            return {"status": "error", "error": str(e)}

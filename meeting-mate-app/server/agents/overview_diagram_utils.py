"""Overview diagram utilities (Issue #131).

論点 (topic) 単位の概要図リストへ移行するための shim と共通ヘルパ。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


LEGACY_TOPIC_ID = "legacy"
GENERAL_TOPIC_ID = "_general"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify_topic_id(text: Optional[str]) -> str:
    """日本語含む mainTopic を topicId に変換する。"""
    if not text:
        return ""
    # 制御文字除去 + 空白 → '_'
    slug = re.sub(r"\s+", "_", text.strip())
    # Firebase キーで禁止される文字を '_' に
    slug = re.sub(r"[.#$\[\]/]", "_", slug)
    return slug[:80] or ""


def normalize_overview_diagrams(session_data: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """旧 overviewDiagram (単数) と新 overviewDiagrams (list or keyed dict) を吸収して list を返す。

    呼び出し側はこの結果を読み出し専用で扱う前提。
    """
    if not session_data:
        return []

    new_field = session_data.get("overviewDiagrams")
    if isinstance(new_field, list):
        return [d for d in new_field if isinstance(d, dict)]
    if isinstance(new_field, dict):
        # Firebase keyed-dict 形式 (createdAt 昇順で sort)
        entries = [v for v in new_field.values() if isinstance(v, dict)]
        entries.sort(key=lambda e: e.get("createdAt", ""))
        return entries

    legacy = session_data.get("overviewDiagram")
    if isinstance(legacy, dict) and legacy.get("mermaidDefinition"):
        now = _now_iso()
        return [{
            "topicId": LEGACY_TOPIC_ID,
            "title": legacy.get("title") or "概要図",
            "mermaidDefinition": legacy.get("mermaidDefinition", ""),
            "status": "active",
            "createdAt": now,
            "lastUpdated": now,
        }]

    return []


def make_entry(
    topic_id: str,
    title: str,
    mermaid_definition: str,
    status: str = "active",
    created_at: Optional[str] = None,
    last_updated: Optional[str] = None,
) -> Dict[str, Any]:
    now = _now_iso()
    return {
        "topicId": topic_id,
        "title": title,
        "mermaidDefinition": mermaid_definition,
        "status": status,
        "createdAt": created_at or now,
        "lastUpdated": last_updated or now,
    }

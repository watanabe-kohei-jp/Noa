"""Overview diagram utilities (Issue #131).

論点 (topic) 単位の概要図リストへ移行するための shim と共通ヘルパ。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


LEGACY_TOPIC_ID = "legacy"
GENERAL_TOPIC_ID = "_general"

# slug 末尾に付与するハッシュサフィックスの長さ (Issue #131 P1 fix #6)
_SLUG_HASH_LEN = 6
# slug 全体の最大長 (Firebase キー制約 + UI 視認性)
_SLUG_MAX_LEN = 80
# ハッシュサフィックス込みで切る本体部分の最大長 = MAX - "_" - HASH_LEN
_SLUG_BODY_MAX = _SLUG_MAX_LEN - 1 - _SLUG_HASH_LEN  # 80 - 1 - 6 = 73


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fnv1a_hex6(text: str) -> str:
    """FNV-1a 32bit hash の hex 下 6 桁を返す (TS 側と同一実装で衝突回避用)。"""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"[-_SLUG_HASH_LEN:]


def is_safe_topic_id(s: Optional[str]) -> bool:
    """既に Firebase-safe な topicId かを判定する (Issue #131 P1 fix #6 関連)。

    Firebase Realtime DB のキー禁止文字 (`.` `#` `$` `[` `]` `/`) と
    改行を含まず、80 字以内なら slug 化済みとみなす。
    例: "topic_a" / "設計議論_a1b2c3" → True / "path/with#bad" → False
    """
    if not s or not isinstance(s, str):
        return False
    if len(s) > _SLUG_MAX_LEN:
        return False
    if "\n" in s or "\r" in s:
        return False
    return not bool(re.search(r"[.#$\[\]/]", s))


def slugify_topic_id(text: Optional[str]) -> str:
    """日本語含む mainTopic を Firebase-safe な topicId に変換する。

    Issue #131 P1 fix #6: truncation や禁止文字 → '_' 化での衝突を避けるため、
    元テキストの FNV-1a 32bit ハッシュ末尾 6 桁を `_xxxxxx` として常に付与する。
    例: "設計議論" → "設計議論_a1b2c3" (元 4 文字、結果 11 文字)
    """
    if not text:
        return ""
    raw = text.strip()
    if not raw:
        return ""
    # 制御文字除去 + 空白 → '_'
    body = re.sub(r"\s+", "_", raw)
    # Firebase キーで禁止される文字を '_' に
    body = re.sub(r"[.#$\[\]/]", "_", body)
    if len(body) > _SLUG_BODY_MAX:
        body = body[:_SLUG_BODY_MAX]
    return f"{body}_{fnv1a_hex6(raw)}"


def sanitize_target_topic_id(value: Optional[str]) -> Optional[str]:
    """dispatcher / agent の入口で target_topic_id を検証する。

    Firebase-safe ならそのまま通し、unsafe なら slugify を適用する。
    round-trip 性を保ちつつ path injection を防ぐ二重防御の共通実装。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    if value == "*":
        return "*"
    if is_safe_topic_id(value):
        return value
    sanitized = slugify_topic_id(value)
    return sanitized or None


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

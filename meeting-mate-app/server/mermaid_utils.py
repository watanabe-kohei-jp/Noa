"""
Mermaid コードのバリデーション・サニタイズユーティリティ

Brain の generate_diagram と overview_diagram_agent で共通利用する。
"""
import re
import logging

logger = logging.getLogger(__name__)

# 図タイプファミリー定義
FLOWCHART_PREFIXES = [
    "graph TD", "graph LR",
    "flowchart TD", "flowchart LR", "flowchart TB", "flowchart BT", "flowchart RL",
]
SEQUENCE_PREFIXES = ["sequenceDiagram"]
GANTT_PREFIXES = ["gantt"]
MINDMAP_PREFIXES = ["mindmap"]
PIE_PREFIXES = ["pie"]

DIAGRAM_FAMILY_MAP: dict[str, list[str]] = {
    "flowchart": FLOWCHART_PREFIXES,
    "sequence": SEQUENCE_PREFIXES,
    "gantt": GANTT_PREFIXES,
    "mindmap": MINDMAP_PREFIXES,
    "pie": PIE_PREFIXES,
}

ALL_ALLOWED_PREFIXES = (
    FLOWCHART_PREFIXES + SEQUENCE_PREFIXES +
    GANTT_PREFIXES + MINDMAP_PREFIXES + PIE_PREFIXES
)


def _build_allowed_prefixes(allowed_types: list[str] | None) -> list[str]:
    """allowed_types から許可プレフィックスリストを組み立てる。"""
    if allowed_types is None:
        return ALL_ALLOWED_PREFIXES
    prefixes: list[str] = []
    for family in allowed_types:
        prefixes.extend(DIAGRAM_FAMILY_MAP.get(family, []))
    return prefixes


def _is_allowed_diagram_type(text: str, allowed_prefixes: list[str]) -> bool:
    """先頭が許可された図タイプで始まるかチェック。"""
    for prefix in allowed_prefixes:
        if text.startswith(prefix):
            return True
    return False


def validate_and_clean_mermaid(raw_text: str, allowed_types: list[str] | None = None) -> str | None:
    """LLM 生成 Mermaid コードのバリデーション + サニタイズ。

    Args:
        raw_text: LLM が生成した生テキスト。
        allowed_types: 許可する図タイプファミリー名のリスト。
                       None = 全タイプ許可。
                       例: ["flowchart"] = flowchart 系のみ許可。

    Returns:
        クリーン済み Mermaid コード。不正な場合は None。
    """
    if not raw_text or not raw_text.strip():
        return None

    cleaned = raw_text.strip()

    # 1. コードブロック除去
    if cleaned.startswith("```mermaid"):
        cleaned = cleaned[10:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
    elif cleaned.startswith("`") and cleaned.endswith("`"):
        cleaned = cleaned[1:-1].strip()

    # 2. flowchart TD/LR → graph TD/LR 正規化 (#59 で追加)
    if cleaned.startswith("flowchart TD"):
        cleaned = "graph TD" + cleaned[len("flowchart TD"):]
    elif cleaned.startswith("flowchart LR"):
        cleaned = "graph LR" + cleaned[len("flowchart LR"):]

    # 3. 許可された図タイプかチェック
    allowed_prefixes = _build_allowed_prefixes(allowed_types)
    if not _is_allowed_diagram_type(cleaned, allowed_prefixes):
        logger.warning(
            f"[mermaid_utils] Mermaid code doesn't match allowed types: {cleaned[:50]}..."
        )
        return None

    # 4. 危険ディレクティブ除去
    lines = cleaned.splitlines()
    safe_lines = []
    for line in lines:
        stripped = line.strip().lower()
        # click ディレクティブ: 行頭の Mermaid 構文のみ除去（メッセージ文中は許容）
        if re.match(r'^\s*click\s+\w+', stripped):
            logger.warning(f"[mermaid_utils] Removed dangerous 'click' directive: {line.strip()}")
            continue
        # javascript: は行中どこでも危険
        if 'javascript:' in stripped:
            logger.warning(f"[mermaid_utils] Removed 'javascript:' directive: {line.strip()}")
            continue
        # href ディレクティブ: 行頭の Mermaid 構文のみ除去
        if re.match(r'^\s*href\s+', stripped):
            logger.warning(f"[mermaid_utils] Removed 'href' directive: {line.strip()}")
            continue
        # %%{...}%% directive 全般を拒否
        if re.search(r'%%\s*\{', stripped):
            logger.warning(f"[mermaid_utils] Removed '%%{{...}}' directive: {line.strip()}")
            continue
        safe_lines.append(line)

    # 5. コメント修正 (% → %%, Unicode 除去)
    corrected_lines = []
    for line in safe_lines:
        stripped_line = line.lstrip()
        if stripped_line.startswith("%") and not stripped_line.startswith("%%"):
            comment_text = stripped_line[1:].strip()
            comment_text = comment_text.encode("ascii", "ignore").decode("ascii")
            if comment_text:
                corrected_lines.append(line.split("%")[0] + "%% " + comment_text)
            else:
                corrected_lines.append(line.split("%")[0] + "%% Comment")
        elif stripped_line.startswith("%%"):
            comment_text = stripped_line[2:].strip()
            comment_text = comment_text.encode("ascii", "ignore").decode("ascii")
            if comment_text:
                corrected_lines.append(line.split("%%")[0] + "%% " + comment_text)
            else:
                corrected_lines.append(line.split("%%")[0] + "%% Comment")
        else:
            corrected_lines.append(line)

    result = "\n".join(corrected_lines).strip()

    # 6. 最終チェック
    if not result:
        return None

    return result

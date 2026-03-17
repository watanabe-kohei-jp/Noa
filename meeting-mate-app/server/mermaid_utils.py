"""
Mermaid コードのバリデーション・サニタイズユーティリティ

Brain の generate_diagram と overview_diagram_agent で共通利用する。
"""
import re
import logging

logger = logging.getLogger(__name__)


def validate_and_clean_mermaid(raw_text: str) -> str | None:
    """LLM 生成 Mermaid コードのバリデーション + サニタイズ。

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

    # 2. graph TD/LR で始まるかチェック
    if not (cleaned.startswith("graph TD") or cleaned.startswith("graph LR")):
        logger.warning(
            f"[mermaid_utils] Mermaid code doesn't start with 'graph TD/LR': {cleaned[:50]}..."
        )
        return None

    # 3. 危険ディレクティブ除去
    lines = cleaned.splitlines()
    safe_lines = []
    for line in lines:
        stripped = line.strip().lower()
        # click, href, javascript: を含む行を除去
        if re.search(r'\bclick\b', stripped):
            logger.warning(f"[mermaid_utils] Removed dangerous 'click' directive: {line.strip()}")
            continue
        if 'javascript:' in stripped:
            logger.warning(f"[mermaid_utils] Removed 'javascript:' directive: {line.strip()}")
            continue
        if re.search(r'\bhref\b', stripped):
            logger.warning(f"[mermaid_utils] Removed 'href' directive: {line.strip()}")
            continue
        # %%{init を含む行を除去
        if '%%{init' in stripped or '%%{ init' in stripped:
            logger.warning(f"[mermaid_utils] Removed '%%{{init}}' directive: {line.strip()}")
            continue
        safe_lines.append(line)

    # 4. コメント修正 (% → %%, Unicode 除去)
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

    # 5. 最終チェック
    if not result:
        return None

    return result

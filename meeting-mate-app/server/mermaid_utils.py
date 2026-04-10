"""
Mermaid コードのバリデーション・サニタイズユーティリティ

Brain の generate_diagram と overview_diagram_agent で共通利用する。
"""
import re
import logging

logger = logging.getLogger(__name__)

# 図タイプファミリー定義
FLOWCHART_PREFIXES = [
    "graph TD", "graph LR", "graph TB", "graph BT", "graph RL",
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


# 矢印トークン (長い順: 部分マッチ防止)
_ARROW_TOKENS = ['---->', '===>', '--->', '==>', '-...->', '-..->',  '-.->', '-->']

# 非エッジ行の先頭キーワード
_NON_EDGE_PREFIXES = (
    'graph ', 'flowchart ', 'subgraph', 'end',
    'classDef', 'class ', '%%', '%', 'style ', 'linkStyle',
)


def _find_colon_outside_brackets(text: str) -> int:
    """括弧 ([], (), {}) とクォート ("") の外にある最初の `:` の位置を返す。見つからなければ -1。"""
    depth_square = 0
    depth_paren = 0
    depth_curly = 0
    in_quotes = False
    for i, ch in enumerate(text):
        if ch == '"' and (i == 0 or text[i - 1] != '\\'):
            in_quotes = not in_quotes
            continue
        if in_quotes:
            continue
        if ch == '[':
            depth_square += 1
        elif ch == ']':
            depth_square = max(0, depth_square - 1)
        elif ch == '(':
            depth_paren += 1
        elif ch == ')':
            depth_paren = max(0, depth_paren - 1)
        elif ch == '{':
            depth_curly += 1
        elif ch == '}':
            depth_curly = max(0, depth_curly - 1)
        elif ch == ':' and depth_square == 0 and depth_paren == 0 and depth_curly == 0:
            return i
    return -1


def _count_arrows_in_line(line: str) -> int:
    """行内の矢印トークン数を返す（チェーン記法の検出用）。"""
    count = 0
    remaining = line
    while remaining:
        found = False
        for token in _ARROW_TOKENS:
            idx = remaining.find(token)
            if idx != -1:
                count += 1
                remaining = remaining[idx + len(token):]
                found = True
                break
        if not found:
            break
    return count


def _fix_flowchart_colon_labels(line: str) -> str:
    """フローチャートの `A --> B : "label"` を `A -->|"label"| B` に修正する。

    修正不能な場合は元の行をそのまま返す（残留コロン検証で検出）。
    """
    stripped = line.strip()

    # 非エッジ行をスキップ
    if not stripped or stripped.startswith(_NON_EDGE_PREFIXES):
        return line

    # 既に正しい dash-label 形式 (A -- "label" --> B) はスキップ
    if re.search(r'--\s*"[^"]*"\s*-->', stripped):
        return line

    # チェーン記法（矢印2つ以上）の場合は修正不能 → そのまま返す
    if _count_arrows_in_line(stripped) >= 2:
        return line

    # 矢印トークンを検索
    arrow_idx = -1
    arrow_token = None
    for token in _ARROW_TOKENS:
        idx = stripped.find(token)
        if idx != -1:
            arrow_idx = idx
            arrow_token = token
            break
    if arrow_idx == -1:
        return line

    after_arrow = stripped[arrow_idx + len(arrow_token):]

    # 矢印後の部分から括弧外の `:` を探す
    colon_pos = _find_colon_outside_brackets(after_arrow)
    if colon_pos == -1:
        return line

    target = after_arrow[:colon_pos].strip()
    label_raw = after_arrow[colon_pos + 1:].strip().rstrip(';').strip()

    if not target or not label_raw:
        return line

    # ラベルをクォート
    if not label_raw.startswith('"'):
        label_raw = f'"{label_raw}"'

    before_arrow = stripped[:arrow_idx].rstrip()
    indent = line[:len(line) - len(line.lstrip())]

    return f'{indent}{before_arrow} {arrow_token}|{label_raw}| {target}'


def _has_residual_colon_on_edge(line: str) -> bool:
    """フローチャートエッジ行に括弧外の `:` が残っているかチェック。"""
    stripped = line.strip()
    if not stripped or stripped.startswith(_NON_EDGE_PREFIXES):
        return False

    # 矢印がない行はエッジではない
    has_arrow = False
    for token in _ARROW_TOKENS:
        if token in stripped:
            has_arrow = True
            # 矢印後の部分のみチェック
            after = stripped[stripped.find(token) + len(token):]
            # 既にパイプラベル形式なら OK
            if re.search(r'\|[^|]*\|', after):
                return False
            if _find_colon_outside_brackets(after) != -1:
                return True
            break

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

    # 2. flowchart → graph 正規化 (#59 で追加, #94 で TB/BT/RL 追加)
    for fc_prefix, g_prefix in [
        ("flowchart TD", "graph TD"),
        ("flowchart LR", "graph LR"),
        ("flowchart TB", "graph TB"),
        ("flowchart BT", "graph BT"),
        ("flowchart RL", "graph RL"),
    ]:
        if cleaned.startswith(fc_prefix):
            cleaned = g_prefix + cleaned[len(fc_prefix):]
            break

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

    # 5. フローチャート構文修正 (#94)
    first_line = safe_lines[0].strip() if safe_lines else ""
    is_flowchart = any(first_line.startswith(p) for p in FLOWCHART_PREFIXES)

    if is_flowchart:
        # 5a. コロン記法 → パイプ記法変換
        safe_lines = [_fix_flowchart_colon_labels(line) for line in safe_lines]

        # 5b. 残留コロン検証 — 修正できなかったら None → retry
        for line in safe_lines:
            if _has_residual_colon_on_edge(line):
                logger.warning(
                    f"[mermaid_utils] Residual colon in flowchart edge, rejecting: {line.strip()}"
                )
                return None

    # 6. コメント修正 (% → %%, Unicode 除去)
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

    # 7. 最終チェック
    if not result:
        return None

    return result

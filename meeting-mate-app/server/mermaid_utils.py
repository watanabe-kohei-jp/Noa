"""
Mermaid コードのバリデーション・サニタイズユーティリティ

Brain の generate_diagram と overview_diagram_agent で共通利用する。
"""
import re
import logging
from typing import NamedTuple

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


def _is_escaped_at(text: str, i: int) -> bool:
    """位置 i の文字が直前の連続するバックスラッシュで escape されているかを奇偶判定で返す。"""
    count = 0
    j = i - 1
    while j >= 0 and text[j] == '\\':
        count += 1
        j -= 1
    return count % 2 == 1


def _find_colon_outside_brackets(text: str) -> int:
    """ブラケット `[](){}` / クォート `""` / パイプラベル `|...|` の外にある最初の `:` の位置を返す。
    見つからなければ -1。
    """
    depth_square = 0
    depth_paren = 0
    depth_curly = 0
    in_quotes = False
    in_pipe = False
    for i, ch in enumerate(text):
        # 1. quote toggle (escape 奇偶を判定)
        if ch == '"' and not _is_escaped_at(text, i):
            in_quotes = not in_quotes
            continue
        if in_quotes:
            continue
        # 2. pipe 中は bracket depth を更新しない
        if not in_pipe:
            if ch == '[':
                depth_square += 1
                continue
            if ch == ']':
                depth_square = max(0, depth_square - 1)
                continue
            if ch == '(':
                depth_paren += 1
                continue
            if ch == ')':
                depth_paren = max(0, depth_paren - 1)
                continue
            if ch == '{':
                depth_curly += 1
                continue
            if ch == '}':
                depth_curly = max(0, depth_curly - 1)
                continue
        # 3. top-level で pipe toggle
        if depth_square == 0 and depth_paren == 0 and depth_curly == 0 and ch == '|':
            in_pipe = not in_pipe
            continue
        if in_pipe:
            continue
        # 4. top-level での colon 検出
        if ch == ':' and depth_square == 0 and depth_paren == 0 and depth_curly == 0:
            return i
    return -1


class ScanResult(NamedTuple):
    arrows: list[tuple[int, str]]
    unsafe_terminal: bool


def _scan_top_level_arrows(line: str) -> ScanResult:
    """行内の top-level (ブラケット/クォート/パイプラベル外) の矢印トークンをスキャン。

    Returns:
        ScanResult(arrows=[(位置, トークン), ...], unsafe_terminal=bool)
        unsafe_terminal は行末時点で in_pipe / in_quotes / 残ブラケット深度>0
        のいずれかなら True (未閉鎖構文 → バリデータで reject する)。
    """
    arrows: list[tuple[int, str]] = []
    depth_square = 0
    depth_paren = 0
    depth_curly = 0
    in_quotes = False
    in_pipe = False
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        # 1. quote toggle (escape 奇偶を判定)
        if ch == '"' and not _is_escaped_at(line, i):
            in_quotes = not in_quotes
            i += 1
            continue
        if in_quotes:
            i += 1
            continue
        # 2. pipe 中は bracket depth を更新しない
        if not in_pipe:
            if ch == '[':
                depth_square += 1
                i += 1
                continue
            if ch == ']':
                depth_square = max(0, depth_square - 1)
                i += 1
                continue
            if ch == '(':
                depth_paren += 1
                i += 1
                continue
            if ch == ')':
                depth_paren = max(0, depth_paren - 1)
                i += 1
                continue
            if ch == '{':
                depth_curly += 1
                i += 1
                continue
            if ch == '}':
                depth_curly = max(0, depth_curly - 1)
                i += 1
                continue
        # 3. top-level で pipe toggle
        if depth_square == 0 and depth_paren == 0 and depth_curly == 0 and ch == '|':
            in_pipe = not in_pipe
            i += 1
            continue
        if in_pipe:
            i += 1
            continue
        # 4. top-level で矢印トークン前方一致 (長い順)
        if depth_square == 0 and depth_paren == 0 and depth_curly == 0:
            matched = False
            for token in _ARROW_TOKENS:
                if line.startswith(token, i):
                    arrows.append((i, token))
                    i += len(token)
                    matched = True
                    break
            if matched:
                continue
        i += 1

    unsafe_terminal = (
        in_pipe or in_quotes
        or depth_square > 0 or depth_paren > 0 or depth_curly > 0
    )
    return ScanResult(arrows=arrows, unsafe_terminal=unsafe_terminal)


def _count_arrows_in_line(line: str) -> int:
    """行内の top-level 矢印トークン数を返す (チェーン記法判定用)。"""
    return len(_scan_top_level_arrows(line).arrows)


def _split_line_by_arrows(line: str) -> list[str]:
    """行を top-level 矢印トークンで分割。矢印 N 本なら N+1 セグメント、0 本なら []。"""
    arrows = _scan_top_level_arrows(line).arrows
    if not arrows:
        return []
    segments: list[str] = []
    prev = 0
    for pos, token in arrows:
        segments.append(line[prev:pos])
        prev = pos + len(token)
    segments.append(line[prev:])
    return segments


def _fix_flowchart_colon_labels(line: str) -> str:
    """フローチャートの `A --> B : "label"` を `A -->|"label"| B` に修正する。

    以下のいずれかに該当する場合は元の行をそのまま返す (残留コロン検証側で検出):
    - 非エッジ行 / dash-label 既完成 / チェーン記法 / 終端状態不正 / 矢印なし
    - 抽出ラベルに `|` が含まれる (delimiter 衝突回避)
    """
    stripped = line.strip()

    if not stripped or stripped.startswith(_NON_EDGE_PREFIXES):
        return line

    if re.search(r'--\s*"[^"]*"\s*-->', stripped):
        return line

    scan = _scan_top_level_arrows(stripped)
    if scan.unsafe_terminal or not scan.arrows or len(scan.arrows) >= 2:
        return line

    arrow_idx, arrow_token = scan.arrows[0]
    after_arrow = stripped[arrow_idx + len(arrow_token):]

    colon_pos = _find_colon_outside_brackets(after_arrow)
    if colon_pos == -1:
        return line

    target = after_arrow[:colon_pos].strip()
    label_raw = after_arrow[colon_pos + 1:].strip().rstrip(';').strip()

    if not target or not label_raw:
        return line

    if '|' in label_raw:
        return line

    if not label_raw.startswith('"'):
        label_raw = f'"{label_raw}"'

    before_arrow = stripped[:arrow_idx].rstrip()
    indent = line[:len(line) - len(line.lstrip())]

    return f'{indent}{before_arrow} {arrow_token}|{label_raw}| {target}'


def _has_residual_colon_on_edge(line: str) -> bool:
    """フローチャートエッジ行に top-level の `:` が残っている、または終端状態不正かチェック。"""
    stripped = line.strip()
    if not stripped or stripped.startswith(_NON_EDGE_PREFIXES):
        return False

    scan = _scan_top_level_arrows(stripped)
    if scan.unsafe_terminal:
        return True
    if not scan.arrows:
        return False

    for seg in _split_line_by_arrows(stripped):
        if _find_colon_outside_brackets(seg) != -1:
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

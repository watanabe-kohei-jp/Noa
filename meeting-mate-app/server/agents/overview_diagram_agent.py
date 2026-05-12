"""論点 (topic) 単位の概要図エージェント (Issue #131).

旧 overviewDiagram (単数) は migration shim 経由で透過的に扱う。新スキーマ
overviewDiagrams (リスト) を返却し、orchestrator 側で Firebase の per-topic
パスに書き込む。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from llm_provider import llm_complete
from mermaid_utils import validate_and_clean_mermaid
from config import logger
from agents.overview_diagram_utils import (
    GENERAL_TOPIC_ID,
    make_entry,
    normalize_overview_diagrams,
    slugify_topic_id,
)


# `target_topic_id="*"` 時の並列上限 (コスト爆発防止)
WILDCARD_CAP = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class OverviewDiagramAgent:
    def __init__(self, config_path: str):
        self.config_path = config_path
        logger.info(
            f"OverviewDiagramAgent initialized with config: {config_path}")

    async def execute(
        self,
        instruction: str,
        conversation_history: List[Any],
        current_data: Dict[str, Any],
        model_name: str,
        api_key: str,
        **kwargs,
    ) -> Tuple[Dict[str, Any], str]:
        return await handle_overview_diagram_request(
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            model_name=model_name,
            api_key=api_key,
            target_topic_id=kwargs.get("target_topic_id"),
            closing_update=bool(kwargs.get("closing_update", False)),
        )


async def handle_overview_diagram_request(
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str,
    target_topic_id: Optional[str] = None,
    closing_update: bool = False,
) -> Tuple[Dict[str, Any], str]:
    """論点単位の概要図を生成/更新する。

    target_topic_id:
      - None: currentAgenda.mainTopic から派生 (slug)。無ければ "_general"
      - 具体的な topicId: その entry のみ更新 (存在しなければ closing_update でない時に新規作成)
      - "*": 既存 entry を並列で全更新 (cap=WILDCARD_CAP)
    closing_update:
      - True: 議題遷移 hook からの "締めくくり更新"。対象が無い時は no-op
    """
    diagrams = normalize_overview_diagrams(current_data)
    logger.info(
        f"Overview diagram management: instruction={instruction!r}, "
        f"target_topic_id={target_topic_id!r}, closing_update={closing_update}, "
        f"existing_count={len(diagrams)}"
    )

    if not model_name or not api_key:
        logger.warning("LLM not configured for overview diagram management.")
        return (
            {"overviewDiagrams": diagrams},
            "概要図は更新されませんでした (LLM未設定)。",
        )

    # ---- "*": 全 topic 並列更新 ----
    if target_topic_id == "*":
        if not diagrams:
            return ({"overviewDiagrams": []}, "更新対象の概要図がありません。")
        targets = diagrams[:WILDCARD_CAP]
        if len(diagrams) > WILDCARD_CAP:
            logger.warning(
                f"[OverviewDiagram] wildcard update truncated: {len(diagrams)} -> {WILDCARD_CAP}"
            )
        return await _update_many(
            diagrams=diagrams,
            targets=targets,
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            model_name=model_name,
            api_key=api_key,
        )

    # ---- 単体更新の target 解決 ----
    topic_id = target_topic_id
    if not topic_id:
        main_topic_slug = slugify_topic_id(
            (current_data.get("agenda") or {}).get("mainTopic")
        )
        if main_topic_slug:
            topic_id = main_topic_slug
        elif len(diagrams) == 1:
            # mainTopic 無し + 単一 entry (典型: legacy migration 直後) はそれを更新
            topic_id = diagrams[0]["topicId"]
        else:
            topic_id = GENERAL_TOPIC_ID
    existing = next((d for d in diagrams if d.get("topicId") == topic_id), None)

    if existing is None and closing_update:
        return (
            {"overviewDiagrams": diagrams},
            f"closing update 対象 '{topic_id}' が見つからずスキップしました。",
        )

    return await _update_single(
        diagrams=diagrams,
        topic_id=topic_id,
        existing=existing,
        instruction=instruction,
        conversation_history=conversation_history,
        current_data=current_data,
        model_name=model_name,
        api_key=api_key,
        closing_update=closing_update,
    )


async def _update_single(
    diagrams: List[Dict[str, Any]],
    topic_id: str,
    existing: Optional[Dict[str, Any]],
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str,
    closing_update: bool,
) -> Tuple[Dict[str, Any], str]:
    """1 個の topic の概要図を生成/更新する。"""

    existing_mermaid = (existing or {}).get("mermaidDefinition") or "graph TD;\n    A[会議開始];"
    topic_title = (existing or {}).get("title") or _derive_title_from_instruction(instruction, topic_id, current_data)

    try:
        new_mermaid = await _llm_generate_mermaid(
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            existing_mermaid=existing_mermaid,
            topic_id=topic_id,
            topic_title=topic_title,
            model_name=model_name,
            api_key=api_key,
        )
    except Exception as e:
        logger.error(f"Error in _update_single for {topic_id}: {e}", exc_info=True)
        return (
            {"overviewDiagrams": diagrams},
            f"概要図 '{topic_title}' の処理中にエラーが発生しました: {e}",
        )

    if not new_mermaid:
        logger.error(
            f"[OverviewDiagram] LLM response failed validation for topic_id={topic_id}"
        )
        return (
            {"overviewDiagrams": diagrams},
            f"LLM response was not in the expected Mermaid format for topic '{topic_title}'.",
        )

    now = _now_iso()
    new_status = "closed" if closing_update else (existing or {}).get("status") or "active"
    updated_entry = make_entry(
        topic_id=topic_id,
        title=topic_title,
        mermaid_definition=new_mermaid,
        status=new_status,
        created_at=(existing or {}).get("createdAt") or now,
        last_updated=now,
    )

    new_list = _upsert(diagrams, updated_entry)
    user_message = _format_user_message(updated_entry, closing_update)
    logger.info(
        f"Saved overview diagram topic_id={topic_id} status={new_status} "
        f"mermaid_len={len(new_mermaid)}"
    )
    return ({"overviewDiagrams": new_list}, user_message)


async def _update_many(
    diagrams: List[Dict[str, Any]],
    targets: List[Dict[str, Any]],
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str,
) -> Tuple[Dict[str, Any], str]:
    """複数 topic を並列で更新する (`target_topic_id="*"` 時)。"""
    results = await asyncio.gather(
        *[
            _update_single(
                diagrams=diagrams,
                topic_id=t["topicId"],
                existing=t,
                instruction=instruction,
                conversation_history=conversation_history,
                current_data=current_data,
                model_name=model_name,
                api_key=api_key,
                closing_update=False,
            )
            for t in targets
        ],
        return_exceptions=False,
    )

    # 各 _update_single は独立した new_list (他 topic は stale なまま) を返すので、
    # 対象 topicId の entry だけを抽出して merge する。
    merged = list(diagrams)
    for target, (result_payload, _msg) in zip(targets, results):
        updated_list = result_payload.get("overviewDiagrams", [])
        target_entry = next(
            (e for e in updated_list if e.get("topicId") == target["topicId"]),
            None,
        )
        if target_entry is not None:
            merged = _upsert(merged, target_entry)

    user_message = f"{len(targets)} 件の概要図を並列更新しました。"
    return ({"overviewDiagrams": merged}, user_message)


async def _llm_generate_mermaid(
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    existing_mermaid: str,
    topic_id: str,
    topic_title: str,
    model_name: str,
    api_key: str,
) -> Optional[str]:
    """LLM を呼んで Mermaid 定義を生成。retry 2 回。"""
    history_str = "\n".join(
        [
            f"{msg.role.capitalize()}: {msg.parts[0]['text']}"
            for msg in conversation_history
            if msg.parts and msg.parts[0].get("text")
        ]
    )

    session_data_json_str = json.dumps(current_data, ensure_ascii=False, indent=2)

    prompt = f"""You are a meeting overview diagram creation assistant.

**対象 topic: '{topic_title}' (topicId={topic_id})**
このセッションには複数の論点 (topic) が並列に存在し、それぞれ独立した概要図を持ちます。今回更新するのは上記 1 つの topic の図のみです。**他の topic に関する記述は一切含めないでください。**

Analyze the current complete session data (JSON format), past conversation history (reference information), and the new instruction "{instruction}" that should be addressed this time.
Based on this analysis, generate or update a Mermaid.js **`graph TD` or `graph LR`** diagram definition that visually represents this specific topic's content and structure.

**CRITICAL OUTPUT REQUIREMENTS:**
- Output ONLY the raw Mermaid diagram code
- Do NOT include any JSON formatting, markdown code blocks, or explanations
- Do NOT add any comments or additional text outside the Mermaid syntax
- Start directly with "graph TD" or "graph LR"
- End with the last class assignment or node definition

**Design Principles (Flat Design):**
1. **Modern flat design**: Use color surfaces instead of borders to organize information
2. **Consistent color palette**: Use unified colors to express information hierarchy
3. **High readability**: Ensure text visibility with clear contrast
4. **Intuitive node shapes**: Choose appropriate shapes based on content

**Recommended Color Palette:**
- **Main elements**: `#3B82F6` (Blue-500) - Background: `#EFF6FF` (Blue-50)
- **In-progress tasks**: `#F59E0B` (Amber-500) - Background: `#FFFBEB` (Amber-50)
- **Completed**: `#10B981` (Emerald-500) - Background: `#ECFDF5` (Emerald-50)
- **Attention items**: `#EF4444` (Red-500) - Background: `#FEF2F2` (Red-50)
- **Participants**: `#8B5CF6` (Violet-500) - Background: `#F5F3FF` (Violet-50)
- **Information**: `#6B7280` (Gray-500) - Background: `#F9FAFB` (Gray-50)
- **Decisions**: `#059669` (Emerald-600) - Background: `#D1FAE5` (Emerald-100)

**Mermaid.js `graph TD/LR` Definition Instructions:**

1. **Node Design**:
   - **ID naming**: Use functional prefixes (e.g., `TOPIC_`, `TASK_`, `PERSON_`)
   - **Display text**: Concise and clear expressions, use line breaks `<br/>` when necessary
   - **Shape selection**:
     - Main themes/agenda: `["Text"]` (rectangle)
     - Tasks/actions: `("Text")` (rounded)
     - Decisions: `{{"Text"}}` (diamond)
     - Participants: `(("Text"))` (circle)
     - Information/notes: `["Text"]` (rectangle, light color)

2. **Flat Design Styling with classDef**:
```
classDef primary fill:#EFF6FF,stroke:#EFF6FF,stroke-width:2px,color:#1E40AF,font-weight:bold
classDef secondary fill:#F3F4F6,stroke:#F3F4F6,stroke-width:1.5px,color:#374151
classDef accent fill:#FFFBEB,stroke:#FFFBEB,stroke-width:2px,color:#D97706,font-weight:500
classDef success fill:#ECFDF5,stroke:#ECFDF5,stroke-width:2px,color:#047857,font-weight:500
classDef warning fill:#FEF2F2,stroke:#FEF2F2,stroke-width:2px,color:#DC2626,font-weight:500
classDef person fill:#F5F3FF,stroke:#F5F3FF,stroke-width:1.5px,color:#7C3AED
classDef decision fill:#D1FAE5,stroke:#D1FAE5,stroke-width:2px,color:#047857,font-weight:bold
```

3. **Class Assignment (CRITICAL RULE)**:
   - **ALWAYS use `class` command for class assignment**
   - NEVER use `:::` method during node definition
   - Define nodes first, then apply styles with `class` commands

4. **Edge Styling**:
   - **Solid arrows**: `-->`  **Dotted**: `-.->`  **Thick**: `==>`

5. **Subgraph Organization**:
   - Subgraph titles MUST be in double quotes, no parentheses/special chars.
   - Correct: `subgraph "Existing Cloud Environment"`

**SYNTAX RULES:**
- Use `%%` for comments, never single `%`
- Avoid Unicode characters in comments
- Keep node text simple

**REMEMBER: Output ONLY the raw Mermaid code. No JSON, no markdown blocks, no explanations.**

現在のセッションデータ (全 topic 含む。`{topic_title}` に関連する部分のみ抽出して反映してください):
```json
{session_data_json_str}
```

過去の会話履歴 (参考情報):
{history_str}

この topic の既存 Mermaid 定義 (更新のベースとしてください。なければ新規作成):
```mermaid
{existing_mermaid}
```

今回対応すべき新しい指示: {instruction}

更新された概要図のMermaid.js定義 (raw Mermaidコードのみ):"""

    retry_extra = (
        "\n\n**CRITICAL (previous generation had format errors): "
        "Start with `graph TD` or `graph LR`. "
        "Do NOT use flowchart, sequenceDiagram, or any other type. "
        "Do NOT wrap in code blocks. Output raw Mermaid code ONLY.**"
    )
    attempts = [(None, ""), (None, retry_extra)]

    for attempt_idx, (_temp, extra) in enumerate(attempts):
        try:
            llm_response_text = await llm_complete(
                model=model_name, prompt=prompt + extra, api_key=api_key
            )
            logger.info(
                f"LLM overview diagram response topic_id={topic_id} attempt={attempt_idx + 1}: {llm_response_text}"
            )
            if not llm_response_text:
                logger.warning(
                    f"[OverviewDiagram] Empty response topic_id={topic_id} (attempt {attempt_idx + 1}/{len(attempts)})"
                )
                continue
            cleaned = validate_and_clean_mermaid(
                llm_response_text, allowed_types=["flowchart"]
            )
            if cleaned:
                if attempt_idx > 0:
                    logger.info(
                        f"[OverviewDiagram] Succeeded on retry topic_id={topic_id} (attempt {attempt_idx + 1})"
                    )
                return cleaned
            logger.warning(
                f"[OverviewDiagram] Validation failed topic_id={topic_id} (attempt {attempt_idx + 1}/{len(attempts)})"
            )
        except Exception as e:
            logger.error(
                f"[OverviewDiagram] LLM call failed topic_id={topic_id} (attempt {attempt_idx + 1}): {e}"
            )
            # 例外時は再試行せず外側 _update_single の except に伝播させる
            raise
    return None


def _upsert(diagrams: List[Dict[str, Any]], entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """topicId をキーに既存 entry を置換、無ければ末尾に追加。"""
    new_list = []
    replaced = False
    for d in diagrams:
        if d.get("topicId") == entry["topicId"]:
            new_list.append(entry)
            replaced = True
        else:
            new_list.append(d)
    if not replaced:
        new_list.append(entry)
    return new_list


def _derive_title_from_instruction(
    instruction: str, topic_id: str, current_data: Dict[str, Any]
) -> str:
    """新規 entry の title を導出 (mainTopic > instruction 先頭 > topicId)。"""
    main_topic = (current_data.get("agenda") or {}).get("mainTopic")
    if main_topic and slugify_topic_id(main_topic) == topic_id:
        return main_topic
    if instruction and instruction.strip():
        head = instruction.strip()[:30]
        return f"概要図: {head}" + ("..." if len(instruction.strip()) > 30 else "")
    return topic_id


def _format_user_message(entry: Dict[str, Any], closing_update: bool) -> str:
    suffix = " (議題完了に伴う締めくくり更新)" if closing_update else ""
    return (
        f"概要図 '{entry['title']}'{suffix} を更新しました。\n"
        f"```mermaid\n{entry['mermaidDefinition']}\n```"
    )

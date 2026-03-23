import json
from typing import List, Tuple, Dict, Any

from llm_provider import llm_complete
from mermaid_utils import validate_and_clean_mermaid
from config import logger


class OverviewDiagramAgent:
    def __init__(self, config_path: str):
        self.config_path = config_path
        logger.info(
            f"OverviewDiagramAgent initialized with config: {config_path}")

    async def execute(self, instruction: str, conversation_history: List[Any], current_data: Dict[str, Any], model_name: str, api_key: str, **kwargs) -> Tuple[Dict[str, Any], str]:
        return await handle_overview_diagram_request(
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            model_name=model_name,
            api_key=api_key
        )


async def handle_overview_diagram_request(
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str
) -> Tuple[Dict[str, Any], str]:
    logger.info(f"Overview diagram management for instruction: {instruction}")
    session_data = current_data
    overview_diagram_obj = session_data.get("overviewDiagram", {
                                            "mermaidDefinition": "graph TD;\n    A[会議開始];", "title": "概要図"})
    if not isinstance(overview_diagram_obj, dict):
        overview_diagram_obj = {
            "mermaidDefinition": "graph TD;\n    A[会議開始];", "title": "概要図"}

    existing_mermaid_definition = overview_diagram_obj.get(
        "mermaidDefinition", "graph TD;\n    A[会議開始];")
    existing_title = overview_diagram_obj.get("title", "概要図")

    if not model_name or not api_key:
        logger.warning("LLM not configured for overview diagram management.")
        return {"overviewDiagram": {"mermaidDefinition": existing_mermaid_definition, "title": existing_title}}, "概要図は更新されませんでした (LLM未設定)。"

    try:
        history_str = "\n".join(
            [f"{msg.role.capitalize()}: {msg.parts[0]['text']}" for msg in conversation_history if msg.parts and msg.parts[0].get('text')])

        session_data_json_str = json.dumps(
            session_data, ensure_ascii=False, indent=2)

        prompt = f"""You are a meeting overview diagram creation assistant.
Analyze the current complete session data (JSON format), past conversation history (reference information), and the new instruction "{instruction}" that should be addressed this time.
Based on this analysis, generate or update a Mermaid.js **`graph TD` or `graph LR`** diagram definition that visually represents the meeting content and project structure.

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
   - **Important**: Set stroke to the same color as fill to create borderless flat appearance
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
   - **To avoid syntax errors, ALWAYS use `class` command for class assignment**
   - NEVER use `:::` method during node definition as it causes errors
   - Define nodes first, then apply styles with `class` commands
   - **Correct example:**
     ```
     PERSON_A(("Tanaka Taro"))
     TASK_B("Specification Creation")
     class PERSON_A person
     class TASK_B accent
     ```
   - **FORBIDDEN example (causes errors):**
     ```
     PERSON_A(("Tanaka Taro")):::person
     TASK_B("Specification Creation"):::accent
     ```

4. **Edge Styling**:
   - **Solid arrows**: Direct relationships `-->`
   - **Dotted arrows**: Indirect/reference relationships `-.->`
   - **Thick arrows**: Important dependencies `==>`
   - **Labels**: Short descriptions clarifying relationships

5. **Subgraph Organization**:
   - Logically group related elements to clarify structure.
   - **Subgraph Syntax (CRITICAL RULE):**
     - To avoid syntax errors, subgraph definitions **MUST** follow the format: `subgraph "Title"`.
     - The title **MUST** be enclosed in double quotes.
     - The title string itself **MUST NOT contain parentheses `()` or other special characters**. Use simple, descriptive text.
     - **Correct Example:**
       ```
       subgraph "Existing Cloud Environment"
           SRV_A["Server A"]
           DB_B["Database B"]
       end
       ```
     - **FORBIDDEN Example (causes syntax errors):**
       ```
       subgraph 既存環境 (現行クラウド)
       ```

**SYNTAX RULES:**
- Use `%%` for comments, never single `%`
- Avoid Unicode characters in comments
- Keep node text simple and ASCII-compatible when possible
- Use double quotes only when required by Mermaid syntax

**REMEMBER: Output ONLY the raw Mermaid code. No JSON, no markdown blocks, no explanations.**

現在のセッションデータ:
```json
{session_data_json_str}
```

過去の会話履歴 (参考情報):
{history_str}

既存のMermaid定義 (更新のベースとしてください。なければ新規作成):
```mermaid
{existing_mermaid_definition}
```

今回対応すべき新しい指示: {instruction}

更新された概要図のMermaid.js定義 (raw Mermaidコードのみ):"""

        retry_extra = (
            "\n\n**CRITICAL (previous generation had format errors): "
            "Start with `graph TD` or `graph LR`. "
            "Do NOT use flowchart, sequenceDiagram, or any other type. "
            "Do NOT wrap in code blocks. Output raw Mermaid code ONLY.**"
        )

        attempts = [
            (None, ""),
            (None, retry_extra),
        ]

        logger.info(
            f"Sending overview diagram prompt to LLM. Instruction: {instruction}")

        new_mermaid_definition = None
        for attempt_idx, (_temp, extra) in enumerate(attempts):
            try:
                llm_response_text = await llm_complete(
                    model=model_name, prompt=prompt + extra, api_key=api_key)

                logger.info(f"LLM overview diagram response (attempt {attempt_idx + 1}): {llm_response_text}")

                if not llm_response_text:
                    logger.warning(f"[OverviewDiagram] Empty response (attempt {attempt_idx + 1}/{len(attempts)})")
                    continue

                new_mermaid_definition = validate_and_clean_mermaid(llm_response_text, allowed_types=["flowchart"])
                if new_mermaid_definition:
                    if attempt_idx > 0:
                        logger.info(f"[OverviewDiagram] Succeeded on retry (attempt {attempt_idx + 1})")
                    break
                logger.warning(f"[OverviewDiagram] Validation failed (attempt {attempt_idx + 1}/{len(attempts)})")
            except Exception as e:
                logger.error(f"[OverviewDiagram] LLM call failed (attempt {attempt_idx + 1}): {e}")
                break

        if not new_mermaid_definition:
            logger.error("LLM response failed Mermaid validation, using existing definition")
            return {"overviewDiagram": {"mermaidDefinition": existing_mermaid_definition, "title": existing_title}}, "LLM response was not in the expected Mermaid format."

        new_title = existing_title
        if instruction and len(instruction.strip()) > 0:
            title_words = instruction.strip()[:30]
            if len(instruction.strip()) > 30:
                title_words += "..."
            new_title = f"概要図: {title_words}"

        user_message = f"""概要図がLLMによって更新されました。
以下は生成されたMermaid定義です。お手数ですが、この定義をコピーして Mermaid Live Editor (https://mermaid.live) などで直接貼り付けて、構文エラーが発生するかどうかご確認ください。

```mermaid
{new_mermaid_definition}
```
"""
        overview_diagram_data = {
            "mermaidDefinition": new_mermaid_definition,
            "title": new_title
        }

        logger.info(
            f"Saving overview diagram with mermaidDefinition length: {len(new_mermaid_definition) if new_mermaid_definition else 0}")

        return {
            "overviewDiagram": overview_diagram_data
        }, user_message

    except Exception as e:
        logger.error(
            f"Error in handle_overview_diagram_request: {e}", exc_info=True)
        return {"overviewDiagram": {"mermaidDefinition": existing_mermaid_definition, "title": existing_title}}, f"概要図の処理中にエラーが発生しました: {e}"

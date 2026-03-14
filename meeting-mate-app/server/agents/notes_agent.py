import json
import uuid
from typing import List, Tuple, Dict, Any

from llm_provider import llm_complete, strip_code_blocks
from config import logger


class NotesGeneratorAgent:
    def __init__(self, config_path: str):
        self.config_path = config_path
        logger.info(
            f"NotesGeneratorAgent initialized with config: {config_path}")

    async def execute(self, instruction: str, conversation_history: List[Any], current_data: Dict[str, Any], model_name: str, api_key: str, **kwargs) -> Tuple[Dict[str, Any], str]:
        return await handle_notes_generation_request(
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            model_name=model_name,
            api_key=api_key
        )


async def handle_notes_generation_request(
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str
) -> Tuple[Dict[str, Any], str]:
    session_data = current_data
    current_notes_dict = session_data.get("notes", {})
    if not isinstance(current_notes_dict, dict):
        logger.warning(
            f"Notes data is not a dict, attempting to convert: {current_notes_dict}")
        if isinstance(current_notes_dict, list) and all(isinstance(n, dict) and "id" in n for n in current_notes_dict):
            current_notes_dict = {
                note["id"]: note for note in current_notes_dict}
        else:
            current_notes_dict = {}

    if not model_name or not api_key:
        new_note_id = f"note_{uuid.uuid4()}"
        new_note = {
            "id": new_note_id,
            "type": "memo",
            "text": f"Fallback Note: {instruction}"
        }
        current_notes_dict[new_note_id] = new_note
        logger.info(f"Fallback note addition: {new_note}")
        return {"notes": current_notes_dict}, f"Note item added (fallback). Total: {len(current_notes_dict)} (LLM not configured)."

    try:
        history_str = "\n".join(
            [f"{msg.role.capitalize()}: {msg.parts[0]['text']}" for msg in conversation_history if msg.parts and msg.parts[0].get('text')]
        )
        session_data_json_str = json.dumps(
            session_data, ensure_ascii=False, indent=2)

        prompt = f"""あなたは会議のノート作成アシスタントです。
以下の現在の完全なセッションデータ（JSON形式）、過去の会話履歴（参考情報）、そして今回対応すべき新しい指示「{instruction}」を総合的に分析してください。
その上で、セッションデータ内の `notes` リストを更新または項目追加し、更新後の `notes` リスト全体をJSON配列で返してください。

重要な指示:
- **既存ノートのレビューと統合:** 新しい指示に対応する際、既存の `notes` リストを注意深く確認してください。新しい情報が既存のノートと関連する場合、単に新しいノートを追加するのではなく、既存のノートを更新・拡張するか、関連する複数のノートを1つに統合・要約することを優先してください。情報の重複を避け、ノートを簡潔かつ網羅的に保つことが重要です。
- **議題変更時:** 議題が変わったと判断した場合、既存のメモはある程度`決定事項`としてまとめてください。
- **更新か新規作成かの判断:** 既存のノートを更新する方が適切か、全く新しいノートとして追加する方が適切かを文脈から判断してください。各項目について、6項目以上など、リストが多くなりすぎた場合には、適宜まとめても良いです。必要であればそれ以上でもよいです。

各ノート項目は `{{ "id": "note_ユニークID", "type": "memo" | "decision" | "issue", "text": "ノート内容" }}` の形式です。タイムスタンプは不要です。
- `id`: 既存のノートを更新する場合はそのIDを維持し、新規作成の場合は `note_` から始まるユニークなIDを割り振ってください。
- `type`: ユーザーの指示内容や文脈から、ノートの種別を "memo"（一般的なメモ・会話の流れ）、"decision"（決定事項）、"issue"（課題・検討事項）のいずれかに分類してください。
- `text`: ノートの具体的な内容を記述してください。関連情報をまとめる場合は、要点を整理して記述してください。

トランスクリプトのため、文字起こしに誤りがある場合があります。推測して補ってください。
もし指示内容がノートの変更を意図していない場合は、現在の `notes` リストをそのまま返してください。
JSON配列のみ出力してください。

現在のセッションデータ:
```json
{session_data_json_str}
```

過去の会話履歴 (参考情報):
{history_str}
今回対応すべき新しい指示: {instruction}
更新後のノート項目リスト (JSON配列):"""
        logger.info(
            f"Sending notes update prompt to LLM. Instruction: {instruction}")
        llm_response_text = await llm_complete(model=model_name, prompt=prompt, api_key=api_key)
        logger.info(f"LLM notes response: {llm_response_text}")

        if not llm_response_text:
            return {"notes": current_notes_dict}, "LLM returned empty notes update."

        cleaned_response_text = strip_code_blocks(llm_response_text)

        updated_notes_dict = {}
        try:
            updated_notes_from_llm_list = json.loads(cleaned_response_text)
            if not isinstance(updated_notes_from_llm_list, list):
                if isinstance(updated_notes_from_llm_list, dict) and "notes" in updated_notes_from_llm_list and isinstance(updated_notes_from_llm_list["notes"], list):
                    updated_notes_from_llm_list = updated_notes_from_llm_list["notes"]
                else:
                    raise ValueError(
                        "LLM notes response is not a list and not a dict with a 'notes' list.")

            for note in updated_notes_from_llm_list:
                if isinstance(note, dict) and "id" in note:
                    if not all(k in note for k in ["type", "text"]):
                        logger.warning(
                            f"Note item missing required keys (type, text): {note}")
                        continue
                    if note.get("type") not in ["memo", "decision", "issue"]:
                        logger.warning(
                            f"Invalid note type in {note}, defaulting to 'memo'")
                        note["type"] = "memo"
                    updated_notes_dict[note["id"]] = note
                else:
                    logger.warning(
                        f"Invalid note item from LLM (missing id or not a dict): {note}")

        except json.JSONDecodeError as e:
            logger.error(
                f"Failed to parse LLM notes response as JSON: {cleaned_response_text}. Error: {e}")
            if isinstance(llm_response_text, str) and not llm_response_text.startswith("[") and not llm_response_text.startswith("{"):
                new_note_id = f"note_{uuid.uuid4()}"
                fallback_note = {"id": new_note_id, "type": "memo",
                                 "text": f"LLM Response (unparsed): {llm_response_text}"}
                current_notes_dict[new_note_id] = fallback_note
                return {"notes": current_notes_dict}, "LLM response was not valid JSON, created a fallback memo."
            return {"notes": current_notes_dict}, f"LLM response was not valid JSON: {e}"

        return {"notes": updated_notes_dict}, f"Notes updated by LLM. Total: {len(updated_notes_dict)}."
    except Exception as e:
        logger.error(
            f"Error in handle_notes_generation_request: {e}", exc_info=True)
        return {"notes": current_notes_dict}, f"Error processing notes with LLM: {e}"

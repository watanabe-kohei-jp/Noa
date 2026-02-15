import json
import uuid
from typing import List, Tuple, Dict, Any

from llm_provider import llm_complete, strip_code_blocks
from config import logger


class TaskManagementAgent:
    def __init__(self, config_path: str):
        self.config_path = config_path
        logger.info(
            f"TaskManagementAgent initialized with config: {config_path}")

    async def execute(self, instruction: str, conversation_history: List[Any], current_data: Dict[str, Any], model_name: str, api_key: str, **kwargs) -> Tuple[Dict[str, Any], str]:
        return await handle_task_management_request(
            instruction=instruction,
            conversation_history=conversation_history,
            current_data=current_data,
            model_name=model_name,
            api_key=api_key
        )


async def handle_task_management_request(
    instruction: str,
    conversation_history: List[Any],
    current_data: Dict[str, Any],
    model_name: str,
    api_key: str
) -> Tuple[Dict[str, Any], str]:
    """
    Manages tasks based on user instruction using LLM via litellm.
    """
    session_data = current_data
    current_tasks_dict = session_data.get("tasks", {})
    if not isinstance(current_tasks_dict, dict):
        logger.warning(
            f"Tasks data is not a dict, attempting to convert: {current_tasks_dict}")
        if isinstance(current_tasks_dict, list) and all(isinstance(t, dict) and "id" in t for t in current_tasks_dict):
            current_tasks_dict = {
                task["id"]: task for task in current_tasks_dict}
        else:
            current_tasks_dict = {}

    if not model_name or not api_key:
        new_task_id = f"task_{uuid.uuid4()}"
        new_task = {
            "id": new_task_id,
            "title": instruction.capitalize(),
            "status": "todo",
            "detail": f"Added (fallback): {instruction}",
            "assignee": None,
            "dueDate": None
        }
        current_tasks_dict[new_task_id] = new_task
        logger.info(f"Fallback task addition: {new_task}")
        return {"tasks": current_tasks_dict}, f"Task '{new_task['title']}' added (LLM not configured)."

    try:
        history_str = "\n".join(
            [f"{msg.role.capitalize()}: {msg.parts[0]['text']}" for msg in conversation_history if msg.parts and msg.parts[0].get('text')])

        session_data_json_str = json.dumps(
            session_data, ensure_ascii=False, indent=2)

        prompt = f"""あなたは会議のタスク管理アシスタントです。
以下の現在の完全なセッションデータ（JSON形式）、過去の会話履歴（参考情報）、そして今回対応すべき新しい指示「{instruction}」を分析してください。
その上で、セッションデータ内の `tasks` リストを更新し、更新後の `tasks` リスト全体をJSON配列で返してください。

**タスクオブジェクトのスキーマ:**
各タスクオブジェクトは、以下のキーを持つJSONオブジェクトとしてください。
- `id` (string, 必須): タスクの一意な識別子。`task_` から始まるIDを推奨します。既存のタスクを更新する場合はそのIDを維持し、新規タスクの場合は既存と重複しない新しいIDを割り振ってください。
- `title` (string, 必須): タスクの簡潔なタイトル。
- `status` (string, 必須): タスクの進捗状況。「todo」（未着手）、「doing」（進行中）、「done」（完了）のいずれかの値を設定してください。
- `assignee` (string, オプショナル): タスクの担当者名。該当がない場合はキー自体を省略するか、`null` 値を設定してください。
- `dueDate` (string, オプショナル): タスクの期限。YYYY-MM-DD形式を推奨します。該当がない場合はキー自体を省略するか、`null` 値を設定してください。
- `detail` (string, オプショナル): タスクに関する追加の詳細情報。指示内容から詳細が読み取れる場合はそれを記述してください。該当がない場合はキー自体を省略するか、空文字列 `""` または `null` 値を設定してください。

**重要: 上記スキーマに定義されていないキーはタスクオブジェクトに含めないでください。**

**指示の解釈:**
- 指示内容がタスクの追加、更新、削除、ステータス変更など、**タスクリストの内容を変更する操作**を意図している場合は、その変更を反映した新しい `tasks` リストを生成してください。
- 指示内容が「現在のタスク一覧を教えて」「課題は何がある？」のように、**現在のタスクリストを参照・表示する操作**を意図している場合は、変更を加えず、現在の `tasks` リストをそのまま返してください。
- 指示内容がタスク管理と全く関係ない場合は、現在の `tasks` リストをそのまま返してください。
トランスクリプトのため、文字起こしに誤りがある場合があります。推測して補ってください。

結果はJSON配列のみ出力してください。

現在のセッションデータ:
```json
{session_data_json_str}
```
上記のセッションデータの中の `tasks` リスト（現在は `{session_data.get("tasks", [])}` となっています）を参照してください。

過去の会話履歴 (参考情報):\n{history_str}
今回対応すべき新しい指示: {instruction}

更新後のタスクリスト (JSON配列、上記のスキーマを厳守):
例:
```json
[
  {{
    "id": "task_abc123",
    "title": "新機能Aの設計",
    "status": "doing",
    "assignee": "田中",
    "dueDate": "2024-06-15",
    "detail": "API仕様とデータベーススキーマを含む。"
  }},
  {{
    "id": "task_def456",
    "title": "ユーザードキュメント作成",
    "status": "todo",
    "assignee": null,
    "dueDate": "2024-06-30",
    "detail": "リリースノートとFAQページを作成する。"
  }}
]
```
更新後のタスクリスト (JSON配列):"""
        logger.info(
            f"Sending task update prompt to LLM. Instruction: {instruction}")
        llm_response_text = await llm_complete(model=model_name, prompt=prompt, api_key=api_key)

        logger.info(f"LLM task response: {llm_response_text}")
        if not llm_response_text:
            return {"tasks": current_tasks_dict}, "LLM returned empty task update."

        cleaned_response_text = strip_code_blocks(llm_response_text)

        updated_tasks_from_llm_list = json.loads(cleaned_response_text)

        if not isinstance(updated_tasks_from_llm_list, list):
            if isinstance(updated_tasks_from_llm_list, dict) and "tasks" in updated_tasks_from_llm_list and isinstance(updated_tasks_from_llm_list["tasks"], list):
                updated_tasks_from_llm_list = updated_tasks_from_llm_list["tasks"]
            else:
                logger.error(
                    f"LLM task response is not a list: {updated_tasks_from_llm_list}")
                return {"tasks": current_tasks_dict}, "LLM task response was not a list."

        updated_tasks_dict = {}
        for task in updated_tasks_from_llm_list:
            if isinstance(task, dict) and "id" in task:
                if not all(k in task for k in ["title", "status"]):
                    logger.warning(
                        f"Task item missing required keys (title, status): {task}")
                    continue
                if task.get("status") not in ["todo", "doing", "done"]:
                    logger.warning(
                        f"Invalid task status in {task}, defaulting to 'todo'")
                    task["status"] = "todo"
                updated_tasks_dict[task["id"]] = task
            else:
                logger.warning(
                    f"Invalid task item from LLM (missing id or not a dict): {task}")

        return {"tasks": updated_tasks_dict}, f"Tasks updated by LLM. Total: {len(updated_tasks_dict)}."
    except Exception as e:
        logger.error(
            f"Error in handle_task_management_request: {e}", exc_info=True)
        return {"tasks": current_tasks_dict}, f"Error processing tasks with LLM: {e}"

"""
Brain モジュール - delegate_to_brain メタツール用

2-pass LLM 処理:
  Pass 1: ユーザーリクエストからツール選択 (JSON出力)
  Pass 2: ツール実行結果から自然言語応答を生成

direct_response の場合は Pass 1 のみで完結 (レイテンシ半減)
"""
import ast
import json
import logging
import math
import time
from datetime import datetime

from config import BRAIN_LLM_MODEL, DEEP_ANALYSIS_MODEL, DEFAULT_GEMINI_API_KEY, get_default_api_key
from knowledge_base import MockKnowledgeBase
from llm_provider import llm_complete, llm_complete_with_tools, strip_code_blocks, detect_provider
from deep_analysis import route_and_analyze
from meeting_memory import get_meeting_memory

logger = logging.getLogger(__name__)

kb = MockKnowledgeBase()

# ================================================================
# Prompts
# ================================================================

TOOL_SELECTION_PROMPT = """あなたは会議AIアシスタント「Noa」のブレインです。
ユーザーのリクエストに対して、最適なツールを1つ選び、JSON形式で回答してください。

## 利用可能ツール

- knowledge_base_search: 社内データベース検索（売上、規定、プロジェクト進捗等）
  args: {{ "query": "検索キーワード", "category": "sales|policies|projects|general" }}

- calculate: 数値計算（四則演算、パーセンテージ等）
  args: {{ "expression": "数式", "description": "計算の説明" }}

- get_current_time: 現在時刻の取得
  args: {{}}

- get_meeting_context: 会議情報の整理（参加者、議題、タスク等をまとめる）
  args: {{}}

- summarize_discussion: これまでの議論を要約
  args: {{ "focus": "all|decisions|issues|actions" }}

- create_task: タスク登録
  args: {{ "title": "タスク名", "assignee": "担当者", "due_date": "YYYY-MM-DD", "priority": "high|medium|low" }}

- generate_diagram: Mermaid記法の図を生成
  args: {{ "description": "図の説明", "diagram_type": "flowchart|sequence|gantt|mindmap|pie" }}

- search_past_meetings: 過去の会議セッションの内容を検索
  「前回の会議で決まったことは？」「先週のプロジェクトXの議論は？」等
  args: {{ "query": "検索クエリ（自然言語）" }}

- deep_analysis: 以下のいずれかに該当する質問に使用:
  (1) 複雑な分析・比較・リスク評価・多角的な検討
  (2) 最新の事実・データ・時事情報が必要（株価、ニュース、市場動向、政策等）
  (3) あなたの知識では正確に答えられない可能性がある質問
  (4) 専門的な知識や深い考察が求められる質問
  args: {{ "question": "分析対象の質問をそのまま記述" }}

- direct_response: ツール不要。挨拶・雑談・一般常識・簡単な概念説明など、正確性が問題にならない回答のみ
  args: {{ "response": "回答テキスト（500文字以内、音声読み上げ用）" }}

## ユーザーリクエスト
{request}

## 会議コンテキスト
{context_summary}

## 回答形式
JSON のみ返してください:
{{ "tool": "ツール名", "args": {{ ... }} }}"""


RESPONSE_GENERATION_PROMPT = """あなたは会議AIアシスタント「Noa」です。
ツールの実行結果をもとに、会議参加者に口頭で伝える自然な応答を生成してください。

## ユーザーリクエスト
{request}

## ツール実行結果
{tool_result}

## 会議コンテキスト
{context_summary}

## ルール
- 音声で読み上げるため、500文字以内
- 具体的な数字やデータを含める
- 箇条書きは避け、話し言葉にする
- 「〜ですね」「〜になります」など自然な語尾
- データがない場合は正直に「見つかりませんでした」と答える"""


# ================================================================
# Safe Expression Evaluator (AST-based)
# ================================================================

_ALLOWED_NAMES = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sum": sum, "pow": pow, "int": int, "float": float,
    "math": math, "True": True, "False": False,
}

_ALLOWED_ATTR_SOURCES = {"math"}  # 属性アクセスを許可するモジュール名

def _safe_eval(expression: str):
    """AST ベースの安全な数式評価。属性アクセス・import・大きすぎる数値を禁止する。"""
    if len(expression) > 500:
        raise ValueError("式が長すぎます（500文字以内）")

    tree = ast.parse(expression, mode="eval")

    for node in ast.walk(tree):
        # 属性アクセス — math.sqrt 等は許可、それ以外は禁止
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id in _ALLOWED_ATTR_SOURCES:
                continue  # math.sqrt, math.pi 等は OK
            raise ValueError(f"属性アクセスは許可されていません: {ast.dump(node)}")
        # import 禁止
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            raise ValueError("import は許可されていません")
        # 許可リスト外の名前を禁止
        if isinstance(node, ast.Name) and node.id not in _ALLOWED_NAMES:
            raise ValueError(f"許可されていない名前: {node.id}")
        # 巨大な整数リテラルによる DoS 防止
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            if isinstance(node.value, int) and abs(node.value) > 10**15:
                raise ValueError(f"数値が大きすぎます: {node.value}")

    code = compile(tree, "<expression>", "eval")
    return eval(code, {"__builtins__": {}}, _ALLOWED_NAMES)


# ================================================================
# Tool Execution
# ================================================================

async def execute_tool(tool_name: str, args: dict, meeting_context: dict) -> dict:
    """ツールを実行し結果を返す"""

    if tool_name == "knowledge_base_search":
        results = await kb.search(args.get("query", ""), args.get("category"))
        if not results:
            return {"found": False, "message": "該当するデータが見つかりませんでした。"}
        return {
            "found": True,
            "results": [r.to_dict() for r in results],
        }

    elif tool_name == "calculate":
        expression = args.get("expression", "")
        if not expression:
            return {"success": False, "message": "計算式が必要です。"}
        try:
            result = _safe_eval(expression)
            return {
                "success": True,
                "expression": expression,
                "result": result,
                "formatted": f"{result:,.2f}" if isinstance(result, float) else f"{result:,}" if isinstance(result, int) else str(result),
                "description": args.get("description", ""),
            }
        except Exception as e:
            return {"success": False, "expression": expression, "message": f"計算エラー: {e}"}

    elif tool_name == "get_current_time":
        now = datetime.now()
        formatted = now.strftime("%Y年%m月%d日 %H時%M分%S秒")
        return {"datetime": now.isoformat(), "formatted": formatted, "timezone": "Asia/Tokyo"}

    elif tool_name == "get_meeting_context":
        if not meeting_context:
            return {"available": False, "message": "会議データがありません。"}
        title = meeting_context.get("title", "無題の会議")
        participants = meeting_context.get("participants", [])
        agenda = meeting_context.get("agenda")
        tasks = meeting_context.get("tasks", [])
        open_tasks = [t for t in tasks if t.get("status") != "done"]
        return {
            "available": True,
            "title": title,
            "participant_count": len(participants),
            "participants": [p.get("name", p.get("id", "不明")) for p in participants],
            "agenda": agenda.get("mainTopic", "") if agenda else None,
            "open_task_count": len(open_tasks),
            "open_tasks": [{"title": t["title"], "status": t.get("status")} for t in open_tasks[:5]],
        }

    elif tool_name == "summarize_discussion":
        transcript = meeting_context.get("recent_transcript", [])
        tasks = meeting_context.get("tasks", [])
        notes = meeting_context.get("notes", [])
        if not transcript:
            return {"available": False, "message": "まだ議論の記録がありません。"}
        speakers = set(t.get("speaker", "不明") for t in transcript)
        decisions = [n["text"] for n in notes if n.get("type") == "decision"]
        issues = [n["text"] for n in notes if n.get("type") == "issue"]
        open_tasks = [t for t in tasks if t.get("status") != "done"]
        return {
            "available": True,
            "focus": args.get("focus", "all"),
            "entry_count": len(transcript),
            "speaker_count": len(speakers),
            "speakers": list(speakers),
            "recent_entries": transcript[-10:],
            "decisions": decisions,
            "issues": issues,
            "open_tasks": [{"title": t["title"], "assignee": t.get("assignee")} for t in open_tasks],
        }

    elif tool_name == "create_task":
        title = args.get("title", "")
        if not title:
            return {"success": False, "message": "タスクのタイトルが必要です。"}
        return {
            "success": True,
            "task": {
                "title": title,
                "assignee": args.get("assignee", ""),
                "due_date": args.get("due_date", ""),
                "priority": args.get("priority", "medium"),
            },
        }

    elif tool_name == "generate_diagram":
        description = args.get("description", "")
        diagram_type = args.get("diagram_type", "flowchart")
        return {
            "success": True,
            "description": description,
            "diagram_type": diagram_type,
            "message": f"{diagram_type}の図を生成してください。",
        }

    elif tool_name == "search_past_meetings":
        query = args.get("query", "")
        if not query:
            return {"found": False, "message": "検索クエリが必要です。"}
        room_id = meeting_context.get("room_id", "")
        if not room_id:
            return {"found": False, "message": "ルーム情報がありません。"}
        memory = get_meeting_memory()
        results = await memory.search(query, room_id=room_id)
        if not results:
            return {"found": False, "message": "過去の会議データが見つかりませんでした。まだ終了した会議がないか、関連するデータがありません。"}
        return {
            "found": True,
            "results": [
                {
                    "session_name": r.get("metadata", {}).get("session_name", "不明"),
                    "date": r.get("metadata", {}).get("started_at", "不明"),
                    "summary": r.get("summary", ""),
                }
                for r in results
            ],
            "query": query,
        }

    elif tool_name == "deep_analysis":
        question = args.get("question", "")
        if not question:
            return {"routed": False, "reason": "質問が空です"}
        context_str = _build_context_summary(meeting_context)
        transcript = meeting_context.get("recent_transcript", [])
        snippet = "\n".join(
            f"{t.get('speaker', '?')}: {t.get('text', '')}"
            for t in transcript[-10:]
        )
        return await route_and_analyze(
            question=question,
            meeting_context=context_str,
            transcript_snippet=snippet,
        )

    else:
        return {"error": f"Unknown tool: {tool_name}"}


def extract_actions(tool_name: str, tool_result: dict) -> list[dict]:
    """フロントエンドで実行すべきアクションを抽出"""
    actions = []
    if tool_name == "create_task" and tool_result.get("success"):
        actions.append({"action": "create_task", "data": tool_result["task"]})
    if tool_name == "generate_diagram" and tool_result.get("success"):
        actions.append({
            "action": "generate_diagram",
            "data": {
                "description": tool_result.get("description", ""),
                "diagram_type": tool_result.get("diagram_type", "flowchart"),
            },
        })
    return actions


# ================================================================
# Brain Main
# ================================================================

def _build_context_summary(meeting_context: dict) -> str:
    """会議コンテキストをLLM用の文字列にフォーマット"""
    if not meeting_context:
        return "(会議コンテキストなし)"

    parts = []
    title = meeting_context.get("title")
    if title:
        parts.append(f"会議: {title}")

    participants = meeting_context.get("participants", [])
    if participants:
        names = [p.get("name", p.get("id", "不明")) for p in participants]
        parts.append(f"参加者: {', '.join(names)}")

    agenda = meeting_context.get("agenda")
    if agenda:
        parts.append(f"議題: {agenda.get('mainTopic', '')}")

    transcript = meeting_context.get("recent_transcript", [])
    if transcript:
        recent = transcript[-5:]
        lines = [f"  {t.get('speaker', '?')}: {t.get('text', '')}" for t in recent]
        parts.append("直近の発言:\n" + "\n".join(lines))

    tasks = meeting_context.get("tasks", [])
    open_tasks = [t for t in tasks if t.get("status") != "done"]
    if open_tasks:
        task_lines = [f"  - {t['title']} ({t.get('assignee', '未割当')})" for t in open_tasks[:5]]
        parts.append("未完了タスク:\n" + "\n".join(task_lines))

    return "\n".join(parts) if parts else "(会議コンテキストなし)"


def _extract_transcript_snippet(meeting_context: dict) -> str:
    """meeting_context から直近の発言をスニペットとして抽出する"""
    transcript = meeting_context.get("recent_transcript", [])
    if not transcript:
        return ""
    recent = transcript[-10:]
    lines = [f"{t.get('speaker', '?')}: {t.get('text', '')}" for t in recent]
    return "\n".join(lines)


async def process_brain_request(request: str, meeting_context: dict) -> dict:
    """Brain のメイン処理: ツール選択 → 実行 → 応答生成"""

    t0 = time.perf_counter()

    provider = detect_provider(BRAIN_LLM_MODEL)
    api_key = get_default_api_key(provider) or DEFAULT_GEMINI_API_KEY

    context_summary = _build_context_summary(meeting_context)

    # Pass 1: ツール選択
    try:
        tool_selection_raw = await llm_complete(
            model=BRAIN_LLM_MODEL,
            prompt=TOOL_SELECTION_PROMPT.format(
                request=request,
                context_summary=context_summary,
            ),
            api_key=api_key,
            temperature=0.1,
            max_tokens=1000,
        )
        tool_selection_json = strip_code_blocks(tool_selection_raw)
        tool_choice = json.loads(tool_selection_json)
        tool_name = tool_choice.get("tool", "direct_response")
        tool_args = tool_choice.get("args", {})
        logger.info(f"[Brain] Tool selected: {tool_name}, args: {tool_args}")
    except (json.JSONDecodeError, Exception) as e:
        logger.error(f"[Brain] Tool selection failed: {e}, raw: {tool_selection_raw if 'tool_selection_raw' in dir() else 'N/A'}")
        # フォールバック: direct_response
        tool_name = "direct_response"
        tool_args = {}

    t_tool_select = time.perf_counter()
    tool_select_step = {
        "id": "tool_select",
        "label": "ツール判定",
        "model": BRAIN_LLM_MODEL,
        "elapsed_ms": round((t_tool_select - t0) * 1000),
    }

    # deep_analysis: Claude Opus で直接実行（Router スキップ）
    if tool_name == "deep_analysis":
        logger.info("[Brain] deep_analysis selected → executing directly (Claude Opus)")
        tool_result = await execute_tool(tool_name, tool_args, meeting_context)

        t_end = time.perf_counter()
        if tool_result.get("routed") and tool_result.get("analysis"):
            logger.info(f"[Brain] Deep analysis complete ({len(tool_result['analysis'])} chars)")
            return {
                "response_text": tool_result["analysis"],
                "actions": [],
                "metadata": {
                    "tool_selected": tool_name,
                    "steps": [
                        tool_select_step,
                        {
                            "id": "deep_analysis",
                            "label": "深層分析",
                            "model": tool_result.get("analysis_model", DEEP_ANALYSIS_MODEL),
                            "elapsed_ms": tool_result.get("analysis_elapsed_ms", 0),
                        },
                    ],
                    "total_elapsed_ms": round((t_end - t0) * 1000),
                },
            }

        # 分析失敗 → gemini-2.5-flash でフォールバック
        logger.info("[Brain] Deep analysis failed, falling back to direct response")
        t_fallback_start = time.perf_counter()
        try:
            response_text = await llm_complete_with_tools(
                model=BRAIN_LLM_MODEL,
                prompt=f"""あなたは会議AIアシスタント「Noa」です。
以下の質問に自然な日本語で回答してください。音声読み上げ用なので500文字以内。

質問: {request}
会議コンテキスト: {context_summary}""",
                api_key=api_key,
                temperature=0.7,
                max_tokens=1000,
            )
        except Exception as e:
            logger.error(f"[Brain] Fallback response failed: {e}")
            response_text = "すみません、分析の生成に失敗しました。"
        t_end = time.perf_counter()
        return {
            "response_text": response_text.strip(),
            "actions": [],
            "metadata": {
                "tool_selected": tool_name,
                "steps": [
                    tool_select_step,
                    {
                        "id": "fallback_response",
                        "label": "フォールバック応答生成",
                        "model": BRAIN_LLM_MODEL,
                        "elapsed_ms": round((t_end - t_fallback_start) * 1000),
                    },
                ],
                "total_elapsed_ms": round((t_end - t0) * 1000),
            },
        }

    # direct_response: Pass 1 で完結
    if tool_name == "direct_response":
        response_text = tool_args.get("response", "")
        if not response_text:
            # direct_response で response が空の場合、改めて生成
            try:
                response_text = await llm_complete_with_tools(
                    model=BRAIN_LLM_MODEL,
                    prompt=f"""あなたは会議AIアシスタント「Noa」です。
以下の質問に自然な日本語で回答してください。音声読み上げ用なので500文字以内。

質問: {request}
会議コンテキスト: {context_summary}""",
                    api_key=api_key,
                    temperature=0.7,
                    max_tokens=1000,
                )
            except Exception as e:
                logger.error(f"[Brain] Direct response generation failed: {e}")
                response_text = "すみません、回答の生成に失敗しました。"
        t_end = time.perf_counter()
        return {
            "response_text": response_text.strip(),
            "actions": [],
            "metadata": {
                "tool_selected": tool_name,
                "steps": [tool_select_step],
                "total_elapsed_ms": round((t_end - t0) * 1000),
            },
        }

    # ツール実行
    t_exec_start = time.perf_counter()
    tool_result = await execute_tool(tool_name, tool_args, meeting_context)
    t_exec_end = time.perf_counter()
    logger.info(f"[Brain] Tool result: {json.dumps(tool_result, ensure_ascii=False)[:200]}")

    # アクション抽出
    actions = extract_actions(tool_name, tool_result)

    # Pass 2: 応答テキスト生成
    t_resp_start = time.perf_counter()
    try:
        response_text = await llm_complete_with_tools(
            model=BRAIN_LLM_MODEL,
            prompt=RESPONSE_GENERATION_PROMPT.format(
                request=request,
                tool_result=json.dumps(tool_result, ensure_ascii=False),
                context_summary=context_summary,
            ),
            api_key=api_key,
            temperature=0.7,
            max_tokens=1000,
        )
    except Exception as e:
        logger.error(f"[Brain] Response generation failed: {e}")
        response_text = "すみません、情報の処理中にエラーが発生しました。"
    t_end = time.perf_counter()

    return {
        "response_text": response_text.strip(),
        "actions": actions,
        "metadata": {
            "tool_selected": tool_name,
            "steps": [
                tool_select_step,
                {
                    "id": "execute",
                    "label": "ツール実行",
                    "model": None,
                    "elapsed_ms": round((t_exec_end - t_exec_start) * 1000),
                },
                {
                    "id": "response_gen",
                    "label": "応答生成",
                    "model": BRAIN_LLM_MODEL,
                    "elapsed_ms": round((t_end - t_resp_start) * 1000),
                },
            ],
            "total_elapsed_ms": round((t_end - t0) * 1000),
        },
    }

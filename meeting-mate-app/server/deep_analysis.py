"""
Deep Analysis モジュール - Supervisor パターン

2段階処理:
1. Router LLM (Flash Lite) - 質問の複雑さを判定
2. Deep Analysis LLM (Claude/GPT-4o) - 詳細分析を実行
"""
import logging
import time
from config import (
    ROUTER_LLM_MODEL, DEEP_ANALYSIS_MODEL,
    DEFAULT_GEMINI_API_KEY, get_default_api_key,
)
from llm_provider import llm_complete, llm_complete_with_tools, detect_provider

logger = logging.getLogger(__name__)

ROUTER_PROMPT_TEMPLATE = """あなたは会議AIアシスタントのルーターです。
質問が「深層分析」を必要とするか判定してください。

## "analyze" にする条件（1つでも当てはまれば）
- 複数の観点からの比較・検討が必要
- データに基づく分析や予測が必要
- 最新の事実・数値・時事情報が必要（株価、市場、ニュース、政策等）
- 専門的な知識や深い考察が求められる
- 例: 「日経平均の動向は？」「A案とB案を比較して」「リスク評価して」「最近の市場動向は？」

## "none" にする条件（すべて満たす場合のみ）
- 最新情報や正確なデータが不要
- かつ、一般知識で十分に回答できる
- かつ、深い分析が不要
- 例: 今何時？、参加者は誰？、〇〇の意味は？、挨拶

## 質問
{question}

## 会議コンテキスト
{meeting_context}

"analyze" または "none" の1単語のみ回答:"""

ANALYSIS_PROMPT_TEMPLATE = """あなたは会議AIアシスタント「Noa」の分析エンジンです。
会議の参加者に提供するための、深い分析を行ってください。

## 分析対象
{question}

## 会議コンテキスト
{meeting_context}

## 直近の議論
{transcript_snippet}

## 回答ルール
- 簡潔で構造化された分析を提供する（箇条書き推奨）
- データや根拠があれば示す
- 実行可能な提案を含める
- 日本語で回答する
- 500文字以内に収める（音声で読み上げられるため）
"""


async def route_and_analyze(
    question: str,
    meeting_context: str = "",
    transcript_snippet: str = "",
) -> dict:
    """質問をルーティングし、必要なら深層分析を実行する"""

    # Step 1: Router LLM で判定
    router_provider = detect_provider(ROUTER_LLM_MODEL)
    router_api_key = get_default_api_key(router_provider) or DEFAULT_GEMINI_API_KEY

    t_router_start = time.perf_counter()
    try:
        routing_result = await llm_complete(
            model=ROUTER_LLM_MODEL,
            prompt=ROUTER_PROMPT_TEMPLATE.format(
                question=question,
                meeting_context=meeting_context or "(なし)",
            ),
            api_key=router_api_key,
            temperature=0.0,
            max_tokens=50,
        )
        routing = routing_result.strip().lower().strip('"').strip("'")
        logger.info(f"[DeepAnalysis] Router raw={repr(routing_result)} parsed={routing}")
        # Gemini の thinking モードで空レスポンスになることがある → analyze にフォールバック
        if not routing:
            logger.warning("[DeepAnalysis] Router returned empty, defaulting to 'analyze'")
            routing = "analyze"
    except Exception as e:
        logger.error(f"[DeepAnalysis] Router failed: {e}")
        # Router が失敗した場合はスキップ（クォータ節約）
        routing = "none"
    t_router_end = time.perf_counter()
    router_elapsed_ms = round((t_router_end - t_router_start) * 1000)

    if routing != "analyze":
        return {
            "routed": False,
            "reason": "simple question - no deep analysis needed",
            "router_model": ROUTER_LLM_MODEL,
            "router_elapsed_ms": router_elapsed_ms,
        }

    # Step 2: Deep Analysis LLM で分析実行
    analysis_provider = detect_provider(DEEP_ANALYSIS_MODEL)
    analysis_api_key = get_default_api_key(analysis_provider) or DEFAULT_GEMINI_API_KEY

    t_analysis_start = time.perf_counter()
    try:
        analysis = await llm_complete_with_tools(
            model=DEEP_ANALYSIS_MODEL,
            prompt=ANALYSIS_PROMPT_TEMPLATE.format(
                question=question,
                meeting_context=meeting_context or "(なし)",
                transcript_snippet=transcript_snippet or "(なし)",
            ),
            api_key=analysis_api_key,
            temperature=0.7,
            max_tokens=1000,
        )
        logger.info(f"[DeepAnalysis] Analysis complete ({len(analysis)} chars)")
        t_analysis_end = time.perf_counter()
        analysis_elapsed_ms = round((t_analysis_end - t_analysis_start) * 1000)
        return {
            "routed": True,
            "analysis": analysis.strip(),
            "router_model": ROUTER_LLM_MODEL,
            "router_elapsed_ms": router_elapsed_ms,
            "analysis_model": DEEP_ANALYSIS_MODEL,
            "analysis_elapsed_ms": analysis_elapsed_ms,
        }
    except Exception as e:
        logger.error(f"[DeepAnalysis] Analysis failed: {e}")
        t_analysis_end = time.perf_counter()
        analysis_elapsed_ms = round((t_analysis_end - t_analysis_start) * 1000)
        return {
            "routed": True,
            "analysis": None,
            "error": str(e),
            "router_model": ROUTER_LLM_MODEL,
            "router_elapsed_ms": router_elapsed_ms,
            "analysis_model": DEEP_ANALYSIS_MODEL,
            "analysis_elapsed_ms": analysis_elapsed_ms,
        }

"""
Deep Analysis モジュール

Brain Pass 1 が deep_analysis を選択した時点で直接 Claude Opus を呼び出す。
（Router LLM によるダブルチェックは廃止 — Brain の判断を信頼する設計）
"""
import logging
import time
from config import (
    DEEP_ANALYSIS_MODEL,
    DEFAULT_GEMINI_API_KEY, get_default_api_key,
)
from llm_provider import llm_complete_with_tools, detect_provider

logger = logging.getLogger(__name__)

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
    """Deep Analysis LLM で直接分析を実行する"""

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
            "analysis_model": DEEP_ANALYSIS_MODEL,
            "analysis_elapsed_ms": analysis_elapsed_ms,
        }

"""
LLM抽象レイヤー - litellmを使用したマルチプロバイダー対応

全エージェントとオーケストレーターはこのモジュール経由でLLMを呼び出す。
対応プロバイダー: Gemini, OpenAI, Anthropic (Claude)

llm_complete()       - テキスト in/out のシンプルな関数 (litellm)
llm_complete_with_tools() - 公式SDK直接呼び出し (web_search / Google Search grounding)
"""
import litellm
import anthropic
from google import genai
from google.genai import types
from typing import Optional
import logging

logger = logging.getLogger(__name__)

# litellm のログレベルを調整 (デフォルトだと冗長)
litellm.set_verbose = False


def detect_provider(model_name: str) -> str:
    """モデル名からプロバイダーを推定する"""
    lower = model_name.lower()
    # プレフィックス付き (例: "gemini/gemini-2.5-flash") の場合
    if "/" in lower:
        prefix = lower.split("/")[0]
        if prefix in ("gemini", "vertex_ai"):
            return "gemini"
        if prefix in ("openai",):
            return "openai"
        if prefix in ("anthropic",):
            return "anthropic"
        return prefix

    if lower.startswith("gemini"):
        return "gemini"
    if lower.startswith(("gpt", "o1", "o3", "o4")):
        return "openai"
    if lower.startswith("claude"):
        return "anthropic"
    return "unknown"


def normalize_model_name(model_name: str) -> str:
    """litellm互換のモデル名に正規化する

    litellm は Gemini モデルに "gemini/" プレフィックスを必要とする。
    OpenAI, Claude はプレフィックス不要。
    """
    if "/" in model_name:
        return model_name

    lower = model_name.lower()
    if lower.startswith("gemini"):
        return f"gemini/{model_name}"
    # OpenAI, Claude はそのまま
    return model_name


def strip_code_blocks(text: str) -> str:
    """LLMレスポンスからマークダウンコードブロックを除去する

    全エージェントで重複していたロジックを集約。
    """
    stripped = text.strip()
    if stripped.startswith("```json"):
        stripped = stripped[7:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        return stripped.strip()
    if stripped.startswith("```"):
        stripped = stripped[3:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        return stripped.strip()
    if stripped.startswith("`") and stripped.endswith("`"):
        return stripped[1:-1].strip()
    return stripped


async def llm_complete(
    model: str,
    prompt: str,
    api_key: str,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
) -> str:
    """統一LLM呼び出し関数

    Args:
        model: モデル名 (例: "gemini-2.5-flash", "gpt-4o", "claude-sonnet-4-5-20250929")
        prompt: プロンプトテキスト
        api_key: プロバイダーのAPIキー
        temperature: 生成温度
        max_tokens: 最大トークン数

    Returns:
        生成されたテキスト
    """
    normalized_model = normalize_model_name(model)

    messages = [{"role": "user", "content": prompt}]

    kwargs = {
        "model": normalized_model,
        "messages": messages,
        "api_key": api_key,
        "temperature": temperature,
    }
    if max_tokens:
        kwargs["max_tokens"] = max_tokens

    try:
        response = await litellm.acompletion(**kwargs)
        return response.choices[0].message.content or ""
    except Exception as e:
        logger.error(
            f"LLM completion failed for model={normalized_model}: {e}",
            exc_info=True,
        )
        raise


async def llm_complete_with_tools(
    model: str,
    prompt: str,
    api_key: str,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
) -> str:
    """公式SDKを直接使い、プロバイダー固有のツール付きでLLM呼び出し

    - Anthropic: web_search_20250305 サーバーツール
    - Gemini: Google Search grounding
    - その他: llm_complete() にフォールバック
    """
    provider = detect_provider(model)
    logger.info(f"[llm_complete_with_tools] model={model}, provider={provider}")

    if provider == "anthropic":
        return await _anthropic_with_web_search(model, prompt, api_key, temperature, max_tokens)
    elif provider == "gemini":
        return await _gemini_with_search_grounding(model, prompt, api_key, temperature, max_tokens)
    else:
        # OpenAI 等はツールなしフォールバック
        return await llm_complete(model, prompt, api_key, temperature, max_tokens)


async def _anthropic_with_web_search(
    model: str,
    prompt: str,
    api_key: str,
    temperature: float,
    max_tokens: Optional[int],
) -> str:
    """Anthropic SDK で web_search サーバーツール付き呼び出し"""
    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=max_tokens or 4096,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
            tools=[
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": 5,
                }
            ],
        )
        # response.content は TextBlock, ToolUseBlock, ServerToolUseBlock 等の混在
        text_parts = [block.text for block in response.content if hasattr(block, "text") and block.type == "text"]
        result = "\n".join(text_parts)
        logger.info(f"[Anthropic+WebSearch] {len(text_parts)} text blocks, {len(response.content)} total blocks")
        return result
    except Exception as e:
        logger.error(f"Anthropic web_search call failed: {e}", exc_info=True)
        # フォールバック: ツールなしで再試行
        logger.info("[Anthropic+WebSearch] Falling back to litellm (no tools)")
        return await llm_complete(model, prompt, api_key, temperature, max_tokens)


async def _gemini_with_search_grounding(
    model: str,
    prompt: str,
    api_key: str,
    temperature: float,
    max_tokens: Optional[int],
) -> str:
    """Google GenAI SDK で Google Search grounding 付き呼び出し"""
    client = genai.Client(api_key=api_key)
    try:
        response = await client.aio.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=temperature,
                max_output_tokens=max_tokens or 4096,
                tools=[types.Tool(google_search=types.GoogleSearch())],
            ),
        )
        result = response.text or ""
        logger.info(f"[Gemini+SearchGrounding] {len(result)} chars")
        return result
    except Exception as e:
        logger.error(f"Gemini search grounding call failed: {e}", exc_info=True)
        # フォールバック: litellm (ツールなし)
        logger.info("[Gemini+SearchGrounding] Falling back to litellm (no tools)")
        return await llm_complete(model, prompt, api_key, temperature, max_tokens)

"""
LLM抽象レイヤー - litellmを使用したマルチプロバイダー対応

全エージェントとオーケストレーターはこのモジュール経由でLLMを呼び出す。
対応プロバイダー: Gemini, OpenAI, Anthropic (Claude)
"""
import litellm
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

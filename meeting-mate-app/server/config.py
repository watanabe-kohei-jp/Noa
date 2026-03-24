import logging
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("noa_server")

# ============================================================
# マルチプロバイダー LLM 設定
# ============================================================
DEFAULT_LLM_MODEL = os.environ.get("DEFAULT_LLM_MODEL", "gemini-2.5-flash")

# プロバイダー別デフォルトAPIキー (ルーム設定がない場合のフォールバック)
DEFAULT_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
DEFAULT_OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
DEFAULT_ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# STT/TTS デフォルトプロバイダー
DEFAULT_STT_PROVIDER = os.environ.get("DEFAULT_STT_PROVIDER", "openai")
DEFAULT_TTS_PROVIDER = os.environ.get("DEFAULT_TTS_PROVIDER", "openai")

# Brain LLM (delegate_to_brain メタツール用 - Fast Path)
BRAIN_LLM_MODEL = os.environ.get("BRAIN_LLM_MODEL", "gemini-2.5-flash")

# Deep Analysis (Supervisor パターン - Deep Path)
ROUTER_LLM_MODEL = os.environ.get("ROUTER_LLM_MODEL", "gemini-2.5-flash")
DEEP_ANALYSIS_MODEL = os.environ.get("DEEP_ANALYSIS_MODEL", "claude-opus-4-6")

# ============================================================
# Meeting Memory (RAG) 設定
# ============================================================
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-004")
CHROMA_PERSIST_DIR = os.path.join(os.path.dirname(__file__), "chroma_data")

# ============================================================
# Knowledge Base 設定
# ============================================================
KNOWLEDGE_BASE_PROVIDER = os.environ.get("KNOWLEDGE_BASE_PROVIDER", "mock")
KB_MAX_SEARCH_DISTANCE = float(os.environ.get("KB_MAX_SEARCH_DISTANCE", "0.8"))

# ============================================================
# 後方互換: 旧 Vertex AI 設定 (非推奨)
# ============================================================
PROJECT_ID = os.environ.get("PROJECT_ID")
REGION = os.environ.get("REGION")
VERTEX_MODEL_NAME = os.environ.get("LLM_MODEL", "gemini-2.5-flash")

# VERTEX_AI_AVAILABLE は litellm 移行により不要だが、移行期間中の互換のため残す
VERTEX_AI_AVAILABLE = False

# ============================================================
# Firebase Configuration
# ============================================================
FIREBASE_DATABASE_URL = os.environ.get("FIREBASE_DATABASE_URL")
FIREBASE_CREDENTIALS_PATH = os.environ.get(
    "FIREBASE_CREDENTIALS_PATH", "./sa-vertex-functions.json")

if not FIREBASE_DATABASE_URL:
    logger.warning(
        "FIREBASE_DATABASE_URL environment variable is not set. Database operations will fail.")

# ============================================================
# LLM Orchestrator 設定
# ============================================================
LLM_ORCHESTRATOR_MODEL_NAME = os.getenv(
    "LLM_ORCHESTRATOR_MODEL_NAME", "gemini-2.5-flash")
LLM_TRIGGER_MESSAGE_COUNT = int(os.getenv("LLM_TRIGGER_MESSAGE_COUNT", 3))
LLM_TRANSCRIPT_LIMIT = int(os.getenv("LLM_TRANSCRIPT_LIMIT", 20))

# ============================================================
# Agent Configuration
# ============================================================
AGENT_CONFIG_DIR = os.path.join(os.path.dirname(__file__), "agent_configs")
if not os.path.exists(AGENT_CONFIG_DIR):
    alt_agent_config_dir = os.path.join(
        os.path.dirname(__file__), "agents")
    if os.path.exists(os.path.join(alt_agent_config_dir, "agent_configs")):
        AGENT_CONFIG_DIR = os.path.join(alt_agent_config_dir, "agent_configs")
    elif not os.path.exists(AGENT_CONFIG_DIR):
        logger.warning(
            f"Agent config directory {AGENT_CONFIG_DIR} not found. Agent loading might fail.")
        try:
            os.makedirs(AGENT_CONFIG_DIR, exist_ok=True)
            logger.info(
                f"Created dummy agent_configs directory at {AGENT_CONFIG_DIR}")
        except Exception as e:
            logger.error(
                f"Could not create dummy agent_configs directory: {e}")

MAX_ITERATIONS = int(os.environ.get("MAX_ITERATIONS", 5))
MAX_RETRY_ATTEMPTS = int(os.environ.get("MAX_RETRY_ATTEMPTS", 3))

# ============================================================
# デフォルトAPIキー取得ヘルパー
# ============================================================


def get_default_api_key(provider: str) -> str:
    """プロバイダー名からデフォルトAPIキーを取得する"""
    key_map = {
        "gemini": DEFAULT_GEMINI_API_KEY,
        "openai": DEFAULT_OPENAI_API_KEY,
        "anthropic": DEFAULT_ANTHROPIC_API_KEY,
    }
    return key_map.get(provider, "")


# ============================================================
# 起動時ログ
# ============================================================
if not FIREBASE_DATABASE_URL:
    logger.warning(
        "FIREBASE_DATABASE_URL is not set. Application functionality will be severely limited."
    )

if __name__ == '__main__':
    logger.info(f"Config loaded. DEFAULT_LLM_MODEL: {DEFAULT_LLM_MODEL}")
    logger.info(f"Firebase Database URL (from env): {FIREBASE_DATABASE_URL}")
    logger.info(f"LLM Trigger Message Count: {LLM_TRIGGER_MESSAGE_COUNT}")
    logger.info(f"LLM Orchestrator Model Name: {LLM_ORCHESTRATOR_MODEL_NAME}")
    logger.info(f"Default STT Provider: {DEFAULT_STT_PROVIDER}")
    logger.info(f"Default TTS Provider: {DEFAULT_TTS_PROVIDER}")
    for p in ["gemini", "openai", "anthropic"]:
        has_key = "SET" if get_default_api_key(p) else "NOT SET"
        logger.info(f"  {p} API key: {has_key}")

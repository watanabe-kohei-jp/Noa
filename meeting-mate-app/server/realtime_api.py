"""OpenAI Realtime API 用ルーター (Issue #180 PoC)

ブラウザが WebRTC で OpenAI Realtime に接続するための ephemeral client secret を
サーバー側で発行する。OPENAI_API_KEY はブラウザに出さない。

Step 0 で実発行を確認済み: gpt-realtime-2.1-mini は 200 で発行可能。
"""
import json
import logging
from typing import Optional

import aiohttp
from auth import get_current_user
from config import get_default_api_key
from fastapi import APIRouter, Depends, HTTPException, Response
from firebase_admin import db
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/realtime", tags=["realtime"])

OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1-mini"
DEFAULT_VOICE = "marin"
EPHEMERAL_TTL_SECONDS = 60  # Codex 指摘: 既定600秒は長い。短命に絞る

# room 別キー解決 (main.py の api_key_manager と別インスタンスだが状態は Firebase/env 由来)
try:
    from api_key_manager import FirebaseAPIKeyManager

    _api_key_manager: Optional["FirebaseAPIKeyManager"] = FirebaseAPIKeyManager()
except Exception as e:  # noqa: BLE001
    logger.warning("FirebaseAPIKeyManager 初期化失敗、default キーのみ使用: %s", e)
    _api_key_manager = None


def _check_participant(room_id: str, uid: str) -> None:
    """room membership チェック (media_api._check_participant と同パターン)"""
    room_data = db.reference(f"rooms/{room_id}").get()
    if not room_data or not room_data.get("participants", {}).get(uid):
        raise HTTPException(status_code=403, detail="Not a participant of this room")


def _resolve_openai_key(room_id: str) -> tuple[str, str]:
    """room 別キー → デフォルトキー の順で解決。(key, source) を返す。
    401/429 時に別キーへ再試行はしない (誰の費用かを明確にする)。"""
    if _api_key_manager is not None:
        try:
            room_key = _api_key_manager.get_provider_api_key(room_id, "openai")
            if room_key:
                return room_key, "room"
        except Exception as e:  # noqa: BLE001
            logger.warning("room 別 OpenAI キー取得失敗、default へ: %s", e)
    default_key = get_default_api_key("openai")
    if default_key:
        return default_key, "default"
    return "", "none"


class RealtimeTokenRequest(BaseModel):
    room_id: str
    session_id: Optional[str] = None
    model: Optional[str] = None  # 省略時 DEFAULT_REALTIME_MODEL


@router.post("/token", summary="OpenAI Realtime 用 ephemeral client secret を発行 (PoC #180)")
async def create_realtime_token(
    req: RealtimeTokenRequest,
    response: Response,
    user: dict = Depends(get_current_user),
):
    uid = user["uid"]
    _check_participant(req.room_id, uid)

    api_key, source = _resolve_openai_key(req.room_id)
    if not api_key:
        raise HTTPException(status_code=503, detail="No OpenAI API key available for this room")

    model = req.model or DEFAULT_REALTIME_MODEL
    payload = {
        "session": {
            "type": "realtime",
            "model": model,
            "audio": {"output": {"voice": DEFAULT_VOICE}},
        },
        "expires_after": {"anchor": "created_at", "seconds": EPHEMERAL_TTL_SECONDS},
    }

    logger.info(
        "[realtime/token] room=%s uid=%s model=%s key_source=%s",
        req.room_id, uid, model, source,
    )

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                OPENAI_CLIENT_SECRETS_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as resp:
                body_text = await resp.text()
                if resp.status != 200:
                    # 暗黙 fallback しない: モデル不在/権限不足はそのまま伝える (計測の妥当性)
                    logger.error(
                        "[realtime/token] OpenAI %d model=%s key_source=%s body=%s",
                        resp.status, model, source, body_text[:500],
                    )
                    raise HTTPException(
                        status_code=502,
                        detail=f"OpenAI client_secrets failed ({resp.status}): {body_text[:300]}",
                    )
    except aiohttp.ClientError as e:
        logger.error("[realtime/token] network error: %s", e)
        raise HTTPException(status_code=502, detail=f"OpenAI request failed: {e}")

    try:
        data = json.loads(body_text) if body_text else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="OpenAI returned non-JSON response")

    # data は {value, expires_at, session} 想定。session.model で実 slug を確認できる。
    response.headers["Cache-Control"] = "no-store"
    return data

"""Firebase Auth による FastAPI 認証 dependency"""
from fastapi import HTTPException, Request
from firebase_admin import auth as firebase_auth
import logging

logger = logging.getLogger(__name__)


async def get_current_user(request: Request) -> dict:
    """Authorization: Bearer <idToken> からユーザーを検証する"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization header with Bearer token required",
        )
    id_token = auth_header.removeprefix("Bearer ").strip()
    if not id_token:
        raise HTTPException(status_code=401, detail="Bearer token is empty")
    try:
        return firebase_auth.verify_id_token(id_token)
    except firebase_auth.ExpiredIdTokenError:
        raise HTTPException(status_code=401, detail="Token expired")
    except firebase_auth.InvalidIdTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        logger.error(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")

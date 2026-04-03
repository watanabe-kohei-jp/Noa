"""
OAuth トークン管理 — ユーザー中心のトークン保存・取得・リフレッシュ

Firebase Realtime DB の `user_integrations/{uid}/{provider}` に
Fernet 暗号化して保存する。FirebaseAPIKeyManager のパターンを踏襲。
"""
import logging
import os
from datetime import datetime, timedelta
from typing import Optional

import firebase_admin
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)


class OAuthManager:
    """OAuth トークンの暗号化保存・復号取得・自動リフレッシュ"""

    def __init__(self) -> None:
        self.db = firebase_admin.db
        encryption_key = os.environ.get("ENCRYPTION_KEY")
        if not encryption_key:
            logger.error("ENCRYPTION_KEY not set. OAuth token management will fail.")
            self.cipher = None
        else:
            try:
                self.cipher = Fernet(encryption_key.encode())
            except Exception as e:
                logger.error(f"Failed to initialize Fernet cipher: {e}")
                self.cipher = None

    def store_oauth_token(
        self,
        uid: str,
        provider: str,
        access_token: str,
        refresh_token: str,
        expires_in_seconds: int = 3600,
        scopes: Optional[list[str]] = None,
    ) -> bool:
        """OAuth トークンを暗号化して Firebase に保存"""
        if not self.cipher:
            logger.error("Cipher not initialized. Cannot store OAuth token.")
            return False

        try:
            expires_at = (datetime.utcnow() + timedelta(seconds=expires_in_seconds)).isoformat() + "Z"
            ref = self.db.reference(f"user_integrations/{uid}/{provider}")
            ref.set({
                "encrypted_access_token": self.cipher.encrypt(access_token.encode()).decode(),
                "encrypted_refresh_token": self.cipher.encrypt(refresh_token.encode()).decode(),
                "expires_at": expires_at,
                "scopes": scopes or [],
                "updated_at": datetime.utcnow().isoformat() + "Z",
            })
            logger.info(f"OAuth token stored for uid={uid}, provider={provider}")
            return True
        except Exception as e:
            logger.error(f"Failed to store OAuth token for uid={uid}, provider={provider}: {e}")
            return False

    def get_valid_token(self, uid: str, provider: str) -> Optional[str]:
        """有効な access_token を取得。期限切れの場合は None を返す。

        自動リフレッシュは Phase 1 で実装（プロバイダー固有のリフレッシュロジックが必要）。
        """
        if not self.cipher:
            return None

        try:
            ref = self.db.reference(f"user_integrations/{uid}/{provider}")
            data = ref.get()
            if not data:
                return None

            expires_at = data.get("expires_at", "")
            if expires_at:
                expiry = datetime.fromisoformat(expires_at.rstrip("Z"))
                if datetime.utcnow() > expiry - timedelta(minutes=5):
                    logger.info(f"OAuth token expired or expiring soon for uid={uid}, provider={provider}")
                    return None

            encrypted = data.get("encrypted_access_token")
            if not encrypted:
                return None

            return self.cipher.decrypt(encrypted.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to get OAuth token for uid={uid}, provider={provider}: {e}")
            return None

    def get_refresh_token(self, uid: str, provider: str) -> Optional[str]:
        """refresh_token を復号して返す"""
        if not self.cipher:
            return None

        try:
            ref = self.db.reference(f"user_integrations/{uid}/{provider}")
            data = ref.get()
            if not data:
                return None
            encrypted = data.get("encrypted_refresh_token")
            if not encrypted:
                return None
            return self.cipher.decrypt(encrypted.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to get refresh token for uid={uid}, provider={provider}: {e}")
            return None

    def revoke(self, uid: str, provider: str) -> bool:
        """OAuth トークンを削除"""
        try:
            ref = self.db.reference(f"user_integrations/{uid}/{provider}")
            ref.delete()
            logger.info(f"OAuth token revoked for uid={uid}, provider={provider}")
            return True
        except Exception as e:
            logger.error(f"Failed to revoke OAuth token for uid={uid}, provider={provider}: {e}")
            return False

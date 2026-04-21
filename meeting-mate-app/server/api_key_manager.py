from cryptography.fernet import Fernet
import firebase_admin
from datetime import datetime, timedelta
import os
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class FirebaseAPIKeyManager:
    def __init__(self):
        self.db = firebase_admin.db
        self.encryption_key = os.environ.get('ENCRYPTION_KEY')
        self.cipher: Optional[Fernet] = None

        if not self.encryption_key:
            logger.warning(
                "ENCRYPTION_KEY is not set. Per-room API key feature is disabled. "
                "LLM calls will fall back to DEFAULT_GEMINI_API_KEY.")
            return

        try:
            self.cipher = Fernet(self.encryption_key.encode())
        except Exception as e:
            logger.error(
                f"Failed to initialize Fernet cipher with provided ENCRYPTION_KEY: {e}")

    # ================================================================
    # マルチプロバイダー APIキー管理
    # ================================================================

    def store_provider_api_key(
        self, room_id: str, provider: str, api_key: str, owner_uid: str, ttl_hours: int = 24
    ) -> bool:
        """プロバイダー別にAPIキーを暗号化保存"""
        if not self.cipher:
            logger.debug("Encryption cipher not initialized. Cannot store API key.")
            return False

        try:
            encrypted_key = self.cipher.encrypt(api_key.encode()).decode()
            expires_at = (datetime.utcnow() + timedelta(hours=ttl_hours)).isoformat() + "Z"

            ref = self.db.reference(f'room_secrets/{room_id}/api_keys/{provider}')
            ref.set({
                'encrypted_key': encrypted_key,
                'expires_at': expires_at,
            })
            logger.info(f"API key for room {room_id}, provider {provider} stored successfully.")
            return True
        except Exception as e:
            logger.error(f"Error storing API key for room {room_id}, provider {provider}: {e}", exc_info=True)
            return False

    def get_provider_api_key(self, room_id: str, provider: str) -> Optional[str]:
        """プロバイダー別にAPIキーを復号化取得"""
        if not self.cipher:
            logger.debug("Encryption cipher not initialized. Cannot retrieve API key.")
            return None

        # 新形式: api_keys/{provider}
        ref = self.db.reference(f'room_secrets/{room_id}/api_keys/{provider}')
        data = ref.get()

        if data and isinstance(data, dict) and 'encrypted_key' in data:
            # 有効期限チェック
            if not self._check_expiry(data, ref):
                return None
            try:
                return self.cipher.decrypt(data['encrypted_key'].encode()).decode()
            except Exception as e:
                logger.error(f"Error decrypting API key for room {room_id}, provider {provider}: {e}")
                return None

        # 後方互換: 旧形式 encrypted_api_key (Gemini キーとして扱う)
        if provider == "gemini":
            return self._get_legacy_api_key(room_id)

        return None

    def store_room_config(self, room_id: str, config: Dict[str, Any]) -> bool:
        """ルーム設定を保存 (agent_models, default_model, stt/tts_provider)"""
        try:
            ref = self.db.reference(f'room_secrets/{room_id}')
            update_data = {}
            for key in ("agent_models", "default_model", "stt_provider", "tts_provider"):
                if key in config:
                    update_data[key] = config[key]
            if update_data:
                ref.update(update_data)
                logger.info(f"Room config for {room_id} updated: {list(update_data.keys())}")
            return True
        except Exception as e:
            logger.error(f"Error storing room config for {room_id}: {e}", exc_info=True)
            return False

    def get_room_config(self, room_id: str) -> Dict[str, Any]:
        """ルーム設定を取得 (agent_models, default_model, stt/tts_provider)"""
        try:
            ref = self.db.reference(f'room_secrets/{room_id}')
            data = ref.get() or {}

            config = {
                "agent_models": data.get("agent_models", {}),
                "default_model": data.get("default_model", ""),
                "stt_provider": data.get("stt_provider", ""),
                "tts_provider": data.get("tts_provider", ""),
            }

            # 後方互換: llm_models がある場合、default_model に使用
            if not config["default_model"] and "llm_models" in data:
                llm_models = data["llm_models"]
                if isinstance(llm_models, list) and len(llm_models) > 0:
                    config["default_model"] = llm_models[0]

            return config
        except Exception as e:
            logger.error(f"Error getting room config for {room_id}: {e}", exc_info=True)
            return {"agent_models": {}, "default_model": "", "stt_provider": "", "tts_provider": ""}

    # ================================================================
    # 旧API (後方互換) - 既存コードからの呼び出し用
    # ================================================================

    def store_room_api_key(self, room_id: str, api_key: str, owner_uid: str, ttl_hours: int = 24) -> bool:
        """部屋作成時にAPIキーを暗号化保存 (旧API - 後方互換)"""
        if not self.cipher:
            logger.debug("Encryption cipher not initialized. Cannot store API key.")
            return False

        logger.info(f"Attempting to store API key for room {room_id}.")
        try:
            encrypted_key = self.cipher.encrypt(api_key.encode()).decode()
            expires_at = (datetime.utcnow() + timedelta(hours=ttl_hours)).isoformat() + "Z"

            ref = self.db.reference(f'room_secrets/{room_id}')
            ref.update({
                'encrypted_api_key': encrypted_key,
                'expires_at': expires_at,
                'created_at': datetime.utcnow().isoformat() + "Z",
                'created_by': owner_uid
            })
            logger.info(f"API key for room {room_id} stored successfully in room_secrets.")
            return True
        except Exception as e:
            logger.error(f"Error storing API key for room {room_id}: {e}", exc_info=True)
            return False

    def get_room_api_key(self, room_id: str) -> Optional[str]:
        """LLM処理時にAPIキーを復号化取得 (旧API - 後方互換)

        新形式 (api_keys/gemini) → 旧形式 (encrypted_api_key) の順で検索。
        """
        # 新形式を先に試す
        new_key = self.get_provider_api_key(room_id, "gemini")
        if new_key:
            return new_key
        # 旧形式にフォールバック
        return self._get_legacy_api_key(room_id)

    def _get_legacy_api_key(self, room_id: str) -> Optional[str]:
        """旧形式 (encrypted_api_key) からAPIキーを取得"""
        if not self.cipher:
            return None

        ref = self.db.reference(f'room_secrets/{room_id}')
        data = ref.get()

        if not data or 'encrypted_api_key' not in data:
            return None

        if not self._check_expiry(data, ref):
            return None

        try:
            decrypted_key = self.cipher.decrypt(data['encrypted_api_key'].encode()).decode()
            logger.info(f"Legacy API key for room {room_id} retrieved successfully.")
            return decrypted_key
        except Exception as e:
            logger.error(f"Error decrypting legacy API key for room {room_id}: {e}")
            return None

    def _check_expiry(self, data: dict, ref) -> bool:
        """有効期限チェック。期限切れならFalse"""
        if 'expires_at' not in data:
            return True  # expires_at がない場合は期限なしとして扱う

        try:
            expires_dt = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
            if expires_dt < datetime.utcnow().replace(tzinfo=expires_dt.tzinfo):
                ref.delete()
                logger.info("API key expired and deleted.")
                return False
        except ValueError as e:
            logger.error(f"Invalid expires_at format: {data['expires_at']}. Error: {e}")
            return False
        return True

    def cleanup_expired_keys(self):
        """期限切れAPIキーの定期削除（Cloud Schedulerで実行）"""
        ref = self.db.reference('room_secrets')
        secrets = ref.get() or {}

        now_utc = datetime.utcnow()
        expired_rooms = []

        for room_id, data in secrets.items():
            if 'expires_at' in data:
                try:
                    expires_dt = datetime.fromisoformat(
                        data['expires_at'].replace('Z', '+00:00'))
                    if expires_dt < now_utc.replace(tzinfo=expires_dt.tzinfo):
                        expired_rooms.append(room_id)
                except ValueError:
                    expired_rooms.append(room_id)
            # api_keys 内の期限切れもチェック
            api_keys = data.get("api_keys", {})
            for provider, key_data in api_keys.items():
                if isinstance(key_data, dict) and 'expires_at' in key_data:
                    try:
                        expires_dt = datetime.fromisoformat(
                            key_data['expires_at'].replace('Z', '+00:00'))
                        if expires_dt < now_utc.replace(tzinfo=expires_dt.tzinfo):
                            self.db.reference(
                                f'room_secrets/{room_id}/api_keys/{provider}').delete()
                            logger.info(
                                f"Cleaned up expired API key for room {room_id}, provider {provider}.")
                    except ValueError:
                        pass

        for room_id in expired_rooms:
            ref.child(room_id).delete()
            logger.info(f"Cleaned up expired room_secrets for room {room_id}.")

    def delete_room_api_key(self, room_id: str):
        """部屋削除時のAPIキー削除"""
        ref = self.db.reference(f'room_secrets/{room_id}')
        ref.delete()
        logger.info(f"API key for room {room_id} deleted.")


# Global instance for use in main.py
_api_key_manager = None


def get_api_key_manager():
    """Get the global API key manager instance"""
    global _api_key_manager
    if _api_key_manager is None:
        _api_key_manager = FirebaseAPIKeyManager()
    return _api_key_manager


async def get_llm_api_key(room_id: str) -> Optional[str]:
    """Get LLM API key for a room (async wrapper for compatibility)"""
    manager = get_api_key_manager()
    return manager.get_room_api_key(room_id)

"""ストレージ抽象化レイヤー（開発: ローカルファイル / 本番: Firebase Storage に差し替え可能）"""
import os
import re
import uuid
import shutil
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

# バリデーション用正規表現
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


class MediaCategory(str, Enum):
    AUDIO = "audio"
    IMAGES = "images"
    FRAMES_CAMERA = "frames_camera"
    FRAMES_SCREEN = "frames_screen"


# MIME → 拡張子マッピング
MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "audio/webm": ".webm",
}


def validate_id(value: str, field_name: str) -> None:
    """room_id / session_id の安全性を検証（path traversal 防止）"""
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid {field_name}: must match [a-zA-Z0-9_-]+")


class StorageBackend(ABC):
    @abstractmethod
    async def save_file(
        self,
        room_id: str,
        session_id: Optional[str],
        category: MediaCategory,
        data: bytes,
        ext: str,
        prefix: str = "",
    ) -> tuple[str, str]:
        """ファイルを保存し、(相対パス, ファイル名) を返す"""
        ...

    @abstractmethod
    def delete_session_files(self, room_id: str, session_id: str) -> int:
        """セッションのファイルを削除し、削除数を返す"""
        ...


class LocalStorageBackend(StorageBackend):
    def __init__(self, data_root: str):
        self.data_root = data_root
        os.makedirs(data_root, exist_ok=True)

    async def save_file(
        self,
        room_id: str,
        session_id: Optional[str],
        category: MediaCategory,
        data: bytes,
        ext: str,
        prefix: str = "",
    ) -> tuple[str, str]:
        validate_id(room_id, "room_id")
        if session_id:
            validate_id(session_id, "session_id")

        filename = f"{prefix}{uuid.uuid4().hex}{ext}"
        rel_dir = self._build_dir(room_id, session_id, category)
        full_dir = os.path.join(self.data_root, rel_dir)
        os.makedirs(full_dir, exist_ok=True)

        full_path = os.path.join(full_dir, filename)
        with open(full_path, "wb") as f:
            f.write(data)

        rel_path = f"{rel_dir}/{filename}"
        logger.info(f"[Storage] Saved: {rel_path} ({len(data)} bytes)")
        return rel_path, filename

    def delete_session_files(self, room_id: str, session_id: str) -> int:
        validate_id(room_id, "room_id")
        validate_id(session_id, "session_id")

        session_dir = os.path.join(
            self.data_root, "rooms", room_id, "sessions", session_id
        )
        if not os.path.isdir(session_dir):
            return 0

        count = sum(len(files) for _, _, files in os.walk(session_dir))
        shutil.rmtree(session_dir, ignore_errors=True)
        logger.info(f"[Storage] Deleted session dir: {session_dir} ({count} files)")
        return count

    def _build_dir(
        self, room_id: str, session_id: Optional[str], category: MediaCategory
    ) -> str:
        if session_id:
            return f"rooms/{room_id}/sessions/{session_id}/{category.value}"
        return f"rooms/{room_id}/_no_session/{category.value}"


# シングルトン
_storage: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    global _storage
    if _storage is None:
        server_dir = os.path.dirname(os.path.abspath(__file__))
        data_root = os.path.join(server_dir, "data")
        _storage = LocalStorageBackend(data_root)
    return _storage

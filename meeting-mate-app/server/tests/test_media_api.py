"""media_api.py のヘルパー + エンドポイント関数の回帰テスト。

Issue #115: `audio/webm;codecs=opus` のような parameter 付き MIME が弾かれて
400 を返していた問題の修正に伴う追加テスト。
"""
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from fastapi import HTTPException  # noqa: E402

import media_api  # noqa: E402
from media_api import (  # noqa: E402
    ALLOWED_AUDIO_MIMES,
    ALLOWED_IMAGE_MIMES,
    _normalize_mime_type,
    _reject_invalid_mime,
    upload_audio,
    upload_file,
)
from storage import MediaCategory  # noqa: E402


# ================================================================
# _normalize_mime_type
# ================================================================

class NormalizeMimeTypeTests(unittest.TestCase):
    def test_base_type_unchanged(self):
        self.assertEqual(_normalize_mime_type("audio/webm"), "audio/webm")

    def test_strips_codec_parameter(self):
        self.assertEqual(_normalize_mime_type("audio/webm;codecs=opus"), "audio/webm")

    def test_strips_parameter_with_spaces(self):
        self.assertEqual(_normalize_mime_type("audio/webm ; codecs=opus"), "audio/webm")

    def test_lowercases_type(self):
        self.assertEqual(_normalize_mime_type("Audio/WebM;codecs=opus"), "audio/webm")

    def test_none_returns_empty(self):
        self.assertEqual(_normalize_mime_type(None), "")

    def test_empty_returns_empty(self):
        self.assertEqual(_normalize_mime_type(""), "")

    def test_whitespace_returns_empty(self):
        # 空白のみは falsy ではないが、split→strip で空になる
        self.assertEqual(_normalize_mime_type("   "), "")


# ================================================================
# _reject_invalid_mime
# ================================================================

class RejectInvalidMimeTests(unittest.TestCase):
    def test_allowed_passes(self):
        # 例外が出ないこと
        _reject_invalid_mime("audio/webm", "audio/webm", ALLOWED_AUDIO_MIMES)

    def test_not_allowed_raises_400(self):
        with self.assertRaises(HTTPException) as ctx:
            _reject_invalid_mime("audio/mp3", "audio/mp3", ALLOWED_AUDIO_MIMES)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_normalized_raises(self):
        with self.assertRaises(HTTPException) as ctx:
            _reject_invalid_mime(None, "", ALLOWED_AUDIO_MIMES)
        self.assertEqual(ctx.exception.status_code, 400)


# ================================================================
# エンドポイント関数テスト用のヘルパー
# ================================================================

class FakeUploadFile:
    """fastapi.UploadFile の最小モック。content_type と async read を備える。"""

    def __init__(self, content_type, data=b"fake-bytes"):
        self.content_type = content_type
        self._data = data

    async def read(self):
        return self._data


def _make_storage_mock(rel_path="a/b/c.webm", filename="uuid.webm"):
    storage = MagicMock()
    storage.save_file = AsyncMock(return_value=(rel_path, filename))
    return storage


def _make_db_reference_mock():
    """`db.reference(path).push(payload)` / `.get()` をキャプチャするためのモック。

    Returns:
        (reference_factory, pushed_payloads, get_values) — pushed_payloads に
        push 呼び出し時の dict が順に蓄積される。get_values は path→返却値 の辞書。
    """
    pushed_payloads = []
    get_values = {}

    def reference(path):
        ref = MagicMock()
        ref.push = MagicMock(side_effect=lambda payload: pushed_payloads.append((path, payload)))
        ref.get = MagicMock(return_value=get_values.get(path))
        return ref

    return reference, pushed_payloads, get_values


# ================================================================
# upload_audio エンドポイント関数テスト
# ================================================================

class UploadAudioEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def _call(self, *, content_type, source="mic", chunk_index=0):
        reference, pushed, get_values = _make_db_reference_mock()
        # _check_participant が参照する rooms/{room_id} を participants 付きで返す
        get_values["rooms/room1"] = {"participants": {"uid1": True}}

        storage = _make_storage_mock(rel_path="audio/room1/ch.webm", filename="mic_0_x.webm")

        with patch.object(media_api, "get_storage", return_value=storage), \
             patch.object(media_api.db, "reference", side_effect=reference):
            result = await upload_audio(
                room_id="room1",
                session_id=None,
                source=source,
                chunk_index=chunk_index,
                file=FakeUploadFile(content_type),
                user={"uid": "uid1"},
            )
        return result, storage, pushed

    async def test_accepts_codec_parameter(self):
        result, storage, pushed = await self._call(content_type="audio/webm;codecs=opus")
        self.assertEqual(result["sizeBytes"], len(b"fake-bytes"))
        storage.save_file.assert_awaited_once()
        # 保存メタデータの mimeType は normalized
        audio_pushes = [p for path, p in pushed if path.endswith("/audio")]
        self.assertEqual(len(audio_pushes), 1)
        self.assertEqual(audio_pushes[0]["mimeType"], "audio/webm")

    async def test_accepts_uppercase_mime(self):
        result, _, pushed = await self._call(content_type="Audio/WebM")
        self.assertEqual(result["sizeBytes"], len(b"fake-bytes"))
        audio_pushes = [p for path, p in pushed if path.endswith("/audio")]
        self.assertEqual(audio_pushes[0]["mimeType"], "audio/webm")

    async def test_rejects_invalid_mime(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._call(content_type="audio/mp3")
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_rejects_empty_mime(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._call(content_type="")
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_rejects_negative_chunk_index(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._call(content_type="audio/webm", chunk_index=-1)
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_rejects_invalid_source(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._call(content_type="audio/webm", source="other")
        self.assertEqual(ctx.exception.status_code, 400)


# ================================================================
# upload_file エンドポイント関数テスト
# ================================================================

class UploadFileEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def _call(self, *, content_type, category="images"):
        reference, pushed, get_values = _make_db_reference_mock()
        get_values["rooms/room1"] = {"participants": {"uid1": True}}

        storage = _make_storage_mock(rel_path="images/room1/x.jpg", filename="uuid.jpg")

        with patch.object(media_api, "get_storage", return_value=storage), \
             patch.object(media_api.db, "reference", side_effect=reference):
            result = await upload_file(
                room_id="room1",
                session_id=None,
                category=category,
                file=FakeUploadFile(content_type),
                user={"uid": "uid1"},
            )
        return result, storage, pushed

    async def test_accepts_image_with_parameter(self):
        result, storage, pushed = await self._call(content_type="image/jpeg;charset=utf-8")
        # save_file に渡された ext が .jpg（.bin ではない）
        args, kwargs = storage.save_file.call_args
        # 引数順: (room_id, session_id, category, data, ext)
        self.assertEqual(args[4], ".jpg")
        image_pushes = [p for path, p in pushed if path.endswith("/images")]
        self.assertEqual(image_pushes[0]["mimeType"], "image/jpeg")

    async def test_accepts_uppercase_png(self):
        result, storage, pushed = await self._call(content_type="IMAGE/PNG")
        args, kwargs = storage.save_file.call_args
        self.assertEqual(args[4], ".png")
        image_pushes = [p for path, p in pushed if path.endswith("/images")]
        self.assertEqual(image_pushes[0]["mimeType"], "image/png")

    async def test_rejects_octet_stream(self):
        with self.assertRaises(HTTPException) as ctx:
            await self._call(content_type="application/octet-stream")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

"""メディアアップロード API ルーター"""
import base64
import json
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from firebase_admin import db

from auth import get_current_user
from storage import get_storage, MediaCategory, validate_id, MIME_TO_EXT

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/media", tags=["media"])

# サイズ上限 (bytes)
MAX_IMAGE_SIZE = 5 * 1024 * 1024       # 5MB
MAX_FRAME_BATCH_SIZE = 3 * 1024 * 1024  # 3MB (JSON全体)
MAX_AUDIO_CHUNK_SIZE = 10 * 1024 * 1024  # 10MB

# 許可 MIME セット — この集合は必ず normalized 値（lower-case, parameter なし）のみ格納すること
ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/png"}
ALLOWED_AUDIO_MIMES = {"audio/webm"}


def _normalize_mime_type(raw: Optional[str]) -> str:
    """Content-Type ヘッダから base type を抽出（parameter剥がし + trim + lower-case）。

    例: "Audio/WebM ; codecs=opus" -> "audio/webm"
    """
    if not raw:
        return ""
    return raw.split(";", 1)[0].strip().lower()


def _reject_invalid_mime(raw: Optional[str], normalized: str, allowed: set) -> None:
    """normalized MIME が許可集合外なら 400 を raise。構造化ログを残す。"""
    if normalized not in allowed:
        logger.warning(
            "Rejected upload MIME raw=%r normalized=%r allowed=%r",
            raw, normalized, sorted(allowed),
        )
        raise HTTPException(status_code=400, detail=f"Invalid MIME type: {raw}")


def _check_participant(room_id: str, uid: str) -> None:
    """room membership チェック（proactive-check と同パターン）"""
    room_data = db.reference(f"rooms/{room_id}").get()
    if not room_data or not room_data.get("participants", {}).get(uid):
        raise HTTPException(status_code=403, detail="Not a participant of this room")


def _archive_path(room_id: str, session_id: Optional[str]) -> str:
    if session_id:
        return f"mediaArchive/{room_id}/{session_id}"
    return f"mediaArchive/{room_id}/_no_session"


@router.post("/upload", summary="単一ファイルアップロード（画像用）")
async def upload_file(
    room_id: str = Form(...),
    session_id: Optional[str] = Form(None),
    category: str = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    uid = user["uid"]
    try:
        validate_id(room_id, "room_id")
        if session_id:
            validate_id(session_id, "session_id")
    except ValueError as e:
        logger.warning("upload_file rejected: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    _check_participant(room_id, uid)

    # category バリデーション
    if category != MediaCategory.IMAGES.value:
        logger.warning("upload_file rejected: invalid category=%r", category)
        raise HTTPException(status_code=400, detail=f"Invalid category for upload: {category}")

    # MIME バリデーション（parameter 剥がして比較）
    raw_content_type = file.content_type
    normalized_mime = _normalize_mime_type(raw_content_type)
    _reject_invalid_mime(raw_content_type, normalized_mime, ALLOWED_IMAGE_MIMES)

    # ファイル読み取り + サイズチェック
    data = await file.read()
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_IMAGE_SIZE // 1024 // 1024}MB)")

    ext = MIME_TO_EXT.get(normalized_mime, ".bin")
    storage = get_storage()
    rel_path, filename = await storage.save_file(
        room_id, session_id, MediaCategory.IMAGES, data, ext
    )

    # Firebase メタデータ (normalized MIME を保存)
    archive_base = _archive_path(room_id, session_id)
    db.reference(f"{archive_base}/images").push({
        "filename": filename,
        "path": rel_path,
        "mimeType": normalized_mime,
        "sizeBytes": len(data),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    })

    return {"filename": filename, "path": rel_path, "sizeBytes": len(data)}


@router.post("/upload-batch", summary="バッチフレームアップロード")
async def upload_batch(
    room_id: str = Form(...),
    session_id: Optional[str] = Form(None),
    category: str = Form(...),
    frames: str = Form(...),
    user: dict = Depends(get_current_user),
):
    uid = user["uid"]
    try:
        validate_id(room_id, "room_id")
        if session_id:
            validate_id(session_id, "session_id")
    except ValueError as e:
        logger.warning("upload_batch rejected: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    _check_participant(room_id, uid)

    # category バリデーション
    valid_frame_categories = {MediaCategory.FRAMES_CAMERA.value, MediaCategory.FRAMES_SCREEN.value}
    if category not in valid_frame_categories:
        logger.warning("upload_batch rejected: invalid category=%r", category)
        raise HTTPException(status_code=400, detail=f"Invalid category for batch: {category}")

    # JSON サイズチェック
    if len(frames.encode("utf-8")) > MAX_FRAME_BATCH_SIZE:
        raise HTTPException(status_code=413, detail=f"Batch too large (max {MAX_FRAME_BATCH_SIZE // 1024 // 1024}MB)")

    try:
        frame_list = json.loads(frames)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON in frames")

    if not isinstance(frame_list, list) or len(frame_list) == 0:
        raise HTTPException(status_code=400, detail="frames must be a non-empty array")

    media_category = MediaCategory(category)
    storage = get_storage()
    archive_base = _archive_path(room_id, session_id)
    firebase_category = category  # frames_camera or frames_screen

    saved_count = 0
    for frame in frame_list:
        timestamp = frame.get("timestamp", "")
        b64_data = frame.get("base64", "")
        if not b64_data:
            continue

        try:
            binary = base64.b64decode(b64_data)
        except Exception:
            logger.warning(f"[Media] Invalid base64 in batch frame, skipping")
            continue

        rel_path, filename = await storage.save_file(
            room_id, session_id, media_category, binary, ".jpg"
        )

        db.reference(f"{archive_base}/{firebase_category}").push({
            "filename": filename,
            "path": rel_path,
            "mimeType": "image/jpeg",
            "sizeBytes": len(binary),
            "capturedAt": timestamp,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        })
        saved_count += 1

    return {"saved_count": saved_count}


@router.post("/upload-audio", summary="音声チャンクアップロード")
async def upload_audio(
    room_id: str = Form(...),
    session_id: Optional[str] = Form(None),
    source: str = Form(...),
    chunk_index: int = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    uid = user["uid"]
    try:
        validate_id(room_id, "room_id")
        if session_id:
            validate_id(session_id, "session_id")
    except ValueError as e:
        logger.warning("upload_audio rejected: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    _check_participant(room_id, uid)

    # source バリデーション
    if source not in ("mic", "tab"):
        logger.warning("upload_audio rejected: invalid source=%r", source)
        raise HTTPException(status_code=400, detail=f"Invalid source: {source}")

    # chunk_index バリデーション (負数は 400。非整数は FastAPI の Form(...) pydantic 検証で 422)
    if chunk_index < 0:
        logger.warning("upload_audio rejected: invalid chunk_index=%r", chunk_index)
        raise HTTPException(status_code=400, detail=f"Invalid chunk_index: {chunk_index}")

    # MIME バリデーション（parameter 剥がして比較。例: "audio/webm;codecs=opus" → "audio/webm"）
    raw_content_type = file.content_type
    normalized_mime = _normalize_mime_type(raw_content_type)
    _reject_invalid_mime(raw_content_type, normalized_mime, ALLOWED_AUDIO_MIMES)

    # ファイル読み取り + サイズチェック
    data = await file.read()
    if len(data) > MAX_AUDIO_CHUNK_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_AUDIO_CHUNK_SIZE // 1024 // 1024}MB)")

    ext = MIME_TO_EXT.get(normalized_mime, ".bin")
    storage = get_storage()
    rel_path, filename = await storage.save_file(
        room_id, session_id, MediaCategory.AUDIO, data, ext,
        prefix=f"{source}_{chunk_index}_",
    )

    # Firebase メタデータ (normalized MIME を保存)
    archive_base = _archive_path(room_id, session_id)
    db.reference(f"{archive_base}/audio").push({
        "filename": filename,
        "path": rel_path,
        "mimeType": normalized_mime,
        "sizeBytes": len(data),
        "source": source,
        "chunkIndex": chunk_index,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    })

    return {"filename": filename, "path": rel_path, "sizeBytes": len(data), "chunkIndex": chunk_index}

/**
 * メディア永続化クライアント
 * バックエンドの /api/media/* エンドポイントへのアップロード関数群
 * すべて fire-and-forget（catch でログ出力、メイン処理をブロックしない）
 */

type AuthFetchFn = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * 単一画像アップロード
 */
export async function uploadImage(
  fetchFn: AuthFetchFn,
  roomId: string,
  sessionId: string | null,
  base64: string,
  mimeType: string,
): Promise<void> {
  try {
    // Base64 → Blob
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const ext = mimeType === "image/png" ? ".png" : ".jpg";
    const blob = new Blob([bytes], { type: mimeType });

    const formData = new FormData();
    formData.append("room_id", roomId);
    if (sessionId) formData.append("session_id", sessionId);
    formData.append("category", "images");
    formData.append("file", blob, `upload${ext}`);

    await fetchFn("/api/media/upload", { method: "POST", body: formData });
  } catch (err) {
    console.warn("[media-persistence] uploadImage failed:", err);
  }
}

/**
 * フレームバッチアップロード
 */
export async function uploadFrameBatch(
  fetchFn: AuthFetchFn,
  roomId: string,
  sessionId: string | null,
  category: "frames_camera" | "frames_screen",
  frames: Array<{ timestamp: string; base64: string }>,
): Promise<void> {
  if (frames.length === 0) return;
  try {
    const formData = new FormData();
    formData.append("room_id", roomId);
    if (sessionId) formData.append("session_id", sessionId);
    formData.append("category", category);
    formData.append("frames", JSON.stringify(frames));

    await fetchFn("/api/media/upload-batch", { method: "POST", body: formData });
  } catch (err) {
    console.warn("[media-persistence] uploadFrameBatch failed:", err);
  }
}

/**
 * 音声チャンクアップロード
 */
export async function uploadAudioChunk(
  fetchFn: AuthFetchFn,
  roomId: string,
  sessionId: string | null,
  source: "mic" | "tab",
  chunkIndex: number,
  blob: Blob,
): Promise<void> {
  try {
    const formData = new FormData();
    formData.append("room_id", roomId);
    if (sessionId) formData.append("session_id", sessionId);
    formData.append("source", source);
    formData.append("chunk_index", chunkIndex.toString());
    formData.append("file", blob, `${source}_${chunkIndex}.webm`);

    await fetchFn("/api/media/upload-audio", { method: "POST", body: formData });
  } catch (err) {
    console.warn("[media-persistence] uploadAudioChunk failed:", err);
  }
}

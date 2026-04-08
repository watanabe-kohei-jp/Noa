/**
 * メディア永続化フック
 * LivePanel から永続化ロジックを分離。フレームバッファリング + 画像保存
 */
import { useCallback, useEffect, useRef } from "react";
import { authFetch } from "../lib/api-client";
import { uploadImage, uploadFrameBatch } from "../lib/media-persistence";

interface UseMediaPersistenceOptions {
  roomId: string | null;
  sessionId: string | null;
  enabled: boolean;
}

interface FrameEntry {
  timestamp: string;
  base64: string;
}

type FrameCategory = "frames_camera" | "frames_screen";

const MAX_BUFFER_SIZE = 10;
const FLUSH_INTERVAL_MS = 20_000; // 20秒

export function useMediaPersistence({
  roomId,
  sessionId,
  enabled,
}: UseMediaPersistenceOptions) {
  // カテゴリ別フレームバッファ
  const bufferRef = useRef<Record<FrameCategory, FrameEntry[]>>({
    frames_camera: [],
    frames_screen: [],
  });
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flushCategory = useCallback(
    async (category: FrameCategory) => {
      if (!roomId || !enabled) return;
      const frames = bufferRef.current[category];
      if (frames.length === 0) return;

      // バッファをクリアしてからアップロード（重複防止）
      bufferRef.current[category] = [];
      await uploadFrameBatch(authFetch, roomId, sessionId, category, frames);
    },
    [roomId, sessionId, enabled],
  );

  const flushAll = useCallback(async () => {
    await Promise.all([
      flushCategory("frames_camera"),
      flushCategory("frames_screen"),
    ]);
  }, [flushCategory]);

  // 定期フラッシュ
  useEffect(() => {
    if (!enabled) return;

    flushTimerRef.current = setInterval(() => {
      flushAll();
    }, FLUSH_INTERVAL_MS);

    return () => {
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [enabled, flushAll]);

  // unmount 時にフラッシュ
  useEffect(() => {
    return () => {
      // enabled が変わって cleanup が走る際にもフラッシュ
      if (roomId) {
        const cameraFrames = bufferRef.current.frames_camera;
        const screenFrames = bufferRef.current.frames_screen;
        if (cameraFrames.length > 0) {
          uploadFrameBatch(authFetch, roomId, sessionId, "frames_camera", cameraFrames);
          bufferRef.current.frames_camera = [];
        }
        if (screenFrames.length > 0) {
          uploadFrameBatch(authFetch, roomId, sessionId, "frames_screen", screenFrames);
          bufferRef.current.frames_screen = [];
        }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 画像を保存（fire-and-forget） */
  const persistImage = useCallback(
    (base64: string, mimeType: string) => {
      if (!roomId || !enabled) return;
      uploadImage(authFetch, roomId, sessionId, base64, mimeType);
    },
    [roomId, sessionId, enabled],
  );

  /** フレームをバッファに蓄積（data URL prefix 付きの base64 を受け付ける） */
  const bufferFrame = useCallback(
    (base64WithPrefix: string, category: FrameCategory) => {
      if (!roomId || !enabled) return;

      // data:image/jpeg;base64,xxxx → xxxx
      const commaIdx = base64WithPrefix.indexOf(",");
      const base64 = commaIdx >= 0 ? base64WithPrefix.slice(commaIdx + 1) : base64WithPrefix;

      bufferRef.current[category].push({
        timestamp: new Date().toISOString(),
        base64,
      });

      // バッファが満杯ならフラッシュ
      if (bufferRef.current[category].length >= MAX_BUFFER_SIZE) {
        flushCategory(category);
      }
    },
    [roomId, enabled, flushCategory],
  );

  return {
    persistImage,
    bufferFrame,
    flush: flushAll,
  };
}

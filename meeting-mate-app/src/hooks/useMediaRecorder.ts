/**
 * 音声録音フック（MediaRecorder + 60秒チャンクアップロード）
 * mic / tab の MediaStream を WebM/Opus で録音し、60秒ごとにバックエンドにアップロード
 */
import { useCallback, useRef, useState } from "react";
import { authFetch } from "../lib/api-client";
import { uploadAudioChunk } from "../lib/media-persistence";

interface UseMediaRecorderOptions {
  source: "mic" | "tab";
  roomId: string | null;
  sessionId: string | null;
}

const CHUNK_INTERVAL_MS = 60_000; // 60秒

export function useMediaRecorder({
  source,
  roomId,
  sessionId,
}: UseMediaRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);

  const startRecording = useCallback(
    (stream: MediaStream) => {
      if (!roomId || recorderRef.current) return;

      // MediaRecorder がサポートする MIME を選択
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType });
      } catch {
        console.warn(`[useMediaRecorder] MediaRecorder not supported for ${mimeType}`);
        return;
      }

      chunkIndexRef.current = 0;
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && roomId) {
          const idx = chunkIndexRef.current++;
          uploadAudioChunk(authFetch, roomId, sessionId, source, idx, event.data);
        }
      };

      recorder.onerror = () => {
        console.warn(`[useMediaRecorder] Recording error (${source})`);
        recorderRef.current = null;
        setIsRecording(false);
      };

      recorder.start(CHUNK_INTERVAL_MS);
      setIsRecording(true);
      console.log(`[useMediaRecorder] Started recording (${source})`);
    },
    [roomId, sessionId, source],
  );

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      recorderRef.current = null;
      setIsRecording(false);
      return;
    }

    // stop() → 最終 ondataavailable イベント発火を待つ
    return new Promise<void>((resolve) => {
      const originalHandler = recorder.ondataavailable;
      recorder.ondataavailable = (event) => {
        originalHandler?.call(recorder, event);
        recorderRef.current = null;
        setIsRecording(false);
        resolve();
      };
      recorder.stop();
    });
  }, []);

  return {
    isRecording,
    startRecording,
    stopRecording,
  };
}

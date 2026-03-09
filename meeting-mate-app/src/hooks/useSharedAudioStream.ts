/**
 * useSharedAudioStream
 *
 * getUserMedia() を1回だけ呼び、取得した MediaStream を
 * Streaming STT と Gemini Live API の両方に共有する。
 */

import { useState, useRef, useCallback, useEffect } from "react";

interface UseSharedAudioStreamReturn {
  /** 共有 MediaStream (null = まだ取得していない) */
  stream: MediaStream | null;
  /** マイクを開始 */
  startMic: () => Promise<void>;
  /** マイクを停止 */
  stopMic: () => void;
  /** マイクが有効か */
  isActive: boolean;
}

export function useSharedAudioStream(): UseSharedAudioStreamReturn {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  const startMic = useCallback(async () => {
    if (streamRef.current) return; // 既に取得済み

    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = ms;
    setStream(ms);
    setIsActive(true);
  }, []);

  const stopMic = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStream(null);
      setIsActive(false);
    }
  }, []);

  // アンマウント時にクリーンアップ
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { stream, startMic, stopMic, isActive };
}

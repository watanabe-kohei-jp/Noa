// meeting-mate-app/src/hooks/useBackendTTS.ts
// バックエンドTTS (Text-to-Speech) を利用するフック
// テキストを /tts エンドポイントに送信し、返された音声を再生

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseBackendTTSOptions {
  roomId: string | null;
  language?: string;
  voice?: string;
}

export const useBackendTTS = (options: UseBackendTTSOptions) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Audio API が利用可能かチェック
  useEffect(() => {
    setIsAvailable(typeof Audio !== 'undefined');
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!options.roomId || !text.trim() || !isAvailable) return;

    // 前回の再生を停止
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsSpeaking(true);

    try {
      const response = await fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: options.roomId,
          text: text,
          language: options.language || 'ja',
          voice: options.voice || 'alloy',
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`TTS API error (${response.status})`);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
      };

      await audio.play();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // ユーザーによるキャンセル
      } else {
        console.error('Backend TTS error:', error);
      }
      setIsSpeaking(false);
    }
  }, [options.roomId, options.language, options.voice, isAvailable]);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    isSpeaking,
    isAvailable,
    speak,
    stop,
  };
};

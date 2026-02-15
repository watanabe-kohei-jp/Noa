// meeting-mate-app/src/hooks/useBackendSTT.ts
// バックエンドSTT (Speech-to-Text) を利用するフック
// MediaRecorder API で音声をキャプチャし、/stt エンドポイントに送信

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseBackendSTTOptions {
  roomId: string | null;
  language?: string;
  onResult: (transcript: string) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
}

export const useBackendSTT = (options: UseBackendSTTOptions) => {
  const onResultRef = useRef(options.onResult);
  const onErrorRef = useRef(options.onError);
  const onEndRef = useRef(options.onEnd);

  useEffect(() => {
    onResultRef.current = options.onResult;
    onErrorRef.current = options.onError;
    onEndRef.current = options.onEnd;
  }, [options.onResult, options.onError, options.onEnd]);

  const [isRecording, setIsRecording] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // MediaRecorder API が利用可能かチェック
  useEffect(() => {
    setIsAvailable(
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }, []);

  const sendAudioToBackend = useCallback(async (audioBlob: Blob) => {
    if (!options.roomId || audioBlob.size === 0) return;

    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('room_id', options.roomId);
    formData.append('language', options.language || 'ja');

    try {
      const response = await fetch('/stt', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`STT API error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      if (result.text && result.text.trim()) {
        onResultRef.current(result.text.trim());
      }
    } catch (error) {
      console.error('Backend STT error:', error);
      if (onErrorRef.current) {
        onErrorRef.current(error instanceof Error ? error.message : 'STT processing failed');
      }
    }
  }, [options.roomId, options.language]);

  const startRecording = useCallback(async () => {
    if (!isAvailable) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (audioBlob.size > 0) {
          sendAudioToBackend(audioBlob);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);

      // 5秒ごとに録音を区切ってバックエンドに送信
      intervalRef.current = setInterval(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          // 少し遅延してから再開
          setTimeout(() => {
            if (mediaRecorderRef.current && streamRef.current) {
              try {
                const newRecorder = new MediaRecorder(streamRef.current, { mimeType });
                newRecorder.ondataavailable = (event) => {
                  if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                  }
                };
                newRecorder.onstop = () => {
                  const audioBlob = new Blob(chunksRef.current, { type: mimeType });
                  chunksRef.current = [];
                  if (audioBlob.size > 0) {
                    sendAudioToBackend(audioBlob);
                  }
                };
                mediaRecorderRef.current = newRecorder;
                newRecorder.start();
              } catch (e) {
                console.error('Error restarting MediaRecorder:', e);
              }
            }
          }, 100);
        }
      }, 5000);

    } catch (error) {
      console.error('Failed to start recording:', error);
      if (onErrorRef.current) {
        onErrorRef.current(error instanceof Error ? error.message : 'Failed to access microphone');
      }
    }
  }, [isAvailable, sendAudioToBackend]);

  const stopRecording = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setIsRecording(false);
    if (onEndRef.current) {
      onEndRef.current();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return {
    isRecording,
    isAvailable,
    toggleRecording,
  };
};

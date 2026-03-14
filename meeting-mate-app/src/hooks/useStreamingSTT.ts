/**
 * useStreamingSTT
 *
 * 共有 MediaStream から PCM16 音声を抽出し、
 * WebSocket 経由で Backend → Google Cloud STT v2 gRPC Streaming に送信。
 * 話者分離付きリアルタイム文字起こし結果を受信する。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { audioContext } from "@/lib/audio-utils";
import AudioRecordingWorklet from "@/lib/worklets/audio-processing";
import { createWorketFromSrc } from "@/lib/audioworklet-registry";

// --- Types ---

export interface STTResult {
  type: "interim" | "final";
  text: string;
  speakerTag: number;
  startTime: number;
  endTime?: number;
  confidence?: number;
  segments?: STTSegment[];
}

export interface STTSegment {
  speakerTag: number;
  text: string;
  startTime: number;
  endTime: number;
}

interface UseStreamingSTTOptions {
  /** 共有 MediaStream (null だと接続しない) */
  stream: MediaStream | null;
  /** WebSocket URL (default: auto-detect from window.location) */
  wsUrl?: string;
  /** ルームID */
  roomId: string | null;
  /** 言語コード */
  language?: string;
  /** 最小話者数 */
  minSpeakers?: number;
  /** 最大話者数 */
  maxSpeakers?: number;
  /** サンプルレート */
  sampleRate?: number;
  /** VAD を有効にするか (デフォルト false — STT は連続時間前提のため) */
  vadEnabled?: boolean;
  /** interim 結果のコールバック */
  onInterim?: (result: STTResult) => void;
  /** final 結果のコールバック */
  onFinal?: (result: STTResult) => void;
  /** エラーコールバック */
  onError?: (message: string) => void;
  /** 接続状態変化コールバック */
  onStatusChange?: (connected: boolean) => void;
}

interface UseStreamingSTTReturn {
  /** STT ストリーミングを開始 */
  startSTT: () => void;
  /** STT ストリーミングを停止 */
  stopSTT: () => void;
  /** 接続中かどうか */
  isConnected: boolean;
  /** 処理中 (音声送信中) かどうか */
  isStreaming: boolean;
}

// --- Helper ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function getWsBaseUrl(): string {
  const port = process.env.NEXT_PUBLIC_BACKEND_PORT || "8000";
  if (typeof window === "undefined") return `ws://127.0.0.1:${port}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Windows では localhost が IPv6 (::1) に解決されることがあるため、
  // IPv4 のみリッスンする uvicorn に確実に接続するために 127.0.0.1 を使用
  return `${proto}//127.0.0.1:${port}`;
}

// --- Hook ---

export function useStreamingSTT(options: UseStreamingSTTOptions): UseStreamingSTTReturn {
  const {
    stream,
    roomId,
    language = "ja",
    minSpeakers = 2,
    maxSpeakers = 6,
    sampleRate = 16000,
  } = options;

  // Refs for callbacks (avoid stale closure)
  const onInterimRef = useRef(options.onInterim);
  const onFinalRef = useRef(options.onFinal);
  const onErrorRef = useRef(options.onError);
  const onStatusChangeRef = useRef(options.onStatusChange);
  useEffect(() => {
    onInterimRef.current = options.onInterim;
    onFinalRef.current = options.onFinal;
    onErrorRef.current = options.onError;
    onStatusChangeRef.current = options.onStatusChange;
  }, [options.onInterim, options.onFinal, options.onError, options.onStatusChange]);

  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // stream を ref でも追跡 (stale closure 対策)
  const streamRef = useRef<MediaStream | null>(stream);
  useEffect(() => { streamRef.current = stream; }, [stream]);

  // pendingStart フラグ: startMic 後に stream が到着したら自動で startSTT する
  const pendingStartRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  // WebSocket メッセージ受信ハンドラ
  const handleMessage = useCallback((ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data);

      switch (msg.type) {
        case "interim":
          onInterimRef.current?.(msg as STTResult);
          break;
        case "final":
          onFinalRef.current?.(msg as STTResult);
          break;
        case "error":
          console.error("[StreamingSTT] Server error:", msg.message);
          onErrorRef.current?.(msg.message);
          break;
        case "status":
          if (msg.connected !== undefined) {
            setIsConnected(msg.connected);
            onStatusChangeRef.current?.(msg.connected);
          }
          break;
      }
    } catch {
      console.error("[StreamingSTT] Failed to parse message:", ev.data);
    }
  }, []);

  // Worklet 登録済みフラグ
  const workletRegisteredRef = useRef(false);
  const lastAudioCtxRef = useRef<AudioContext | null>(null);

  // AudioWorklet → WebSocket にオーディオを転送
  const setupAudioPipeline = useCallback(
    async (ws: WebSocket, mediaStream: MediaStream) => {
      console.log("[StreamingSTT] setupAudioPipeline: start", {
        hasExistingCtx: !!audioCtxRef.current,
        existingCtxState: audioCtxRef.current?.state,
        mediaStreamActive: mediaStream.active,
        mediaStreamTracks: mediaStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })),
      });

      // AudioContext をキャッシュして再利用
      const ctx = audioCtxRef.current && audioCtxRef.current.state !== "closed"
        ? audioCtxRef.current
        : await audioContext({ sampleRate, id: "streaming-stt" });
      audioCtxRef.current = ctx;
      console.log("[StreamingSTT] setupAudioPipeline: AudioContext ready", { state: ctx.state, sampleRate: ctx.sampleRate });

      // AudioContext が変わったら worklet 登録フラグをリセット
      if (lastAudioCtxRef.current !== ctx) {
        workletRegisteredRef.current = false;
        lastAudioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(mediaStream);
      sourceRef.current = source;
      console.log("[StreamingSTT] setupAudioPipeline: MediaStreamSource created");

      // AudioWorklet 登録（初回のみ）
      const workletName = "streaming-stt-worklet";
      if (!workletRegisteredRef.current) {
        console.log("[StreamingSTT] setupAudioPipeline: registering worklet...");
        const src = createWorketFromSrc(workletName, AudioRecordingWorklet);
        await ctx.audioWorklet.addModule(src);
        workletRegisteredRef.current = true;
        console.log("[StreamingSTT] setupAudioPipeline: worklet registered");
      }

      const worklet = new AudioWorkletNode(ctx, workletName);
      workletRef.current = worklet;

      // VAD 有効化（オプション — デフォルト無効）
      if (options.vadEnabled) {
        worklet.port.postMessage({ vadEnabled: true });
      }

      worklet.port.onmessage = (ev: MessageEvent) => {
        const arrayBuffer = ev.data.data?.int16arrayBuffer;
        if (arrayBuffer && ws.readyState === WebSocket.OPEN) {
          const base64 = arrayBufferToBase64(arrayBuffer);
          ws.send(JSON.stringify({
            type: "audio",
            data: base64,
            sampleRate,
          }));
        }
      };

      source.connect(worklet);
      console.log("[StreamingSTT] setupAudioPipeline: complete, pipeline active");
      // worklet の出力は使わない (destination に接続しない)
      // これにより音声がスピーカーから出ないようにする
    },
    [sampleRate]
  );

  const cleanupAudio = useCallback(() => {
    sourceRef.current?.disconnect();
    workletRef.current?.disconnect();
    sourceRef.current = null;
    workletRef.current = null;
    // AudioContext は閉じない (共有される可能性があるため)
    audioCtxRef.current = null;
  }, []);

  const startSTT = useCallback(() => {
    // streamRef から最新の stream を取得 (stale closure 対策)
    const currentStream = streamRef.current;

    if (!roomId) {
      console.warn("[StreamingSTT] Cannot start: no roomId");
      return;
    }

    if (!currentStream) {
      console.log("[StreamingSTT] No stream yet, setting pendingStart flag");
      pendingStartRef.current = true;
      return;
    }

    if (wsRef.current) {
      console.warn("[StreamingSTT] Already connected");
      return;
    }

    pendingStartRef.current = false;
    const wsBase = options.wsUrl || getWsBaseUrl();
    const url = `${wsBase}/ws/stt/${encodeURIComponent(roomId)}`;

    console.log("[StreamingSTT] Connecting to", url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[StreamingSTT] WebSocket connected, sending config");
      // config メッセージを送信
      ws.send(JSON.stringify({
        type: "config",
        language,
        minSpeakers,
        maxSpeakers,
        sampleRate,
      }));

      // AudioWorklet パイプラインをセットアップ
      setupAudioPipeline(ws, currentStream).then(() => {
        setIsStreaming(true);
        console.log("[StreamingSTT] Audio pipeline ready, streaming started");
      }).catch((err: Error) => {
        console.error("[StreamingSTT] Audio pipeline setup failed:", err);
        onErrorRef.current?.(`Audio setup failed: ${err.message}`);
        // パイプライン構築失敗時は WebSocket も閉じる
        ws.close();
      });
    };

    ws.onmessage = handleMessage;

    ws.onerror = (err) => {
      console.error("[StreamingSTT] WebSocket error:", err);
      onErrorRef.current?.("WebSocket connection error");
    };

    ws.onclose = (ev) => {
      console.log("[StreamingSTT] WebSocket closed", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      cleanupAudio();
      wsRef.current = null;
      setIsConnected(false);
      setIsStreaming(false);
    };
  }, [
    roomId, language, minSpeakers, maxSpeakers, sampleRate,
    options.wsUrl, handleMessage, setupAudioPipeline, cleanupAudio,
  ]);

  // stream が到着したら pendingStart を実行
  useEffect(() => {
    if (stream && pendingStartRef.current && !wsRef.current) {
      console.log("[StreamingSTT] Stream arrived, auto-starting STT");
      startSTT();
    }
  }, [stream, startSTT]);

  const stopSTT = useCallback(() => {
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        // OPEN 時のみ stop メッセージを送信
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      }
      // CONNECTING / OPEN いずれでもソケットを閉じる
      wsRef.current.close();
    }
    cleanupAudio();
    wsRef.current = null;
    setIsConnected(false);
    setIsStreaming(false);
  }, [cleanupAudio]);

  // アンマウント時にクリーンアップ
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return { startSTT, stopSTT, isConnected, isStreaming };
}

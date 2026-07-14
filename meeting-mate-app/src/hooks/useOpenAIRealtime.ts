"use client";

// OpenAI Realtime 用フック (Issue #180)
// useLiveApi (Gemini 専用) と対になる。LiveAPIContext が provider により切り替える。
// 既存 useLiveApi は無改変のまま温存し、回帰リスクをゼロにする。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OpenAIRealtimeClient,
  OpenAIRealtimeConnectConfig,
} from "../lib/openai-realtime-client";
import { ConnectionState } from "../types/live-api";

export interface UseOpenAIRealtimeResults {
  client: OpenAIRealtimeClient;
  /** connect 前に接続設定 (instructions/tools/voice/roomId 等) を渡す */
  setConnectConfig: (c: OpenAIRealtimeConnectConfig) => void;
  connected: boolean;
  connectionState: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useOpenAIRealtime(): UseOpenAIRealtimeResults {
  const client = useMemo(() => new OpenAIRealtimeClient(), []);
  const configRef = useRef<OpenAIRealtimeConnectConfig | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const connected = connectionState === "connected";

  const setConnectConfig = useCallback((c: OpenAIRealtimeConnectConfig) => {
    configRef.current = c;
  }, []);

  // client イベント → 接続状態
  useEffect(() => {
    const onOpen = () => setConnectionState("connected");
    const onClose = () => setConnectionState("disconnected");
    const onError = (e: unknown) => console.error("[openai-realtime] error", e);

    client.on("open", onOpen).on("close", onClose).on("error", onError);
    return () => {
      client.off("open", onOpen).off("close", onClose).off("error", onError);
      client.disconnect();
    };
  }, [client]);

  const connect = useCallback(async () => {
    const c = configRef.current;
    if (!c) throw new Error("OpenAI realtime connect config not set");
    if (client.status !== "disconnected") {
      console.log("[useOpenAIRealtime] already connected/connecting, skipping");
      return;
    }
    setConnectionState("connecting");
    try {
      await client.connect(c);
      // open は client の session.created/updated で 'open' イベント → onOpen が設定
    } catch (e) {
      setConnectionState("disconnected");
      throw e;
    }
  }, [client]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    setConnectionState("disconnected");
  }, [client]);

  return { client, setConnectConfig, connected, connectionState, connect, disconnect };
}

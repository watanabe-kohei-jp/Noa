"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GenAILiveClient } from "../lib/genai-live-client";
import { ConnectionState, LiveClientOptions } from "../types/live-api";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/audio-utils";
import VolMeterWorklet from "../lib/worklets/vol-meter";
import { LiveConnectConfig, LiveServerSessionResumptionUpdate } from "@google/genai";

const MAX_RECONNECT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

export type UseLiveAPIResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;
  model: string;
  setModel: (model: string) => void;
  connected: boolean;
  connectionState: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
};

export function useLiveAPI(options: LiveClientOptions): UseLiveAPIResults {
  const client = useMemo(() => new GenAILiveClient(options), [options]);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const [model, setModel] = useState<string>(
    "models/gemini-2.5-flash-native-audio-preview-12-2025"
  );
  const [config, _setConfig] = useState<LiveConnectConfig>({});
  const configRef = useRef<LiveConnectConfig>(config);
  const modelRef = useRef<string>(model);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const connected = connectionState === "connected";
  const [volume, setVolume] = useState(0);

  // Session resumption refs
  const sessionHandleRef = useRef<string | null>(null);
  const resumableRef = useRef<boolean>(false);
  const reconnectAttemptRef = useRef<number>(0);
  const isManualDisconnectRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectGenerationRef = useRef<number>(0);

  // Keep refs in sync with state
  const setConfig = useCallback((c: LiveConnectConfig) => {
    configRef.current = c;
    _setConfig(c);
  }, []);
  useEffect(() => { modelRef.current = model; }, [model]);

  // Initialize audio output streamer
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: "audio-out" }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .addWorklet<any>("vumeter-out", VolMeterWorklet, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            // Successfully added worklet
          });
      });
    }
  }, [audioStreamerRef]);

  // Attempt reconnection with exponential backoff
  const attemptReconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      console.log("[useLiveAPI] Max reconnect attempts reached, giving up");
      sessionHandleRef.current = null;
      resumableRef.current = false;
      reconnectAttemptRef.current = 0;
      setConnectionState("disconnected");
      return;
    }

    const generation = ++reconnectGenerationRef.current;
    const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
    console.log(`[useLiveAPI] Reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms (gen=${generation})`);
    setConnectionState("reconnecting");

    reconnectTimeoutRef.current = setTimeout(async () => {
      // Stale generation check — abort if disconnect/connect happened meanwhile
      if (generation !== reconnectGenerationRef.current) {
        console.log(`[useLiveAPI] Stale reconnect timer (gen=${generation}, current=${reconnectGenerationRef.current}), skipping`);
        return;
      }

      const currentConfig = configRef.current;
      if (!currentConfig || !sessionHandleRef.current) {
        console.log("[useLiveAPI] No config or handle for reconnect, giving up");
        sessionHandleRef.current = null;
        resumableRef.current = false;
        reconnectAttemptRef.current = 0;
        setConnectionState("disconnected");
        return;
      }

      // Inject session handle into config for resumption
      const reconnectConfig: LiveConnectConfig = {
        ...currentConfig,
        sessionResumption: {
          handle: sessionHandleRef.current,
        },
      };

      const success = await client.connect(modelRef.current, reconnectConfig);
      // Another stale check after async connect
      if (generation !== reconnectGenerationRef.current) return;

      if (success) {
        console.log("[useLiveAPI] Reconnect succeeded");
        reconnectAttemptRef.current = 0;
        // onOpen event will set connectionState to "connected"
      } else {
        console.log("[useLiveAPI] Reconnect failed");
        reconnectAttemptRef.current = attempt + 1;
        attemptReconnect();
      }
    }, delay);
  }, [client]);

  // Register client event handlers
  useEffect(() => {
    const onOpen = () => {
      setConnectionState("connected");
    };

    const onClose = () => {
      if (isManualDisconnectRef.current) {
        // Manual disconnect — no reconnection
        sessionHandleRef.current = null;
        resumableRef.current = false;
        setConnectionState("disconnected");
        return;
      }

      // Automatic disconnect — attempt reconnection if possible
      if (sessionHandleRef.current && resumableRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        attemptReconnect();
      } else {
        sessionHandleRef.current = null;
        resumableRef.current = false;
        reconnectAttemptRef.current = 0;
        setConnectionState("disconnected");
      }
    };

    const onSessionResumptionUpdate = (update: LiveServerSessionResumptionUpdate) => {
      sessionHandleRef.current = update.newHandle ?? null;
      resumableRef.current = update.resumable ?? false;
    };

    const onGoAway = () => {
      console.log("[useLiveAPI] Received goAway, will reconnect on close");
    };

    const onError = (error: ErrorEvent) => console.error("error", error);
    const stopAudioStreamer = () => audioStreamerRef.current?.stop();
    const onAudio = (data: ArrayBuffer) =>
      audioStreamerRef.current?.addPCM16(new Uint8Array(data));

    client
      .on("error", onError)
      .on("open", onOpen)
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio)
      .on("sessionresumptionupdate", onSessionResumptionUpdate)
      .on("goaway", onGoAway);

    return () => {
      // Cleanup: cancel pending reconnect timers
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      client
        .off("error", onError)
        .off("open", onOpen)
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio)
        .off("sessionresumptionupdate", onSessionResumptionUpdate)
        .off("goaway", onGoAway)
        .disconnect();
    };
  }, [client, attemptReconnect]);

  const connect = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig) {
      throw new Error("config has not been set");
    }
    if (client.status === "connecting" || client.status === "connected") {
      console.log("[useLiveAPI] Already connected/connecting, skipping");
      return;
    }

    // Cancel any pending reconnect
    reconnectGenerationRef.current++;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    isManualDisconnectRef.current = false;
    reconnectAttemptRef.current = 0;
    setConnectionState("connecting");

    // Inject sessionResumption for initial connection
    const connectConfig: LiveConnectConfig = {
      ...currentConfig,
      sessionResumption: {},
    };

    client.disconnect();
    await client.connect(modelRef.current, connectConfig);
  }, [client]);

  const disconnect = useCallback(async () => {
    // Mark as manual disconnect to prevent auto-reconnect
    isManualDisconnectRef.current = true;

    // Cancel any pending reconnect
    reconnectGenerationRef.current++;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    sessionHandleRef.current = null;
    resumableRef.current = false;
    reconnectAttemptRef.current = 0;

    client.disconnect();
    setConnectionState("disconnected");
  }, [client]);

  return {
    client,
    config,
    setConfig,
    model,
    setModel,
    connected,
    connectionState,
    connect,
    disconnect,
    volume,
  };
}

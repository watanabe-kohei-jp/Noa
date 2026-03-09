"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GenAILiveClient } from "../lib/genai-live-client";
import { LiveClientOptions } from "../types/live-api";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/audio-utils";
import VolMeterWorklet from "../lib/worklets/vol-meter";
import { LiveConnectConfig } from "@google/genai";

export type UseLiveAPIResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;
  model: string;
  setModel: (model: string) => void;
  connected: boolean;
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
  const [connected, setConnected] = useState(false);
  const [volume, setVolume] = useState(0);

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

  // Register client event handlers
  useEffect(() => {
    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    const onError = (error: ErrorEvent) => console.error("error", error);
    const stopAudioStreamer = () => audioStreamerRef.current?.stop();
    const onAudio = (data: ArrayBuffer) =>
      audioStreamerRef.current?.addPCM16(new Uint8Array(data));

    client
      .on("error", onError)
      .on("open", onOpen)
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio);

    return () => {
      client
        .off("error", onError)
        .off("open", onOpen)
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio)
        .disconnect();
    };
  }, [client]);

  const connect = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig) {
      throw new Error("config has not been set");
    }
    if (client.status === "connecting" || client.status === "connected") {
      console.log("[useLiveAPI] Already connected/connecting, skipping");
      return;
    }
    client.disconnect();
    await client.connect(modelRef.current, currentConfig);
  }, [client]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    setConnected(false);
  }, [setConnected, client]);

  return {
    client,
    config,
    setConfig,
    model,
    setModel,
    connected,
    connect,
    disconnect,
    volume,
  };
}

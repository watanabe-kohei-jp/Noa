"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useLiveAPIContext } from "../contexts/LiveAPIContext";
import { AudioRecorder } from "../lib/audio-recorder";
import { LiveToolHandler, MeetingContextProvider } from "../lib/live-tools/tool-handler";
import { liveToolDeclarations } from "../lib/live-tools/tool-declarations";
import { getSystemPrompt } from "../lib/live-tools/system-prompts";
import type { LiveMode } from "../types/live-api";
import type { SessionData } from "../types/data";
import { useBrain } from "./useBrain";
import { filterThinkingText } from "../lib/transcript-filter";
import { Modality } from "@google/genai";
import type { LiveServerToolCall, LiveServerToolCallCancellation, LiveConnectConfig } from "@google/genai";
import { useThinkingQueue } from "../contexts/ThinkingQueueContext";

// Firebase
import { ref, push, set } from "firebase/database";
import { database as getDatabase } from "../firebase";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface UseLivePanelProps {
  roomId: string | null;
  roomData: SessionData | null;
  sharedStream: MediaStream | null;
  currentSessionId: string | null;
}

export interface UseLivePanelReturn {
  // Live AI connection
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;

  // Mode
  mode: LiveMode;
  toggleMode: () => void;

  // Volume & VAD
  inVolume: number;
  outVolume: number;
  isSpeaking: boolean;

  // Tab audio
  tabAudioActive: boolean;
  startTabAudio: () => Promise<void>;
  stopTabAudio: () => void;

  // Brain
  isProcessing: boolean;

  // UI conditions
  canConnect: boolean;
  noStreamWarning: boolean;

  // Refs for tab capture (hidden DOM elements)
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useLivePanel({
  roomId,
  roomData,
  sharedStream,
  currentSessionId,
}: UseLivePanelProps): UseLivePanelReturn {
  const { client, setConfig, connected, connect, disconnect, volume } =
    useLiveAPIContext();
  const { addTask, updateTask } = useThinkingQueue();

  const [mode, setMode] = useState<LiveMode>("passive");
  const toolHandlerRef = useRef<LiveToolHandler>(new LiveToolHandler());

  // Audio recording
  const [inVolume, setInVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [tabAudioActive, setTabAudioActive] = useState(false);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tabStreamRef = useRef<MediaStream | null>(null);

  // Brain hook (delegate_to_brain meta-tool)
  const thinkingQueue = useMemo(() => ({ addTask, updateTask }), [addTask, updateTask]);
  const brainCallbacks = useMemo(() => ({
    onTaskCreated: (task: { title: string; assignee?: string; dueDate?: string; priority?: string }) => {
      if (!roomId) return;
      const db = getDatabase();
      if (!db) return;
      const taskId =
        Date.now().toString() + Math.random().toString(36).substring(2, 8);
      const path = currentSessionId
        ? `rooms/${roomId}/sessions/${currentSessionId}/tasks/${taskId}`
        : `rooms/${roomId}/tasks/${taskId}`;
      const taskRef = ref(db, path);
      set(taskRef, {
        id: taskId,
        title: task.title,
        assignee: task.assignee || "",
        dueDate: task.dueDate || "",
        priority: task.priority || "medium",
        status: "todo",
      });
    },
    onDiagram: (mermaidCode: string, title: string) => {
      if (!roomId || !mermaidCode) return;
      const db = getDatabase();
      if (!db) return;
      const path = currentSessionId
        ? `rooms/${roomId}/sessions/${currentSessionId}/overviewDiagram`
        : `rooms/${roomId}/overviewDiagram`;
      const diagramRef = ref(db, path);
      set(diagramRef, {
        title: title || "会議の概要図",
        mermaidDefinition: mermaidCode,
      });
    },
  }), [roomId, currentSessionId]);
  const { isProcessing, requestBrain } = useBrain(client, connected, roomData, brainCallbacks, thinkingQueue, roomId);

  // Accumulate current model turn text
  const currentModelTextRef = useRef<string>("");

  // Configure tool handler with room context
  useEffect(() => {
    const contextProvider: MeetingContextProvider = {
      getRoomData: () => roomData,
    };
    toolHandlerRef.current.setContextProvider(contextProvider);
    toolHandlerRef.current.setCallbacks({
      onBrainRequested: requestBrain,
    });
  }, [roomData, requestBrain]);

  // Sync transcript to Firebase
  const syncTranscriptToFirebase = useCallback(
    (text: string, role: "user" | "ai") => {
      const cleanText = role === "ai" ? filterThinkingText(text) : text;
      if (!roomId || !cleanText.trim()) return;
      const db = getDatabase();
      if (!db) return;

      const path = currentSessionId
        ? `rooms/${roomId}/sessions/${currentSessionId}/transcript`
        : `rooms/${roomId}/transcript`;
      const transcriptRef = ref(db, path);
      push(transcriptRef, {
        userId: role === "ai" ? "noa" : "live-user",
        userName: role === "ai" ? "Noa" : "Live User",
        text: cleanText.trim(),
        timestamp: new Date().toISOString(),
        role,
        speakerId: role === "ai" ? "noa" : "live-user",
        source: "live-api",
      });
    },
    [roomId, currentSessionId]
  );

  // Update config when mode changes
  useEffect(() => {
    const config: LiveConnectConfig = {
      systemInstruction: {
        parts: [{ text: getSystemPrompt(mode) }],
      },
      tools: [
        { functionDeclarations: liveToolDeclarations },
      ],
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
      outputAudioTranscription: {},
    };
    setConfig(config);
  }, [mode, setConfig]);

  // Listen for content events
  useEffect(() => {
    const onContent = (data: { modelTurn?: { parts?: { text?: string }[] } }) => {
      if (data.modelTurn?.parts) {
        for (const part of data.modelTurn.parts) {
          if (part.text) {
            currentModelTextRef.current += part.text;
          }
        }
      }
    };

    const onTurnComplete = () => {
      if (currentModelTextRef.current.trim()) {
        syncTranscriptToFirebase(currentModelTextRef.current, "ai");
      }
      currentModelTextRef.current = "";
    };

    const onToolCall = (toolCall: LiveServerToolCall) => {
      toolHandlerRef.current.handleToolCall(toolCall, client);
    };

    const onToolCallCancellation = (cancellation: LiveServerToolCallCancellation) => {
      cancellation.ids?.forEach((id) => toolHandlerRef.current.markCancelled(id));
    };

    client.on("content", onContent);
    client.on("turncomplete", onTurnComplete);
    client.on("toolcall", onToolCall);
    client.on("toolcallcancellation", onToolCallCancellation);

    return () => {
      client.off("content", onContent);
      client.off("turncomplete", onTurnComplete);
      client.off("toolcall", onToolCall);
      client.off("toolcallcancellation", onToolCallCancellation);
    };
  }, [client, syncTranscriptToFirebase]);

  // Microphone audio -> Gemini (shared stream)
  // Bug fix: cleanup now calls audioRecorder.stop()
  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        { mimeType: "audio/pcm;rate=16000", data: base64 },
      ]);
    };

    console.log("[useLivePanel] Audio effect:", { connected, hasStream: !!sharedStream });
    if (connected && sharedStream) {
      console.log("[useLivePanel] Starting audioRecorder with sharedStream");
      audioRecorder
        .on("data", onData)
        .on("volume", setInVolume)
        .on("vad", (speaking: boolean) => setIsSpeaking(speaking))
        .start(sharedStream)
        .then(() => {
          audioRecorder.setVadEnabled(true);
          console.log("[useLivePanel] audioRecorder started OK (VAD enabled)");
        })
        .catch((err: unknown) =>
          console.warn("[useLivePanel] audioRecorder start failed:", err)
        );
    } else {
      audioRecorder.stop();
    }

    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume).off("vad");
      setIsSpeaking(false);
      audioRecorder.stop();
    };
  }, [connected, client, sharedStream, audioRecorder]);

  // Warn when connected but no stream
  useEffect(() => {
    if (connected && !sharedStream) {
      console.warn("[useLivePanel] Live AI connected but sharedStream is null - no audio being sent");
    }
  }, [connected, sharedStream]);

  // Tab audio capture
  const stopTabAudio = useCallback(() => {
    tabStreamRef.current?.getTracks().forEach((t) => t.stop());
    tabStreamRef.current = null;
    setTabAudioActive(false);
  }, []);

  const startTabAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      tabStreamRef.current = stream;
      setTabAudioActive(true);

      // Tab audio -> PCM16 -> Gemini
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(
          new MediaStream(audioTracks)
        );
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);

        processor.onaudioprocess = (e) => {
          if (!connected) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = float32[i] * 32768;
          }
          const bytes = new Uint8Array(int16.buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          client.sendRealtimeInput([
            { mimeType: "audio/pcm;rate=16000", data: base64 },
          ]);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      }

      // Video frames from tab -> Gemini (low fps)
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0 && videoRef.current && canvasRef.current) {
        const video = videoRef.current;
        video.srcObject = new MediaStream(videoTracks);
        await video.play();

        const sendFrame = () => {
          if (!connected || !tabStreamRef.current) return;
          const canvas = canvasRef.current;
          if (!canvas || !video) return;

          canvas.width = video.videoWidth * 0.25;
          canvas.height = video.videoHeight * 0.25;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL("image/jpeg", 0.5);
          const data = base64.slice(base64.indexOf(",") + 1);
          client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);

          setTimeout(sendFrame, 2000); // 0.5 FPS
        };
        sendFrame();
      }

      // Handle stream end
      stream.getTracks().forEach((track) => {
        track.onended = () => stopTabAudio();
      });
    } catch (err) {
      console.error("Tab audio capture failed:", err);
    }
  }, [connected, client, stopTabAudio]);

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === "passive" ? "active" : "passive"));
  }, []);

  // Derived state for UI
  const canConnect = !connected && !!sharedStream;
  const noStreamWarning = connected && !sharedStream;

  return {
    connected,
    connect,
    disconnect,
    mode,
    toggleMode,
    inVolume,
    outVolume: volume,
    tabAudioActive,
    startTabAudio,
    stopTabAudio,
    isProcessing,
    canConnect,
    noStreamWarning,
    isSpeaking,
    videoRef,
    canvasRef,
  };
}

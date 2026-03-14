"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Phone,
  PhoneOff,
  MonitorUp,
  MonitorOff,
  ToggleLeft,
  ToggleRight,
  Sparkles,
  Loader2,
} from "lucide-react";
import { LiveAPIProvider, useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { AudioRecorder } from "../../lib/audio-recorder";
import { LiveToolHandler, MeetingContextProvider } from "../../lib/live-tools/tool-handler";
import { liveToolDeclarations } from "../../lib/live-tools/tool-declarations";
import { getSystemPrompt } from "../../lib/live-tools/system-prompts";
import type { LiveMode } from "../../types/live-api";
import type { SessionData } from "../../types/data";
import { useBrain } from "../../hooks/useBrain";
import { filterThinkingText } from "../../lib/transcript-filter";
import { authFetch } from "../../lib/api-client";
import { Modality } from "@google/genai";
import type { LiveServerToolCall, LiveServerToolCallCancellation, LiveConnectConfig } from "@google/genai";
import { ThinkingQueueProvider, useThinkingQueue } from "../../contexts/ThinkingQueueContext";
import ThinkingQueuePanel from "../thinking-queue/ThinkingQueuePanel";

// Firebase
import { ref, push, set } from "firebase/database";
import { database as getDatabase } from "../../firebase";

/* ------------------------------------------------------------------ */
/*  LivePanelInner - headless event handler + inline controls          */
/* ------------------------------------------------------------------ */

interface LivePanelInnerProps {
  roomId: string | null;
  roomData: SessionData | null;
  sharedStream?: MediaStream | null;
  currentSessionId?: string | null;
}

function LivePanelInner({
  roomId,
  roomData,
  sharedStream,
  currentSessionId,
}: LivePanelInnerProps) {
  const { client, setConfig, connected, connect, disconnect, volume } =
    useLiveAPIContext();
  const { addTask, updateTask } = useThinkingQueue();

  const [mode, setMode] = useState<LiveMode>("passive");
  const toolHandlerRef = useRef<LiveToolHandler>(new LiveToolHandler());

  // Audio recording (merged from LiveControlTray)
  const [inVolume, setInVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [tabAudioActive, setTabAudioActive] = useState(false);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    onDiagram: () => {},
  }), [roomId, currentSessionId]);
  const { isProcessing, requestBrain } = useBrain(client, connected, roomData, brainCallbacks, thinkingQueue, roomId);
  // NOTE: useBrain は client.send() を使わなくなった（1008 対策）。
  // Brain 結果は sendToolResponse 経由で Gemini に渡る。

  // Accumulate current model turn text (no UI state needed)
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
      // AI発話の場合、内部思考テキスト (markdown) をフィルタ
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

  // Listen for content events (headless - no UI messages state)
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
  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        { mimeType: "audio/pcm;rate=16000", data: base64 },
      ]);
    };

    console.log("[LivePanel] Audio effect:", { connected, hasStream: !!sharedStream });
    if (connected && sharedStream) {
      console.log("[LivePanel] Starting audioRecorder with sharedStream");
      audioRecorder
        .on("data", onData)
        .on("volume", setInVolume)
        .on("vad", (speaking: boolean) => setIsSpeaking(speaking))
        .start(sharedStream)
        .then(() => {
          audioRecorder.setVadEnabled(true);
          console.log("[LivePanel] audioRecorder started OK (VAD enabled)");
        })
        .catch((err: unknown) =>
          console.warn("[LivePanel] audioRecorder start failed:", err)
        );
    } else {
      audioRecorder.stop();
    }

    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume).off("vad");
      setIsSpeaking(false);
    };
  }, [connected, client, sharedStream, audioRecorder]);

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

  const toggleMode = () => {
    setMode((prev) => (prev === "passive" ? "active" : "passive"));
  };

  const volumeWidth = (vol: number) =>
    `${Math.min(vol * 300, 100)}%`;

  return (
    <div className="relative flex items-center gap-2">
      {/* ThinkingQueue overlay */}
      <ThinkingQueuePanel />

      {/* Hidden elements for tab capture */}
      <video ref={videoRef} className="hidden" playsInline />
      <canvas ref={canvasRef} className="hidden" />

      {/* Live AI indicator */}
      <Sparkles size={14} className="text-yellow-500 flex-shrink-0" />
      {connected && (
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
      )}

      {/* Connect / Disconnect */}
      <button
        onClick={connected ? disconnect : connect}
        disabled={!connected && !sharedStream}
        className={`p-2 rounded-xl transition-all ${
          connected
            ? "bg-red-500 hover:bg-red-600 text-white"
            : !sharedStream
              ? "bg-gray-300 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500"
              : "bg-green-500 hover:bg-green-600 text-white"
        }`}
        title={connected ? "Live AI 切断" : !sharedStream ? "先にマイクをONにしてください" : "Live AI 接続"}
      >
        {connected ? <PhoneOff size={16} /> : <Phone size={16} />}
      </button>

      {/* Mode toggle */}
      <button
        onClick={toggleMode}
        disabled={connected}
        className={`p-2 rounded-xl transition-all ${
          connected
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-gray-200 dark:hover:bg-gray-600"
        } ${
          mode === "active"
            ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
            : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        }`}
        title={`モード: ${mode === "active" ? "Active" : "Passive"}`}
      >
        {mode === "active" ? (
          <ToggleRight size={16} />
        ) : (
          <ToggleLeft size={16} />
        )}
      </button>

      {/* Tab audio capture */}
      {connected && (
        <button
          onClick={tabAudioActive ? stopTabAudio : startTabAudio}
          className={`p-2 rounded-xl transition ${
            tabAudioActive
              ? "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400"
              : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
          }`}
          title={tabAudioActive ? "タブ音声停止" : "タブ音声キャプチャ"}
        >
          {tabAudioActive ? <MonitorOff size={16} /> : <MonitorUp size={16} />}
        </button>
      )}

      {/* Brain processing indicator */}
      {isProcessing && (
        <span className="flex items-center gap-1 text-xs text-amber-500 animate-pulse flex-shrink-0">
          <Loader2 size={12} className="animate-spin" />
          処理中...
        </span>
      )}

      {/* Volume indicators (compact) + VAD indicator */}
      {connected && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
              isSpeaking ? "bg-green-500" : "bg-gray-400"
            }`}
            title={isSpeaking ? "発話検出中" : "無音"}
          />
          <div className="w-8 h-1.5 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-75"
              style={{ width: volumeWidth(inVolume) }}
            />
          </div>
          <div className="w-8 h-1.5 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-75"
              style={{ width: volumeWidth(volume) }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LivePanel - API key fetch + provider wrapper (inline, no sidebar)  */
/* ------------------------------------------------------------------ */

interface LivePanelProps {
  roomId: string | null;
  roomData: SessionData | null;
  sharedStream?: MediaStream | null;
  currentSessionId?: string | null;
}

export default function LivePanel({
  roomId,
  roomData,
  sharedStream,
  currentSessionId,
}: LivePanelProps) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        if (data.geminiApiKey) {
          setApiKey(data.geminiApiKey);
        } else {
          setKeyError("Gemini APIキー未設定");
        }
      })
      .catch(() => {
        setKeyError("バックエンド接続エラー");
      });
  }, []);

  const liveOptions = useMemo(() => (apiKey ? { apiKey } : null), [apiKey]);

  if (keyError) {
    return (
      <span className="text-xs text-red-400" title={keyError}>
        <Sparkles size={14} className="inline text-red-400" /> Live AI エラー
      </span>
    );
  }

  if (!liveOptions) {
    return (
      <span className="text-xs text-gray-400">
        <Sparkles size={14} className="inline" /> 読込中...
      </span>
    );
  }

  return (
    <LiveAPIProvider options={liveOptions}>
      <ThinkingQueueProvider>
        <LivePanelInner
          roomId={roomId}
          roomData={roomData}
          sharedStream={sharedStream}
          currentSessionId={currentSessionId}
        />
      </ThinkingQueueProvider>
    </LiveAPIProvider>
  );
}

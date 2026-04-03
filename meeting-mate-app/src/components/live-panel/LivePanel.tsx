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
  Camera,
  CameraOff,
} from "lucide-react";
import ImageAttachmentButton from "./ImageAttachmentButton";
import ImagePreviewOverlay from "./ImagePreviewOverlay";
import { resizeImageToBase64 } from "../../lib/image-utils";
import { LiveAPIProvider, useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { AudioRecorder } from "../../lib/audio-recorder";
import { LiveToolHandler, MeetingContextProvider } from "../../lib/live-tools/tool-handler";
import { liveToolDeclarations } from "../../lib/live-tools/tool-declarations";
import { getSystemPrompt } from "../../lib/live-tools/system-prompts";
import type { ConnectionState, LiveMode, LivePanelAPI } from "../../types/live-api";
import type { SessionData, TranscriptEntry, TodoItem, Notes } from "../../types/data";
import { useBrain } from "../../hooks/useBrain";
import { filterThinkingText } from "../../lib/transcript-filter";
import { authFetch } from "../../lib/api-client";
import { Modality } from "@google/genai";
import type { LiveServerToolCall, LiveServerToolCallCancellation, LiveConnectConfig } from "@google/genai";
import { ThinkingQueueProvider, useThinkingQueue } from "../../contexts/ThinkingQueueContext";
import ThinkingQueuePanel from "../thinking-queue/ThinkingQueuePanel";
import { useProactiveMonitor } from "../../hooks/useProactiveMonitor";
import ProactiveSuggestionBanner from "./ProactiveSuggestionBanner";

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
  onReady?: (api: LivePanelAPI) => void;
}

function LivePanelInner({
  roomId,
  roomData,
  sharedStream,
  currentSessionId,
  onReady,
}: LivePanelInnerProps) {
  const { client, setConfig, connected, connectionState, connect, disconnect, volume } =
    useLiveAPIContext();
  const { addTask, updateTask, clear: clearThinkingQueue } = useThinkingQueue();

  const [mode, setMode] = useState<LiveMode>("passive");
  const toolHandlerRef = useRef<LiveToolHandler>(new LiveToolHandler());

  // Auto-intervene setting (persisted in localStorage)
  const [autoInterveneEnabled, setAutoInterveneEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const stored = localStorage.getItem("noa-proactive-auto-intervene");
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const toggleAutoIntervene = useCallback(() => {
    setAutoInterveneEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem("noa-proactive-auto-intervene", String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Track proactive injection time for AI-to-AI loop prevention
  const lastProactiveInjectTimeRef = useRef(0);

  // Audio recording (merged from LiveControlTray)
  const [inVolume, setInVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [tabAudioActive, setTabAudioActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tabStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    onCalendarLink: (link: { calendarUrl: string; summary: string; start: string; end: string; timezone: string; description?: string; location?: string }) => {
      if (!roomId || !link.calendarUrl) return;
      const db = getDatabase();
      if (!db) return;
      const linkId = Date.now().toString() + Math.random().toString(36).substring(2, 8);
      const path = currentSessionId
        ? `rooms/${roomId}/sessions/${currentSessionId}/calendarLinks/${linkId}`
        : `rooms/${roomId}/calendarLinks/${linkId}`;
      set(ref(db, path), {
        id: linkId,
        summary: link.summary,
        startAt: link.start,
        endAt: link.end,
        timezone: link.timezone,
        description: link.description || "",
        location: link.location || "",
        googleCalendarUrl: link.calendarUrl,
        createdAt: new Date().toISOString(),
      });
    },
  }), [roomId, currentSessionId]);
  const { isProcessing, requestBrain, abortAll: abortBrain } = useBrain(client, connected, roomData, brainCallbacks, thinkingQueue, roomId);

  // Auto-intervene handler: confidence >= 0.9 → バナーなしで Live AI にテキスト注入
  // Returns true if injection succeeded, false to fall back to banner
  const handleAutoIntervene = useCallback((suggestion: { suggestion: string }): boolean => {
    if (!connected) return false;
    if (toolHandlerRef.current.hasActiveFunctionCalls()) {
      console.log("[LivePanel] FC in progress, skipping auto-intervene → banner fallback");
      return false;
    }
    client.send(
      { text: `【プロアクティブ】${suggestion.suggestion}\n確認してみますね。` },
      true,
    );
    lastProactiveInjectTimeRef.current = Date.now();
    console.log("[LivePanel] Auto-intervene sent:", suggestion.suggestion.slice(0, 50));
    return true;
  }, [client, connected]);

  // Proactive monitor (Active mode only)
  const { currentSuggestion, dismissSuggestion, acceptSuggestion } = useProactiveMonitor({
    enabled: mode === "active" && connected,
    autoInterveneEnabled,
    onAutoIntervene: handleAutoIntervene,
    roomData,
    roomId,
    currentSessionId: currentSessionId ?? null,
    thinkingQueue,
  });

  // Proactive action handler: バナーの「確認する」ボタン → Live AI にテキスト注入
  const handleProactiveAction = useCallback((suggestion: { suggestion: string }) => {
    if (!connected) return;
    if (toolHandlerRef.current.hasActiveFunctionCalls()) {
      console.log("[LivePanel] FC in progress, deferring proactive action");
      return;
    }
    client.send({ text: `【プロアクティブ】${suggestion.suggestion}` }, true);
    lastProactiveInjectTimeRef.current = Date.now();
    acceptSuggestion();
    console.log("[LivePanel] Proactive action sent:", suggestion.suggestion.slice(0, 50));
  }, [client, connected, acceptSuggestion]);

  // sendText: page.tsx から Live AI にテキストを送信する
  const sendText = useCallback((text: string) => {
    if (!connected) {
      console.log("[LivePanel] sendText: not connected, ignoring");
      return;
    }
    client.send({ text }, true);
    console.log("[LivePanel] sendText:", text.slice(0, 50));
  }, [client, connected]);

  // sendImage: 画像を Live AI に送信する (sendRealtimeInput 経由)
  const sendImage = useCallback((base64: string, mimeType: string) => {
    if (!connected) {
      console.warn("[LivePanel] sendImage: not connected");
      return;
    }
    client.sendRealtimeInput([{ mimeType, data: base64 }]);
    console.log("[LivePanel] sendImage: sent", mimeType, `${Math.round(base64.length / 1024)}KB`);
  }, [connected, client]);

  // Image attachment state
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imagePreviewStatus, setImagePreviewStatus] = useState<"pending" | "sent" | "error">("pending");
  const [imageErrorMessage, setImageErrorMessage] = useState<string>("");
  const pendingImageRef = useRef<{ base64: string; mimeType: string } | null>(null);

  const handleImageReady = useCallback((base64: string, mimeType: string) => {
    pendingImageRef.current = { base64, mimeType };
  }, []);

  const handleImagePreview = useCallback((previewUrl: string) => {
    setImagePreviewUrl(previewUrl);
    setImagePreviewStatus("pending");
    setImageErrorMessage("");
  }, []);

  const handleImageError = useCallback((message: string) => {
    setImagePreviewUrl(null);
    setImagePreviewStatus("error");
    setImageErrorMessage(message);
    pendingImageRef.current = null;
  }, []);

  const handleImageSend = useCallback(() => {
    const pending = pendingImageRef.current;
    if (!pending) return;
    sendImage(pending.base64, pending.mimeType);
    setImagePreviewStatus("sent");
    pendingImageRef.current = null;
  }, [sendImage]);

  const handleImageCancel = useCallback(() => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(null);
    setImagePreviewStatus("pending");
    setImageErrorMessage("");
    pendingImageRef.current = null;
  }, [imagePreviewUrl]);

  // Clipboard paste handler for images
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    if (!connected) return;
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        try {
          const previewUrl = URL.createObjectURL(file);
          handleImagePreview(previewUrl);
          const { base64, mimeType } = await resizeImageToBase64(file);
          handleImageReady(base64, mimeType);
        } catch (err) {
          handleImageError(err instanceof Error ? err.message : "画像の処理に失敗しました。");
        }
        return;
      }
    }
  }, [connected, handleImagePreview, handleImageReady, handleImageError]);

  // onReady で sendText API を公開
  useEffect(() => {
    onReady?.({ sendText });
  }, [onReady, sendText]);

  // Accumulate current model turn text (no UI state needed)
  const currentModelTextRef = useRef<string>("");

  // Configure tool handler with room context + session state
  useEffect(() => {
    const contextProvider: MeetingContextProvider = {
      getRoomData: () => roomData,
      getSessionState: () => {
        // roomData から session-scoped なデータを返す
        // (useRoomData の onValue リスナーで最新状態が反映済み)
        if (!roomData) return null;
        const transcript = Array.isArray(roomData.transcript)
          ? roomData.transcript
          : roomData.transcript
            ? Object.values(roomData.transcript as Record<string, TranscriptEntry>)
            : [];
        const tasks = Array.isArray(roomData.tasks)
          ? roomData.tasks
          : roomData.tasks
            ? Object.values(roomData.tasks as Record<string, TodoItem>)
            : [];
        const notes = Array.isArray(roomData.notes)
          ? roomData.notes
          : roomData.notes
            ? Object.values(roomData.notes as Record<string, Notes[number]>)
            : [];
        const participants = roomData.participants
          ? Object.entries(roomData.participants).map(([id, p]) => ({ id, ...p }))
          : [];
        return {
          transcript,
          tasks,
          notes,
          currentAgenda: roomData.currentAgenda || null,
          suggestedNextTopics: roomData.suggestedNextTopics || [],
          participants,
        };
      },
    };
    toolHandlerRef.current.setContextProvider(contextProvider);
    toolHandlerRef.current.setCallbacks({
      onBrainRequested: requestBrain,
    });
  }, [roomData, requestBrain]);

  // Sync transcript to Firebase (with origin)
  // AI-to-AI ループ防止: proactive 注入後 15 秒以内の AI 発話は "proactive_ai" origin でマーク
  const PROACTIVE_ORIGIN_WINDOW_MS = 15_000;
  const syncTranscriptToFirebase = useCallback(
    (text: string, role: "user" | "ai") => {
      // AI発話の場合、内部思考テキスト (markdown) をフィルタ
      const cleanText = role === "ai" ? filterThinkingText(text) : text;
      if (!roomId || !cleanText.trim()) return;
      const db = getDatabase();
      if (!db) return;

      // proactive 起点かどうかを判定
      let origin: string;
      if (role === "ai") {
        const isProactiveResponse =
          lastProactiveInjectTimeRef.current > 0 &&
          Date.now() - lastProactiveInjectTimeRef.current < PROACTIVE_ORIGIN_WINDOW_MS;
        origin = isProactiveResponse ? "proactive_ai" : "live_ai";
        if (isProactiveResponse) {
          lastProactiveInjectTimeRef.current = 0; // 一度マークしたらリセット
        }
      } else {
        origin = "human_stt";
      }

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
        origin,
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
      contextWindowCompression: {
        triggerTokens: "200000",
        slidingWindow: {
          targetTokens: "100000",
        },
      },
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

  // Vision snapshot: クライアント側差分検出 + バックエンド送信
  const lastSnapshotPixelsRef = useRef<Uint8Array | null>(null);
  const lastSnapshotTimeRef = useRef<number>(0);
  const VISION_MIN_INTERVAL = 30_000; // 30秒間隔
  const VISION_DIFF_THRESHOLD = 0.15; // 15% 以上の変化で送信

  const computeAndSendVisionSnapshot = useCallback(
    (sourceCanvas: HTMLCanvasElement) => {
      const now = Date.now();
      if (now - lastSnapshotTimeRef.current < VISION_MIN_INTERVAL) return;
      if (!roomId) return;

      // 32x32 グレースケールで差分検出
      const small = document.createElement("canvas");
      small.width = 32;
      small.height = 32;
      const sCtx = small.getContext("2d");
      if (!sCtx) return;
      sCtx.drawImage(sourceCanvas, 0, 0, 32, 32);
      const imgData = sCtx.getImageData(0, 0, 32, 32);
      const pixels = new Uint8Array(32 * 32);
      for (let i = 0; i < pixels.length; i++) {
        const r = imgData.data[i * 4];
        const g = imgData.data[i * 4 + 1];
        const b = imgData.data[i * 4 + 2];
        pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }

      if (lastSnapshotPixelsRef.current) {
        let diffCount = 0;
        for (let i = 0; i < pixels.length; i++) {
          if (Math.abs(pixels[i] - lastSnapshotPixelsRef.current[i]) > 20) {
            diffCount++;
          }
        }
        const diffRatio = diffCount / pixels.length;
        if (diffRatio < VISION_DIFF_THRESHOLD) return; // 変化なし → skip
      }

      lastSnapshotPixelsRef.current = pixels;
      lastSnapshotTimeRef.current = now;

      // 分析用に少し高解像度でキャプチャ (50%, 60% quality)
      const analysisCanvas = document.createElement("canvas");
      analysisCanvas.width = sourceCanvas.width * 2; // 25% → 50%
      analysisCanvas.height = sourceCanvas.height * 2;
      const aCtx = analysisCanvas.getContext("2d");
      if (!aCtx) return;
      // sourceCanvas の元の video から描画
      const videoEl = videoRef.current;
      if (!videoEl) return;
      aCtx.drawImage(videoEl, 0, 0, analysisCanvas.width, analysisCanvas.height);
      const b64 = analysisCanvas.toDataURL("image/jpeg", 0.6);
      const data = b64.slice(b64.indexOf(",") + 1);

      authFetch("/api/vision/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          sessionId: currentSessionId,
          imageBase64: data,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.warn("[LivePanel] Vision snapshot failed:", err));
    },
    [roomId, currentSessionId]
  );

  // Tab audio capture
  const stopTabAudio = useCallback(() => {
    tabStreamRef.current?.getTracks().forEach((t) => t.stop());
    tabStreamRef.current = null;
    setTabAudioActive(false);
  }, []);

  // Camera capture
  const stopCamera = useCallback(() => {
    if (cameraTimerRef.current) {
      clearTimeout(cameraTimerRef.current);
      cameraTimerRef.current = null;
    }
    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
    }
    cameraStreamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    cameraStreamRef.current = null;
    setCameraActive(false);
  }, []);

  // Session cleanup (brain, tool handler, thinking queue — safe during reconnect)
  const cleanupSession = useCallback(() => {
    abortBrain();
    toolHandlerRef.current.resetForDisconnect();
    clearThinkingQueue();
  }, [abortBrain, clearThinkingQueue]);

  // Full cleanup (session + media streams — only on final disconnect)
  const cleanupFull = useCallback(() => {
    cleanupSession();
    stopTabAudio();
    stopCamera();
  }, [cleanupSession, stopTabAudio, stopCamera]);

  const handleDisconnect = useCallback(() => {
    disconnect(); // isManualDisconnect=true set internally → connectionState="disconnected"
  }, [disconnect]);

  const handleConnect = useCallback(() => {
    connect();
  }, [connect]);

  // Unified cleanup: connectionState 遷移に基づき1回だけ実行
  const prevConnectionStateRef = useRef<ConnectionState>("disconnected");
  useEffect(() => {
    const prev = prevConnectionStateRef.current;
    prevConnectionStateRef.current = connectionState;

    // connected → reconnecting: session cleanup のみ (tab audio 維持)
    if (prev === "connected" && connectionState === "reconnecting") {
      cleanupSession();
    }
    // connected → disconnected: full cleanup (手動切断 or 再接続断念)
    if (prev === "connected" && connectionState === "disconnected") {
      cleanupFull();
    }
    // reconnecting → disconnected: tab audio も止める (再接続失敗)
    if (prev === "reconnecting" && connectionState === "disconnected") {
      stopTabAudio();
    }
  }, [connectionState, cleanupSession, cleanupFull, stopTabAudio]);

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

          // Vision 分析: 差分検出 + バックエンド送信
          computeAndSendVisionSnapshot(canvas);

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

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });

      cameraStreamRef.current = stream;
      setCameraActive(true);

      const video = cameraVideoRef.current;
      const canvas = cameraCanvasRef.current;
      if (!video || !canvas) return;

      video.srcObject = new MediaStream(stream.getVideoTracks());
      await video.play();

      const sendFrame = () => {
        if (!connected || cameraStreamRef.current !== stream) return;
        if (!canvas || !video) return;

        canvas.width = video.videoWidth * 0.25;
        canvas.height = video.videoHeight * 0.25;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL("image/jpeg", 0.5);
        const data = base64.slice(base64.indexOf(",") + 1);
        client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);

        cameraTimerRef.current = setTimeout(sendFrame, 2000); // 0.5 FPS
      };
      sendFrame();

      stream.getTracks().forEach((track) => {
        track.onended = () => stopCamera();
      });
    } catch (err) {
      console.error("[LivePanel] Camera capture failed:", err);
    }
  }, [connected, client, stopCamera]);

  const toggleMode = () => {
    setMode((prev) => (prev === "passive" ? "active" : "passive"));
  };

  const volumeWidth = (vol: number) =>
    `${Math.min(vol * 300, 100)}%`;

  return (
    <div className="relative flex items-center gap-2" onPaste={handlePaste}>
      {/* Image preview overlay */}
      <ImagePreviewOverlay
        previewUrl={imagePreviewUrl}
        status={imagePreviewStatus}
        errorMessage={imageErrorMessage}
        onSend={handleImageSend}
        onCancel={handleImageCancel}
      />

      {/* ThinkingQueue overlay */}
      <ThinkingQueuePanel />

      {/* Proactive suggestion banner */}
      <ProactiveSuggestionBanner
        suggestion={currentSuggestion}
        onDismiss={dismissSuggestion}
        onAction={handleProactiveAction}
      />

      {/* Hidden elements for tab capture */}
      <video ref={videoRef} className="hidden" playsInline />
      <canvas ref={canvasRef} className="hidden" />

      {/* Hidden elements for camera capture */}
      <video ref={cameraVideoRef} className="hidden" playsInline muted />
      <canvas ref={cameraCanvasRef} className="hidden" />

      {/* Live AI indicator */}
      <Sparkles size={14} className="text-yellow-500 flex-shrink-0" />
      {connectionState === "reconnecting" && (
        <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse flex-shrink-0" title="再接続中..." />
      )}
      {connected && (
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
      )}

      {/* Connect / Disconnect */}
      <button
        onClick={connected ? handleDisconnect : handleConnect}
        disabled={connectionState === "reconnecting" || (!connected && !sharedStream)}
        className={`p-2 rounded-xl transition-all ${
          connectionState === "reconnecting"
            ? "bg-yellow-500 text-white cursor-wait"
            : connected
              ? "bg-red-500 hover:bg-red-600 text-white"
              : !sharedStream
                ? "bg-gray-300 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500"
                : "bg-green-500 hover:bg-green-600 text-white"
        }`}
        title={connectionState === "reconnecting" ? "再接続中..." : connected ? "Live AI 切断" : !sharedStream ? "先にマイクをONにしてください" : "Live AI 接続"}
      >
        {connectionState === "reconnecting" ? <Loader2 size={16} className="animate-spin" /> : connected ? <PhoneOff size={16} /> : <Phone size={16} />}
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

      {/* Auto-intervene toggle (Active mode only) */}
      {mode === "active" && (
        <button
          onClick={toggleAutoIntervene}
          className={`px-1.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
            autoInterveneEnabled
              ? "bg-orange-200 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300"
              : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
          }`}
          title={autoInterveneEnabled ? "自動介入 ON" : "自動介入 OFF"}
        >
          自動{autoInterveneEnabled ? "ON" : "OFF"}
        </button>
      )}

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

      {/* Camera capture */}
      {connected && (
        <button
          onClick={cameraActive ? stopCamera : startCamera}
          className={`p-2 rounded-xl transition ${
            cameraActive
              ? "bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400"
              : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
          }`}
          title={cameraActive ? "カメラ停止" : "カメラ映像を送信"}
        >
          {cameraActive ? <CameraOff size={16} /> : <Camera size={16} />}
        </button>
      )}

      {/* Image attachment */}
      {connected && (
        <ImageAttachmentButton
          onImageReady={handleImageReady}
          onPreview={handleImagePreview}
          onError={handleImageError}
          disabled={!connected}
        />
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
  onReady?: (api: LivePanelAPI) => void;
}

export default function LivePanel({
  roomId,
  roomData,
  sharedStream,
  currentSessionId,
  onReady,
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
          onReady={onReady}
        />
      </ThinkingQueueProvider>
    </LiveAPIProvider>
  );
}

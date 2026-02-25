"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight,
  ChevronLeft,
  ToggleLeft,
  ToggleRight,
  Sparkles,
} from "lucide-react";
import { LiveAPIProvider, useLiveAPIContext } from "../../contexts/LiveAPIContext";
import LiveChatDisplay, { LiveChatMessage } from "./LiveChatDisplay";
import LiveControlTray from "./LiveControlTray";
import { LiveToolHandler, MeetingContextProvider } from "../../lib/live-tools/tool-handler";
import { liveToolDeclarations } from "../../lib/live-tools/tool-declarations";
import { getSystemPrompt, getModeLabel } from "../../lib/live-tools/system-prompts";
import type { LiveMode } from "../../types/live-api";
import type { SessionData } from "../../types/data";
import { Modality } from "@google/genai";
import type { LiveServerToolCall, LiveConnectConfig } from "@google/genai";

// Firebase 書き込み用（トランスクリプト同期）
import { ref, push } from "firebase/database";
import { database as getDatabase } from "../../firebase";

interface LivePanelInnerProps {
  roomId: string | null;
  roomData: SessionData | null;
  onDiagramGenerated?: (mermaidCode: string) => void;
}

function LivePanelInner({
  roomId,
  roomData,
  onDiagramGenerated,
}: LivePanelInnerProps) {
  const { client, setConfig, connected } = useLiveAPIContext();
  const [messages, setMessages] = useState<LiveChatMessage[]>([]);
  const [mode, setMode] = useState<LiveMode>("passive");
  const toolHandlerRef = useRef<LiveToolHandler>(new LiveToolHandler());

  // Configure tool handler with room context
  useEffect(() => {
    const contextProvider: MeetingContextProvider = {
      getRoomData: () => roomData,
    };
    toolHandlerRef.current.setContextProvider(contextProvider);
    toolHandlerRef.current.setCallbacks({
      onDiagram: (mermaidCode, title) => {
        onDiagramGenerated?.(mermaidCode);
        setMessages((prev) => [
          ...prev,
          {
            role: "model",
            text: `[図を生成しました: ${title}]`,
            timestamp: new Date(),
          },
        ]);
      },
    });
  }, [roomData, onDiagramGenerated]);

  // Sync transcript to Firebase
  const syncTranscriptToFirebase = useCallback(
    (text: string, role: "user" | "ai") => {
      if (!roomId || !text.trim()) return;
      const db = getDatabase();
      if (!db) return;

      const transcriptRef = ref(db, `sessions/${roomId}/transcript`);
      push(transcriptRef, {
        userId: role === "ai" ? "noa-live" : "live-user",
        userName: role === "ai" ? "Noa (Live)" : "Live User",
        text: text.trim(),
        timestamp: new Date().toISOString(),
        role,
      });
    },
    [roomId]
  );

  // Update config when mode changes
  useEffect(() => {
    const config: LiveConnectConfig = {
      systemInstruction: {
        parts: [{ text: getSystemPrompt(mode) }],
      },
      tools: [{ functionDeclarations: liveToolDeclarations }],
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
    };
    setConfig(config);
  }, [mode, setConfig]);

  // Listen for content events (transcripts)
  useEffect(() => {
    const onContent = (data: { modelTurn?: { parts?: { text?: string }[] } }) => {
      if (data.modelTurn?.parts) {
        for (const part of data.modelTurn.parts) {
          if (part.text) {
            setMessages((prev) => {
              // Merge with last model message if it exists and is the latest
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === "model") {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...lastMsg,
                  text: lastMsg.text + part.text,
                };
                return updated;
              }
              return [
                ...prev,
                { role: "model", text: part.text!, timestamp: new Date() },
              ];
            });
          }
        }
      }
    };

    const onTurnComplete = () => {
      // Force next model message to be a new entry
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role === "model") {
          // Sync completed transcript to Firebase
          syncTranscriptToFirebase(last.text, "ai");
        }
        return [...prev, { role: "model" as const, text: "", timestamp: new Date() }];
      });
      // Remove empty trailing message
      setMessages((prev) =>
        prev.filter((m, i) => i < prev.length - 1 || m.text.trim() !== "")
      );
    };

    const onToolCall = (toolCall: LiveServerToolCall) => {
      toolHandlerRef.current.handleToolCall(toolCall, client);
    };

    client.on("content", onContent);
    client.on("turncomplete", onTurnComplete);
    client.on("toolcall", onToolCall);

    return () => {
      client.off("content", onContent);
      client.off("turncomplete", onTurnComplete);
      client.off("toolcall", onToolCall);
    };
  }, [client, syncTranscriptToFirebase]);

  const handleSendText = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { role: "user", text, timestamp: new Date() },
    ]);
    syncTranscriptToFirebase(text, "user");
  };

  const toggleMode = () => {
    setMode((prev) => (prev === "passive" ? "active" : "passive"));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with mode toggle */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-yellow-500" />
          <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
            Live AI
          </span>
          {connected && (
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
        </div>

        <button
          onClick={toggleMode}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          title={`モード切替: ${getModeLabel(mode)}`}
          disabled={connected}
        >
          {mode === "active" ? (
            <ToggleRight size={16} className="text-orange-500" />
          ) : (
            <ToggleLeft size={16} className="text-blue-500" />
          )}
          <span className="text-gray-600 dark:text-gray-400">
            {mode === "active" ? "Active" : "Passive"}
          </span>
        </button>
      </div>

      {/* Chat display */}
      <div className="flex-1 overflow-hidden">
        <LiveChatDisplay messages={messages} />
      </div>

      {/* Controls */}
      <LiveControlTray
        mode={mode}
        onSendText={handleSendText}
      />
    </div>
  );
}

// Wrapper with LiveAPIProvider
interface LivePanelProps {
  roomId: string | null;
  roomData: SessionData | null;
  onDiagramGenerated?: (mermaidCode: string) => void;
}

export default function LivePanel({
  roomId,
  roomData,
  onDiagramGenerated,
}: LivePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-sm text-gray-500">
        <p>
          NEXT_PUBLIC_GEMINI_API_KEY が設定されていません。
          <br />
          .env.local に追加してください。
        </p>
      </div>
    );
  }

  return (
    <div
      className={`fixed right-0 top-0 h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-lg transition-all duration-300 z-40 flex ${
        collapsed ? "w-10" : "w-80"
      }`}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-12 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-l-lg flex items-center justify-center shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 z-50"
      >
        {collapsed ? (
          <ChevronLeft size={14} />
        ) : (
          <ChevronRight size={14} />
        )}
      </button>

      {!collapsed && (
        <LiveAPIProvider options={{ apiKey }}>
          <LivePanelInner
            roomId={roomId}
            roomData={roomData}
            onDiagramGenerated={onDiagramGenerated}
          />
        </LiveAPIProvider>
      )}
    </div>
  );
}

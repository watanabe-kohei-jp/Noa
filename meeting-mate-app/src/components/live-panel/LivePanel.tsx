"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  Phone,
  PhoneOff,
  MonitorUp,
  MonitorOff,
  ToggleLeft,
  ToggleRight,
  Sparkles,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { LiveAPIProvider } from "../../contexts/LiveAPIContext";
import type { SessionData } from "../../types/data";
import { ThinkingQueueProvider } from "../../contexts/ThinkingQueueContext";
import ThinkingQueuePanel from "../thinking-queue/ThinkingQueuePanel";
import { useLivePanel } from "../../hooks/useLivePanel";
import { authFetch } from "../../lib/api-client";

/* ------------------------------------------------------------------ */
/*  LivePanelInner - pure presentation                                 */
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
  const {
    connected,
    connect,
    disconnect,
    mode,
    toggleMode,
    inVolume,
    outVolume,
    tabAudioActive,
    startTabAudio,
    stopTabAudio,
    isProcessing,
    canConnect,
    noStreamWarning,
    isSpeaking,
    videoRef,
    canvasRef,
  } = useLivePanel({
    roomId,
    roomData,
    sharedStream: sharedStream ?? null,
    currentSessionId: currentSessionId ?? null,
  });

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

      {/* No-stream warning */}
      {noStreamWarning && (
        <span
          className="text-amber-500 flex-shrink-0"
          title="マイクがOFFです。Live AIに音声が送信されていません"
        >
          <AlertTriangle size={14} />
        </span>
      )}

      {/* Connect / Disconnect */}
      <button
        onClick={connected ? disconnect : connect}
        disabled={!connected && !canConnect}
        className={`p-2 rounded-xl transition-all ${
          connected
            ? "bg-red-500 hover:bg-red-600 text-white"
            : !canConnect
              ? "bg-gray-300 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500"
              : "bg-green-500 hover:bg-green-600 text-white"
        }`}
        title={connected ? "Live AI 切断" : !canConnect ? "先にマイクをONにしてください" : "Live AI 接続"}
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
              style={{ width: volumeWidth(outVolume) }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LivePanel - API key fetch + provider wrapper                       */
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

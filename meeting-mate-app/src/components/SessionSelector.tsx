"use client";

import React, { useState } from "react";
import { Plus, Check, Clock } from "lucide-react";
import type { MeetingSession } from "@/types/data";

interface SessionSelectorProps {
  sessions: MeetingSession[];
  currentSessionId: string | null;
  onCreateSession: (name?: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onEndSession: (sessionId: string) => void;
}

export default function SessionSelector({
  sessions,
  currentSessionId,
  onCreateSession,
  onSwitchSession,
  onEndSession,
}: SessionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const displayName = currentSession?.name || "セッション未選択";

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
      >
        <Clock size={14} className="text-gray-500" />
        <span className="max-w-[120px] truncate">{displayName}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-2 left-0 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => {
                onCreateSession();
                setIsOpen(false);
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition"
            >
              <Plus size={16} />
              新しいセッション
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="p-3 text-xs text-gray-400 text-center">
                セッションがありません
              </p>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => {
                    onSwitchSession(session.id);
                    setIsOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition ${
                    session.id === currentSessionId
                      ? "bg-blue-50 dark:bg-blue-900/20"
                      : ""
                  }`}
                >
                  {session.id === currentSessionId && (
                    <Check size={14} className="text-blue-500 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-medium">
                        {session.name}
                      </span>
                      {session.status === "ended" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 flex-shrink-0">
                          終了
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400">
                      {formatTime(session.startedAt)}
                      {session.endedAt
                        ? ` - ${formatTime(session.endedAt)}`
                        : " 〜"}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

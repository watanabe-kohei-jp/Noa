"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Plus, Check, Clock, StopCircle, Trash2, Search } from "lucide-react";
import type { MeetingSession } from "@/types/data";

interface SessionSelectorProps {
  sessions: MeetingSession[];
  currentSessionId: string | null;
  onCreateSession: (name?: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onEndSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onDeleteSession: (sessionId: string) => void;
  roomId: string | null;
}

export default function SessionSelector({
  sessions,
  currentSessionId,
  onCreateSession,
  onSwitchSession,
  onEndSession,
  onRenameSession,
  onDeleteSession,
  roomId,
}: SessionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const displayName = currentSession?.name || "セッション未選択";

  interface SearchResult {
    session_id: string;
    summary: string;
    distance: number;
    metadata: Record<string, unknown>;
  }

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

  // P3: インライン編集開始
  const startEditing = (session: MeetingSession) => {
    setEditingSessionId(session.id);
    setEditName(session.name);
  };

  // P3: 編集確定
  const commitEdit = () => {
    if (editingSessionId && editName.trim()) {
      onRenameSession(editingSessionId, editName.trim());
    }
    setEditingSessionId(null);
    setEditName("");
  };

  // P3: 編集キャンセル
  const cancelEdit = () => {
    setEditingSessionId(null);
    setEditName("");
  };

  // P3: 編集input にフォーカス
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  // P2: 検索 debounce
  const doSearch = useCallback(async (query: string) => {
    if (!roomId || query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_id: roomId, query, n_results: 5 }),
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results || []);
      }
    } catch (err) {
      console.error("[SessionSelector] Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  }, [roomId]);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => doSearch(value), 300);
  };

  // 検索結果のセッション名をFirebaseデータから取得
  const getSessionName = (sessionId: string): string => {
    const session = sessions.find((s) => s.id === sessionId);
    return session?.name || "不明なセッション";
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
        <div className="absolute bottom-full mb-2 left-0 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg z-50 overflow-hidden">
          {/* P2: 検索バー */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <Search size={14} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="過去のセッションを検索..."
                className="flex-1 bg-transparent text-sm outline-none text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
              />
            </div>
          </div>

          {/* P2: 検索結果 */}
          {searchQuery.length >= 2 && (
            <div className="border-b border-gray-200 dark:border-gray-700">
              {isSearching ? (
                <p className="p-3 text-xs text-gray-400 text-center">検索中...</p>
              ) : searchResults.length === 0 ? (
                <p className="p-3 text-xs text-gray-400 text-center">結果なし</p>
              ) : (
                <div className="max-h-32 overflow-y-auto">
                  {searchResults.map((result) => (
                    <button
                      key={result.session_id}
                      onClick={() => {
                        onSwitchSession(result.session_id);
                        setSearchQuery("");
                        setSearchResults([]);
                        setIsOpen(false);
                      }}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition"
                    >
                      <div className="font-medium text-blue-600 dark:text-blue-400">
                        {getSessionName(result.session_id)}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">
                        {result.summary.slice(0, 100)}...
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 新しいセッション作成 */}
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

          {/* セッション一覧 */}
          <div className="max-h-48 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="p-3 text-xs text-gray-400 text-center">
                セッションがありません
              </p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition ${
                    session.id === currentSessionId
                      ? "bg-blue-50 dark:bg-blue-900/20"
                      : ""
                  }`}
                >
                  {/* チェックアイコン */}
                  {session.id === currentSessionId && (
                    <Check size={14} className="text-blue-500 flex-shrink-0" />
                  )}

                  {/* セッション情報（クリックで切替） */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => {
                      if (!editingSessionId) {
                        onSwitchSession(session.id);
                        setIsOpen(false);
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEditing(session);
                    }}
                  >
                    <div className="flex items-center gap-1">
                      {editingSessionId === session.id ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                          onBlur={commitEdit}
                          className="w-full px-1 py-0.5 text-sm bg-white dark:bg-gray-700 border border-blue-400 rounded outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <span className="truncate font-medium">
                            {session.name}
                          </span>
                          {session.status === "ended" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 flex-shrink-0">
                              終了
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    {editingSessionId !== session.id && (
                      <span className="text-xs text-gray-400">
                        {formatTime(session.startedAt)}
                        {session.endedAt
                          ? ` - ${formatTime(session.endedAt)}`
                          : " 〜"}
                      </span>
                    )}
                  </div>

                  {/* アクションボタン */}
                  {editingSessionId !== session.id && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {/* P1: 終了ボタン (active のみ) */}
                      {session.status === "active" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm("このセッションを終了しますか？\nバックグラウンドで要約が生成されます。")) {
                              onEndSession(session.id);
                            }
                          }}
                          title="セッションを終了"
                          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition"
                        >
                          <StopCircle size={14} />
                        </button>
                      )}
                      {/* P4: 削除ボタン (ended のみ) */}
                      {session.status === "ended" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm("このセッションを削除しますか？\n復元できません。")) {
                              onDeleteSession(session.id);
                            }
                          }}
                          title="セッションを削除"
                          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

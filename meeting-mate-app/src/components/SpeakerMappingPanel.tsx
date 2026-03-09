/**
 * SpeakerMappingPanel
 *
 * 話者タグ (speaker_1, speaker_2, ...) に名前と色を割り当てる UI。
 * Firebase rooms/{roomId}/speakerMap に読み書きする。
 */

"use client";

import React, { useState, useCallback } from "react";
import { ref, set } from "firebase/database";
import { database as getDatabase } from "@/firebase";
import { Users, Edit3, Check, X } from "lucide-react";
import type { SpeakerMap, SpeakerMapEntry } from "@/types/data";

// デフォルト色パレット
const SPEAKER_COLORS = [
  "#4A90D9", "#E8913A", "#50B860", "#D94A7A",
  "#9B59B6", "#1ABC9C", "#F39C12", "#E74C3C",
];

interface SpeakerMappingPanelProps {
  roomId: string | null;
  speakerMap: SpeakerMap;
  /** トランスクリプト内の全 speakerTag を収集して渡す */
  detectedSpeakers: number[];
}

export default function SpeakerMappingPanel({
  roomId,
  speakerMap,
  detectedSpeakers,
}: SpeakerMappingPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  // 検出済み話者のリスト (重複除去・ソート)
  const speakerIds = Array.from(
    new Set(detectedSpeakers.filter((t) => t > 0).map((t) => `speaker_${t}`))
  ).sort();

  const getEntry = (speakerId: string): SpeakerMapEntry => {
    if (speakerMap[speakerId]) return speakerMap[speakerId];
    const num = parseInt(speakerId.replace("speaker_", ""), 10);
    return {
      label: `話者 ${num}`,
      color: SPEAKER_COLORS[(num - 1) % SPEAKER_COLORS.length],
    };
  };

  const saveLabel = useCallback(
    (speakerId: string, newLabel: string) => {
      if (!roomId || !newLabel.trim()) return;
      const db = getDatabase();
      if (!db) return;

      const entry = getEntry(speakerId);
      const updated: SpeakerMapEntry = {
        ...entry,
        label: newLabel.trim(),
      };

      set(ref(db, `rooms/${roomId}/speakerMap/${speakerId}`), updated);
      setEditingId(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomId, speakerMap]
  );

  const startEdit = (speakerId: string) => {
    setEditingId(speakerId);
    setEditLabel(getEntry(speakerId).label);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel("");
  };

  if (speakerIds.length === 0) {
    return (
      <div className="p-3 text-xs text-gray-500 text-center">
        話者が検出されていません
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        <Users size={14} />
        <span>話者マッピング</span>
      </div>

      {speakerIds.map((speakerId) => {
        const entry = getEntry(speakerId);
        const isEditing = editingId === speakerId;

        return (
          <div
            key={speakerId}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800"
          >
            {/* 色インジケーター */}
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: entry.color }}
            />

            {isEditing ? (
              <>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveLabel(speakerId, editLabel);
                    if (e.key === "Escape") cancelEdit();
                  }}
                  className="flex-1 text-sm px-2 py-0.5 rounded border border-blue-400 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={() => saveLabel(speakerId, editLabel)}
                  className="p-0.5 text-green-600 hover:text-green-700"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={cancelEdit}
                  className="p-0.5 text-gray-400 hover:text-gray-600"
                >
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-gray-900 dark:text-gray-100 truncate">
                  {entry.label}
                </span>
                <button
                  onClick={() => startEdit(speakerId)}
                  className="p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <Edit3 size={12} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

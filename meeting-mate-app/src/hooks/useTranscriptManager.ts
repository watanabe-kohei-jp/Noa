/**
 * useTranscriptManager
 *
 * STT と Live API の両方からの発言を統合し、
 * Firebase rooms/{roomId}/transcript に push key ベースで書き込む。
 * speakerMap からラベルを解決して表示用データを提供する。
 */

import { useCallback, useRef } from "react";
import { ref, push } from "firebase/database";
import { database as db } from "@/firebase";
import type { TranscriptEntry, SpeakerMap } from "@/types/data";
import type { STTResult } from "./useStreamingSTT";

interface UseTranscriptManagerOptions {
  roomId: string | null;
  sessionId: string | null;
  speakerMap: SpeakerMap;
}

interface UseTranscriptManagerReturn {
  /** Streaming STT の final 結果をトランスクリプトに追加 */
  addSTTResult: (result: STTResult) => void;
  /** Live API の発言をトランスクリプトに追加 */
  addLiveAPIMessage: (text: string, role: "user" | "ai") => void;
  /** 手動テキスト入力をトランスクリプトに追加 */
  addManualEntry: (text: string, speakerId: string) => void;
}

/** 話者タグを speakerId 文字列に変換 */
function speakerTagToId(tag: number): string {
  if (tag <= 0) return "unknown";
  return `speaker_${tag}`;
}

/** speakerMap からラベルを解決 */
function resolveLabel(speakerId: string, speakerMap: SpeakerMap): string {
  const entry = speakerMap[speakerId];
  if (entry) return entry.label;
  // 未マッピングの場合はデフォルトラベル
  if (speakerId === "noa") return "Noa";
  if (speakerId.startsWith("speaker_")) {
    const num = speakerId.replace("speaker_", "");
    return `話者 ${num}`;
  }
  return speakerId;
}

export function useTranscriptManager(
  options: UseTranscriptManagerOptions
): UseTranscriptManagerReturn {
  const { roomId, sessionId } = options;
  const speakerMapRef = useRef(options.speakerMap);
  speakerMapRef.current = options.speakerMap;

  const pushEntry = useCallback(
    (entry: Omit<TranscriptEntry, "id">) => {
      if (!roomId) return;
      const firebaseDb = db();
      if (!firebaseDb) return;

      // セッションがある場合はセッション配下に書き込み、なければ旧パス
      const path = sessionId
        ? `rooms/${roomId}/sessions/${sessionId}/transcript`
        : `rooms/${roomId}/transcript`;
      const transcriptRef = ref(firebaseDb, path);
      push(transcriptRef, entry);
    },
    [roomId, sessionId]
  );

  const addSTTResult = useCallback(
    (result: STTResult) => {
      if (!result.text.trim()) return;

      // segments がある場合は話者別に分割して書き込み
      if (result.segments && result.segments.length > 0) {
        for (const seg of result.segments) {
          if (!seg.text.trim()) continue;
          const speakerId = speakerTagToId(seg.speakerTag);
          pushEntry({
            userId: speakerId,
            userName: resolveLabel(speakerId, speakerMapRef.current),
            text: seg.text.trim(),
            timestamp: new Date().toISOString(),
            role: "user",
            speakerId,
            speakerLabel: resolveLabel(speakerId, speakerMapRef.current),
            speakerTag: seg.speakerTag,
            startTime: seg.startTime,
            endTime: seg.endTime,
            source: "stt",
            origin: "human_stt",
          });
        }
      } else {
        // segments がない場合は1エントリとして書き込み
        const speakerId = speakerTagToId(result.speakerTag);
        pushEntry({
          userId: speakerId,
          userName: resolveLabel(speakerId, speakerMapRef.current),
          text: result.text.trim(),
          timestamp: new Date().toISOString(),
          role: "user",
          speakerId,
          speakerLabel: resolveLabel(speakerId, speakerMapRef.current),
          speakerTag: result.speakerTag,
          startTime: result.startTime,
          endTime: result.endTime,
          source: "stt",
          origin: "human_stt",
        });
      }
    },
    [pushEntry]
  );

  const addLiveAPIMessage = useCallback(
    (text: string, role: "user" | "ai") => {
      if (!text.trim()) return;
      const speakerId = role === "ai" ? "noa" : "live-user";
      pushEntry({
        userId: speakerId,
        userName: role === "ai" ? "Noa" : "Live User",
        text: text.trim(),
        timestamp: new Date().toISOString(),
        role,
        speakerId,
        speakerLabel: role === "ai" ? "Noa" : "Live User",
        source: "live-api",
        origin: role === "ai" ? "live_ai" : "human_stt",
      });
    },
    [pushEntry]
  );

  const addManualEntry = useCallback(
    (text: string, speakerId: string) => {
      if (!text.trim()) return;
      pushEntry({
        userId: speakerId,
        userName: resolveLabel(speakerId, speakerMapRef.current),
        text: text.trim(),
        timestamp: new Date().toISOString(),
        role: "user",
        speakerId,
        speakerLabel: resolveLabel(speakerId, speakerMapRef.current),
        source: "manual",
        origin: "human_chat",
      });
    },
    [pushEntry]
  );

  return { addSTTResult, addLiveAPIMessage, addManualEntry };
}

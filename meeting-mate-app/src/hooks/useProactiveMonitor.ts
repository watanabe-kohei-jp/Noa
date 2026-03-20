"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionData, TranscriptEntry } from "../types/data";
import type { ThinkingQueueCallbacks } from "./useBrain";
import { buildBrainContext, toTranscriptArray } from "../lib/meeting-context";
import { authFetch } from "../lib/api-client";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const CHECK_INTERVAL_MS = 45_000;
const COOLDOWN_AFTER_SUGGESTION_MS = 90_000;
const MIN_NEW_HUMAN_ENTRIES = 2;
const CONFIDENCE_THRESHOLD = 0.7;
const DEDUPE_EXPIRE_MS = 10 * 60_000;
const AUTO_DISMISS_MS = 30_000;
const THINKING_QUEUE_DELAY_MS = 700;

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface ProactiveSuggestion {
  id: string;
  suggestion: string;
  dedupeKey: string;
  actionType: string;
  timestamp: number;
}

interface UseProactiveMonitorProps {
  enabled: boolean;
  roomData: SessionData | null;
  roomId: string | null;
  currentSessionId: string | null;
  thinkingQueue: ThinkingQueueCallbacks;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function isHumanEntry(t: TranscriptEntry): boolean {
  if (t.origin) {
    return t.origin === "human_chat" || t.origin === "human_stt";
  }
  // 後方互換: origin 未設定 → role で判定
  return t.role === "user";
}

/** ハイブリッド dedupe key: action_type + 最後の human transcript id */
function buildClientDedupeKey(
  actionType: string,
  lastHumanId: string | undefined,
): string {
  return `${actionType}_${lastHumanId || "unknown"}`;
}

// ----------------------------------------------------------------
// Hook
// ----------------------------------------------------------------

export function useProactiveMonitor({
  enabled,
  roomData,
  roomId,
  currentSessionId,
  thinkingQueue,
}: UseProactiveMonitorProps) {
  const [currentSuggestion, setCurrentSuggestion] =
    useState<ProactiveSuggestion | null>(null);

  // Refs for mutable state (avoid stale closures)
  const isCheckingRef = useRef(false);
  const lastProcessedIdRef = useRef<string | null>(null);
  const suggestedKeysRef = useRef<Map<string, number>>(new Map());
  const lastSuggestionTimeRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const thinkingQueueRef = useRef(thinkingQueue);
  const roomDataRef = useRef(roomData);
  const roomIdRef = useRef(roomId);
  const sessionIdRef = useRef(currentSessionId);

  // Keep refs in sync
  useEffect(() => {
    thinkingQueueRef.current = thinkingQueue;
  }, [thinkingQueue]);
  useEffect(() => {
    roomDataRef.current = roomData;
  }, [roomData]);
  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);
  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Reset on session change
  useEffect(() => {
    lastProcessedIdRef.current = null;
    suggestedKeysRef.current.clear();
    setCurrentSuggestion(null);
  }, [currentSessionId]);

  // Cleanup expired dedupe keys
  const cleanupExpiredKeys = useCallback(() => {
    const now = Date.now();
    const map = suggestedKeysRef.current;
    for (const [key, expiry] of map) {
      if (expiry < now) map.delete(key);
    }
  }, []);

  // Core check function
  const performCheck = useCallback(async () => {
    if (isCheckingRef.current) return;
    if (!roomDataRef.current || !roomIdRef.current) return;

    // Cooldown check
    const now = Date.now();
    if (now - lastSuggestionTimeRef.current < COOLDOWN_AFTER_SUGGESTION_MS) {
      return;
    }

    // Get human entries since last processed
    const allEntries = toTranscriptArray(roomDataRef.current.transcript);
    const humanEntries = allEntries.filter(isHumanEntry);

    if (humanEntries.length === 0) return;

    // Count new entries since watermark
    const lastId = lastProcessedIdRef.current;
    let newCount: number;
    if (!lastId) {
      newCount = humanEntries.length;
    } else {
      const lastIdx = humanEntries.findIndex((t) => t.id === lastId);
      newCount = lastIdx === -1 ? humanEntries.length : humanEntries.length - lastIdx - 1;
    }

    if (newCount < MIN_NEW_HUMAN_ENTRIES) return;

    // Update watermark
    const lastEntry = humanEntries[humanEntries.length - 1];
    lastProcessedIdRef.current = lastEntry.id || null;

    // Start check
    isCheckingRef.current = true;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // ThinkingQueue — silent (only show if takes > 700ms)
    const requestId = `proactive-${crypto.randomUUID()}`;
    let thinkingShown = false;
    const thinkingTimer = setTimeout(() => {
      thinkingShown = true;
      thinkingQueueRef.current?.addTask({
        id: requestId,
        label: "会話を分析中...",
      });
    }, THINKING_QUEUE_DELAY_MS);

    try {
      cleanupExpiredKeys();

      const context = buildBrainContext(roomDataRef.current, roomIdRef.current);
      const recentHuman = humanEntries.slice(-20).map((t) => ({
        speaker: t.userName || t.speakerLabel || t.userId,
        text: t.text,
        timestamp: t.timestamp,
      }));

      const suggestedKeys = Array.from(suggestedKeysRef.current.keys());

      const res = await authFetch("/api/proactive-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: roomIdRef.current,
          session_id: sessionIdRef.current,
          recent_transcript: recentHuman,
          meeting_context: context,
          already_suggested_keys: suggestedKeys,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.warn("[ProactiveMonitor] API error:", res.status);
        return;
      }

      const data = await res.json();

      if (
        data.intervene &&
        typeof data.confidence === "number" &&
        data.confidence >= CONFIDENCE_THRESHOLD
      ) {
        // Hybrid dedupe check
        const clientKey = buildClientDedupeKey(
          data.action_type || "",
          lastEntry.id,
        );
        const serverKey = data.dedupe_key || "";

        if (
          !suggestedKeysRef.current.has(clientKey) &&
          !suggestedKeysRef.current.has(serverKey)
        ) {
          const expiry = Date.now() + DEDUPE_EXPIRE_MS;
          suggestedKeysRef.current.set(clientKey, expiry);
          if (serverKey) suggestedKeysRef.current.set(serverKey, expiry);

          const suggestion: ProactiveSuggestion = {
            id: requestId,
            suggestion: data.suggestion || "",
            dedupeKey: clientKey,
            actionType: data.action_type || "",
            timestamp: Date.now(),
          };

          setCurrentSuggestion(suggestion);
          lastSuggestionTimeRef.current = Date.now();
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[ProactiveMonitor] check failed:", err);
      }
    } finally {
      clearTimeout(thinkingTimer);
      if (thinkingShown) {
        thinkingQueueRef.current?.updateTask(requestId, {
          status: "completed",
        });
      }
      isCheckingRef.current = false;
      abortControllerRef.current = null;
    }
  }, [cleanupExpiredKeys]);

  // Dismiss handler
  const dismissSuggestion = useCallback(() => {
    setCurrentSuggestion(null);
    lastSuggestionTimeRef.current = Date.now(); // trigger cooldown
  }, []);

  // Auto-dismiss timer
  useEffect(() => {
    if (!currentSuggestion) return;
    const timer = setTimeout(() => {
      setCurrentSuggestion(null);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [currentSuggestion]);

  // Main interval loop
  useEffect(() => {
    if (!enabled) {
      // Abort any in-flight request
      abortControllerRef.current?.abort();
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      timeoutId = setTimeout(async () => {
        await performCheck();
        scheduleNext();
      }, CHECK_INTERVAL_MS);
    };

    scheduleNext();

    return () => {
      clearTimeout(timeoutId);
      abortControllerRef.current?.abort();
    };
  }, [enabled, performCheck]);

  return { currentSuggestion, dismissSuggestion };
}

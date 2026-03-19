"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionData } from "../types/data";
import { authFetch } from "../lib/api-client";
import { buildMeetingContext, toTranscriptArray } from "../lib/meeting-context";
import type { ThinkingQueueCallbacks } from "./useBrain";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CHECK_INTERVAL_MS = 45_000; // 45 seconds
const COOLDOWN_AFTER_SUGGESTION_MS = 90_000; // 90 seconds after showing suggestion
const MIN_NEW_HUMAN_ENTRIES = 2; // minimum new human entries to trigger check
const CONFIDENCE_THRESHOLD = 0.7;
const DEDUPE_EXPIRE_MS = 10 * 60_000; // 10 minutes
const AUTO_DISMISS_MS = 30_000; // auto-dismiss suggestion after 30s
const THINKING_QUEUE_DELAY_MS = 700; // only show "analyzing" after 700ms

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ProactiveSuggestion {
  id: string;
  suggestion: string;
  dedupeKey: string;
  actionType: string;
  timestamp: number;
}

interface UseProactiveMonitorProps {
  enabled: boolean; // mode === "active" && connected
  roomData: SessionData | null;
  roomId: string | null;
  currentSessionId: string | null;
  thinkingQueue: ThinkingQueueCallbacks;
}

export interface UseProactiveMonitorReturn {
  currentSuggestion: ProactiveSuggestion | null;
  dismissSuggestion: () => void;
  isChecking: boolean;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useProactiveMonitor({
  enabled,
  roomData,
  roomId,
  currentSessionId,
  thinkingQueue,
}: UseProactiveMonitorProps): UseProactiveMonitorReturn {
  const [currentSuggestion, setCurrentSuggestion] =
    useState<ProactiveSuggestion | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  // Refs for state that shouldn't trigger re-renders
  const isCheckingRef = useRef(false);
  const lastCheckTimestampRef = useRef<string>(""); // watermark: last seen human transcript timestamp
  const suggestedKeysRef = useRef<Map<string, number>>(new Map()); // dedupe_key -> expiry timestamp
  const lastSuggestionTimeRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const thinkingQueueRef = useRef(thinkingQueue);
  thinkingQueueRef.current = thinkingQueue;
  const roomDataRef = useRef(roomData);
  roomDataRef.current = roomData;

  // Reset state when session changes
  useEffect(() => {
    lastCheckTimestampRef.current = "";
    suggestedKeysRef.current.clear();
    lastSuggestionTimeRef.current = 0;
    setCurrentSuggestion(null);
  }, [currentSessionId]);

  // Cleanup expired dedupe keys
  const cleanupExpiredKeys = useCallback(() => {
    const now = Date.now();
    for (const [key, expiry] of suggestedKeysRef.current) {
      if (now > expiry) {
        suggestedKeysRef.current.delete(key);
      }
    }
  }, []);

  // Dismiss suggestion
  const dismissSuggestion = useCallback(() => {
    setCurrentSuggestion(null);
    lastSuggestionTimeRef.current = Date.now();
  }, []);

  // Core check function
  const performCheck = useCallback(async () => {
    if (isCheckingRef.current) return; // in-flight guard
    if (!roomDataRef.current || !roomId) return;

    // Get human-only transcript entries
    const allTranscript = toTranscriptArray(roomDataRef.current.transcript);
    const humanEntries = allTranscript.filter((t) => t.role !== "ai" && t.userId !== "noa");

    // Check if enough new human entries since last check
    const watermark = lastCheckTimestampRef.current;
    const newHumanEntries = watermark
      ? humanEntries.filter((t) => t.timestamp && t.timestamp > watermark)
      : humanEntries;

    if (newHumanEntries.length < MIN_NEW_HUMAN_ENTRIES) return;

    // Check cooldown
    const now = Date.now();
    if (now - lastSuggestionTimeRef.current < COOLDOWN_AFTER_SUGGESTION_MS) return;

    // Update watermark
    const latestTimestamp = humanEntries
      .map((t) => t.timestamp || "")
      .filter(Boolean)
      .sort()
      .pop();
    if (latestTimestamp) {
      lastCheckTimestampRef.current = latestTimestamp;
    }

    // Cleanup expired dedupe keys
    cleanupExpiredKeys();

    // Start check
    isCheckingRef.current = true;
    setIsChecking(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // ThinkingQueue: show only if check takes > 700ms
    const taskId = `proactive-${Date.now()}`;
    const thinkingTimeout = setTimeout(() => {
      thinkingQueueRef.current?.addTask({
        id: taskId,
        label: "会話を分析中...",
      });
    }, THINKING_QUEUE_DELAY_MS);
    let thinkingTaskShown = false;

    try {
      const meetingContext = buildMeetingContext(roomDataRef.current, roomId);

      // Only send human entries for analysis
      const recentHuman = humanEntries.slice(-20).map((t) => ({
        speaker: t.userName || t.speakerLabel || t.userId,
        text: t.text,
        timestamp: t.timestamp,
      }));

      const res = await authFetch("/api/proactive-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          session_id: currentSessionId,
          recent_transcript: recentHuman,
          meeting_context: meetingContext,
          already_suggested_keys: Array.from(suggestedKeysRef.current.keys()),
        }),
        signal: abortController.signal,
      });

      // Check if thinkingQueue task was shown
      clearTimeout(thinkingTimeout);
      thinkingTaskShown = true;

      if (!res.ok) {
        console.warn("[ProactiveMonitor] API error:", res.status);
        return;
      }

      const data = await res.json();
      console.log("[ProactiveMonitor] Result:", {
        intervene: data.intervene,
        confidence: data.confidence,
        dedupeKey: data.dedupe_key,
        reason: data.reason,
      });

      if (
        data.intervene === true &&
        typeof data.confidence === "number" &&
        data.confidence >= CONFIDENCE_THRESHOLD &&
        data.dedupe_key &&
        !suggestedKeysRef.current.has(data.dedupe_key)
      ) {
        // Register dedupe key
        suggestedKeysRef.current.set(
          data.dedupe_key,
          Date.now() + DEDUPE_EXPIRE_MS
        );

        // Show suggestion
        const suggestion: ProactiveSuggestion = {
          id: `proactive-${Date.now()}`,
          suggestion: data.suggestion || "",
          dedupeKey: data.dedupe_key,
          actionType: data.action_type || "data_available",
          timestamp: Date.now(),
        };
        setCurrentSuggestion(suggestion);
        lastSuggestionTimeRef.current = Date.now();

        thinkingQueueRef.current?.updateTask(taskId, {
          label: "提案を表示",
          status: "completed",
        });
      } else {
        thinkingQueueRef.current?.updateTask(taskId, {
          status: "completed",
        });
      }
    } catch (err) {
      clearTimeout(thinkingTimeout);
      if ((err as Error).name !== "AbortError") {
        console.error("[ProactiveMonitor] Check failed:", err);
        thinkingQueueRef.current?.updateTask(taskId, {
          status: "error",
        });
      }
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
      abortControllerRef.current = null;
      if (!thinkingTaskShown) {
        clearTimeout(thinkingTimeout);
      }
    }
  }, [roomId, currentSessionId, cleanupExpiredKeys]);

  // Timer: setTimeout chain (not setInterval) for better cooldown control
  useEffect(() => {
    if (!enabled) {
      // Abort any in-flight request when disabled
      abortControllerRef.current?.abort();
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        performCheck().finally(scheduleNext);
      }, CHECK_INTERVAL_MS);
    };
    scheduleNext();

    return () => {
      clearTimeout(timeoutId);
      abortControllerRef.current?.abort();
    };
  }, [enabled, performCheck]);

  // Auto-dismiss suggestion after 30s
  useEffect(() => {
    if (!currentSuggestion) return;
    const timeoutId = setTimeout(() => {
      setCurrentSuggestion(null);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timeoutId);
  }, [currentSuggestion]);

  return {
    currentSuggestion,
    dismissSuggestion,
    isChecking,
  };
}

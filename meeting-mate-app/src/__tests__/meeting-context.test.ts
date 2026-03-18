import { describe, it, expect } from "vitest";
import {
  toTranscriptArray,
  toArray,
  buildBrainContext,
  buildLiveMeetingState,
  type SessionMeetingState,
} from "@/lib/meeting-context";
import type { SessionData, TranscriptEntry } from "@/types/data";

// ----------------------------------------------------------------
// toTranscriptArray
// ----------------------------------------------------------------
describe("toTranscriptArray", () => {
  it("配列をそのまま返す", () => {
    const arr = [{ userId: "u1", text: "hello", timestamp: "t1" }];
    expect(toTranscriptArray(arr)).toEqual(arr);
  });

  it("push-key Object を配列に変換する", () => {
    const obj = {
      "-abc": { userId: "u1", text: "a", timestamp: "t1" },
      "-def": { userId: "u2", text: "b", timestamp: "t2" },
    };
    const result = toTranscriptArray(obj);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.text)).toContain("a");
    expect(result.map((r) => r.text)).toContain("b");
  });

  it("null/undefined → 空配列", () => {
    expect(toTranscriptArray(null)).toEqual([]);
    expect(toTranscriptArray(undefined)).toEqual([]);
  });
});

// ----------------------------------------------------------------
// toArray
// ----------------------------------------------------------------
describe("toArray", () => {
  it("配列をそのまま返す", () => {
    expect(toArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("Object の values を配列に変換する", () => {
    const result = toArray({ a: 1, b: 2 });
    expect(result).toHaveLength(2);
    expect(result).toContain(1);
    expect(result).toContain(2);
  });
});

// ----------------------------------------------------------------
// buildBrainContext
// ----------------------------------------------------------------
describe("buildBrainContext", () => {
  it("null → 空オブジェクト", () => {
    expect(buildBrainContext(null)).toEqual({});
  });

  it("roomData から Brain 用コンテキストを構築する", () => {
    const roomData: SessionData = {
      participants: { uid1: { name: "Alice", role: "host" } },
      transcript: [
        { userId: "uid1", text: "hello", timestamp: "2026-01-01", role: "user" },
      ],
      tasks: [{ id: "1", title: "Task1", assignee: "Alice", status: "todo", priority: "high" }],
      notes: [{ type: "decision", text: "Note1" }],
    };
    const ctx = buildBrainContext(roomData, "room-1");
    expect(ctx.room_id).toBe("room-1");
    expect((ctx.participants as unknown[]).length).toBe(1);
    expect((ctx.recent_transcript as unknown[]).length).toBe(1);
    expect((ctx.tasks as unknown[]).length).toBe(1);
    expect((ctx.notes as unknown[]).length).toBe(1);
  });
});

// ----------------------------------------------------------------
// buildLiveMeetingState
// ----------------------------------------------------------------
describe("buildLiveMeetingState", () => {
  const makeState = (overrides?: Partial<SessionMeetingState>): SessionMeetingState => ({
    transcript: [
      { userId: "u1", userName: "Alice", text: "hi", timestamp: "t1", role: "user", origin: "human_chat" },
      { userId: "noa", userName: "Noa", text: "hello", timestamp: "t2", role: "ai", origin: "live_ai" },
      { userId: "u2", userName: "Bob", text: "test", timestamp: "t3", role: "user", origin: "human_stt" },
      { userId: "ai", userName: "AI", text: "summary", timestamp: "t4", role: "ai", origin: "agent_summary" },
    ] as TranscriptEntry[],
    tasks: [{ id: "1", title: "Task1", assignee: "Alice", status: "todo", priority: "high" }],
    notes: [{ type: "decision", text: "Note1" }],
    currentAgenda: { mainTopic: "Topic1", details: [{ text: "Detail1" }] },
    suggestedNextTopics: ["Next1"],
    participants: [{ id: "u1", name: "Alice", role: "host" }],
    ...overrides,
  });

  it("null → エラーメッセージ", () => {
    const result = buildLiveMeetingState(null, "all");
    expect(result).toHaveProperty("error");
  });

  it("category=tasks → タスク一覧のみ", () => {
    const result = buildLiveMeetingState(makeState(), "tasks");
    expect(result).toHaveProperty("tasks");
    expect(result).not.toHaveProperty("notes");
    expect((result.tasks as unknown[]).length).toBe(1);
  });

  it("category=agenda → 議題のみ", () => {
    const result = buildLiveMeetingState(makeState(), "agenda");
    expect(result).toHaveProperty("currentAgenda");
    expect(result).toHaveProperty("suggestedNextTopics");
  });

  it("category=notes → メモのみ", () => {
    const result = buildLiveMeetingState(makeState(), "notes");
    expect(result).toHaveProperty("notes");
    expect((result.notes as unknown[]).length).toBe(1);
  });

  it("category=recent_messages → human 起点のメッセージのみ", () => {
    const result = buildLiveMeetingState(makeState(), "recent_messages");
    const msgs = result.recent_messages as Array<{ origin: string }>;
    expect(msgs.length).toBe(2); // human_chat + human_stt のみ
    expect(msgs.every((m) => m.origin === "human_chat" || m.origin === "human_stt")).toBe(true);
  });

  it("category=all → すべて含む", () => {
    const result = buildLiveMeetingState(makeState(), "all");
    expect(result).toHaveProperty("tasks");
    expect(result).toHaveProperty("notes");
    expect(result).toHaveProperty("currentAgenda");
    expect(result).toHaveProperty("recent_messages");
  });

  it("後方互換: origin 未設定 + role=user → recent_messages に含まれる", () => {
    const state = makeState({
      transcript: [
        { userId: "u1", userName: "Alice", text: "old msg", timestamp: "t1", role: "user" } as TranscriptEntry,
      ],
    });
    const result = buildLiveMeetingState(state, "recent_messages");
    const msgs = result.recent_messages as unknown[];
    expect(msgs.length).toBe(1);
  });
});

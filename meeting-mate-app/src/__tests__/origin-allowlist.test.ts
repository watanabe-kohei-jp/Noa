import { describe, it, expect } from "vitest";

/**
 * origin allowlist トリガーロジックのテスト
 * server/main.py の is_triggerable() と同等のロジックを TypeScript で再実装してテスト
 */

const TRIGGERABLE_ORIGINS = new Set(["human_chat", "human_stt"]);

function isTriggerable(entry: Record<string, unknown>): boolean {
  const origin = entry.origin as string | undefined;
  if (origin) {
    return TRIGGERABLE_ORIGINS.has(origin);
  }
  // 後方互換: origin 未設定 → source/role から推定
  if (entry.role === "ai") return false;
  const source = entry.source as string | undefined;
  if (source === "stt" || source === "manual") return true;
  if (source === "live-api" && entry.role === "user") return true;
  return entry.role !== "ai";
}

describe("origin allowlist (is_triggerable)", () => {
  // origin が設定されている場合
  it("human_chat → triggerable", () => {
    expect(isTriggerable({ origin: "human_chat", role: "user" })).toBe(true);
  });

  it("human_stt → triggerable", () => {
    expect(isTriggerable({ origin: "human_stt", role: "user" })).toBe(true);
  });

  it("live_ai → NOT triggerable", () => {
    expect(isTriggerable({ origin: "live_ai", role: "ai" })).toBe(false);
  });

  it("agent_summary → NOT triggerable", () => {
    expect(isTriggerable({ origin: "agent_summary", role: "ai" })).toBe(false);
  });

  it("system → NOT triggerable", () => {
    expect(isTriggerable({ origin: "system", role: "ai" })).toBe(false);
  });

  // 後方互換: origin 未設定
  it("後方互換: source=stt, role=user → triggerable", () => {
    expect(isTriggerable({ source: "stt", role: "user" })).toBe(true);
  });

  it("後方互換: source=manual, role=user → triggerable", () => {
    expect(isTriggerable({ source: "manual", role: "user" })).toBe(true);
  });

  it("後方互換: source=live-api, role=user → triggerable", () => {
    expect(isTriggerable({ source: "live-api", role: "user" })).toBe(true);
  });

  it("後方互換: source=live-api, role=ai → NOT triggerable", () => {
    expect(isTriggerable({ source: "live-api", role: "ai" })).toBe(false);
  });

  it("後方互換: role=ai (source なし) → NOT triggerable", () => {
    expect(isTriggerable({ role: "ai" })).toBe(false);
  });

  it("後方互換: role=user (source なし) → triggerable", () => {
    expect(isTriggerable({ role: "user" })).toBe(true);
  });

  // フィードバックループ防止
  describe("フィードバックループ防止", () => {
    it("Agent summary はカウントされない → Agent が Agent を呼ばない", () => {
      const entries = [
        { origin: "human_chat", role: "user", text: "msg1" },
        { origin: "agent_summary", role: "ai", text: "summary" },
        { origin: "live_ai", role: "ai", text: "noa response" },
      ];
      const triggers = entries.filter(isTriggerable);
      expect(triggers.length).toBe(1); // human_chat のみ
    });

    it("Live AI 発話はカウントされない → AI-to-AI ループ不可", () => {
      const entries = [
        { origin: "live_ai", role: "ai", text: "resp1" },
        { origin: "live_ai", role: "ai", text: "resp2" },
        { origin: "live_ai", role: "ai", text: "resp3" },
      ];
      const triggers = entries.filter(isTriggerable);
      expect(triggers.length).toBe(0);
    });
  });
});

import { describe, it, expect } from "vitest";
import { isSafeCalendarUrl } from "@/lib/url-safety";

describe("isSafeCalendarUrl", () => {
  it("accepts https URLs", () => {
    expect(isSafeCalendarUrl("https://calendar.google.com/calendar/event?action=TEMPLATE")).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(isSafeCalendarUrl("http://example.com")).toBe(true);
  });

  it("accepts mailto URLs", () => {
    expect(isSafeCalendarUrl("mailto:a@b.com")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSafeCalendarUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isSafeCalendarUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects file: URLs", () => {
    expect(isSafeCalendarUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSafeCalendarUrl("")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isSafeCalendarUrl(undefined)).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(isSafeCalendarUrl("  https://x.com")).toBe(true);
  });

  it("is case-insensitive on scheme", () => {
    expect(isSafeCalendarUrl("HTTPS://example.com")).toBe(true);
    expect(isSafeCalendarUrl("JavaScript:void(0)")).toBe(false);
  });
});

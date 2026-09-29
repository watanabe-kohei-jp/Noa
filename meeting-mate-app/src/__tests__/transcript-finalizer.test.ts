import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionStatus } from "@google/genai";
import { createTranscriptFinalizer } from "@/lib/transcript-finalizer";

describe("createTranscriptFinalizer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("finalizes after one tick without status, including content emitted after turnComplete", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText(" Hello");
    finalizer.onTurnComplete();
    finalizer.appendText(" world. ");

    expect(onFinalize).not.toHaveBeenCalled();
    vi.advanceTimersToNextTimer();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(" Hello world. ");
  });

  it("waits for IDLE when IN_PROGRESS follows turnComplete", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText("Checking. ");
    finalizer.onTurnComplete();
    finalizer.onInteractionStatus(InteractionStatus.IN_PROGRESS);
    vi.advanceTimersToNextTimer();

    expect(onFinalize).not.toHaveBeenCalled();
    finalizer.appendText("Done.");
    finalizer.onInteractionStatus(InteractionStatus.IDLE);

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Checking. Done.");
  });

  it("finalizes immediately for the deprecated REQUIRES_ACTION status", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.onTurnComplete();
    finalizer.appendText("Ready.");
    finalizer.onInteractionStatus(InteractionStatus.REQUIRES_ACTION);

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Ready.");
    vi.runAllTimers();
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it.each([
    InteractionStatus.INTERACTION_STATUS_UNSPECIFIED,
    "FUTURE_STATUS" as InteractionStatus,
  ])("keeps the turnComplete fallback for %s", (status) => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText("Ready.");
    finalizer.onTurnComplete();
    finalizer.onInteractionStatus(status);

    expect(onFinalize).not.toHaveBeenCalled();
    vi.advanceTimersToNextTimer();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Ready.");
  });

  it("saves only once when IDLE is received twice", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.onTurnComplete();
    finalizer.appendText("Done.");
    finalizer.onInteractionStatus(InteractionStatus.IDLE);
    finalizer.onInteractionStatus(InteractionStatus.IDLE);
    vi.runAllTimers();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Done.");
  });

  it("flushes to the old callback on dispose before the tick without crossing sessions", () => {
    const saveOldSession = vi.fn();
    const oldFinalizer = createTranscriptFinalizer({ onFinalize: saveOldSession });
    oldFinalizer.appendText("Old session.");
    oldFinalizer.onTurnComplete();
    oldFinalizer.dispose();

    expect(saveOldSession).toHaveBeenCalledExactlyOnceWith("Old session.");

    const saveNewSession = vi.fn();
    const newFinalizer = createTranscriptFinalizer({ onFinalize: saveNewSession });
    newFinalizer.appendText("New session.");
    newFinalizer.onTurnComplete();
    vi.advanceTimersToNextTimer();

    expect(saveOldSession).toHaveBeenCalledTimes(1);
    expect(saveNewSession).toHaveBeenCalledExactlyOnceWith("New session.");
  });

  it("flushes immediately on dispose while waiting in IN_PROGRESS", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText("Still processing.");
    finalizer.onTurnComplete();
    finalizer.onInteractionStatus(InteractionStatus.IN_PROGRESS);
    vi.advanceTimersToNextTimer();

    expect(onFinalize).not.toHaveBeenCalled();
    finalizer.dispose();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Still processing.");
  });

  it("flushes accumulated text on dispose even without turnComplete", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText("Partial utterance.");
    finalizer.dispose();
    finalizer.dispose();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Partial utterance.");
  });

  it.each(["", " \n\t "])("never saves empty or whitespace text: %j", (text) => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText(text);
    finalizer.onTurnComplete();
    vi.advanceTimersToNextTimer();
    finalizer.appendText(text);
    finalizer.onInteractionStatus(InteractionStatus.IDLE);
    finalizer.appendText(text);
    finalizer.dispose();

    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("does not double-save if a pending callback still fires after dispose", () => {
    const onFinalize = vi.fn();
    const cancel = vi.fn();
    const schedule = vi.fn((fn: () => void) => setTimeout(fn, 0));
    const finalizer = createTranscriptFinalizer({ onFinalize, schedule, cancel });
    finalizer.appendText("Done.");
    finalizer.onTurnComplete();
    finalizer.dispose();

    expect(onFinalize).toHaveBeenCalledExactlyOnceWith("Done.");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(schedule.mock.results[0].value);
    // This injected cancel leaves the timer running to simulate a late callback.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending turnComplete timer and clears text between utterances", () => {
    const onFinalize = vi.fn();
    const finalizer = createTranscriptFinalizer({ onFinalize });
    finalizer.appendText("First.");
    finalizer.onTurnComplete();
    finalizer.onTurnComplete();

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    finalizer.appendText("Second.");
    finalizer.onTurnComplete();
    vi.advanceTimersToNextTimer();

    expect(onFinalize).toHaveBeenCalledTimes(2);
    expect(onFinalize).toHaveBeenNthCalledWith(1, "First.");
    expect(onFinalize).toHaveBeenNthCalledWith(2, "Second.");
  });
});

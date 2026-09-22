import { describe, expect, it, vi } from "vitest";
import { InteractionStatus, LiveServerMessage } from "@google/genai";
import type { LiveServerContent } from "@google/genai";
import { GenAILiveClient } from "@/lib/genai-live-client";

class TestLiveClient extends GenAILiveClient {
  receive(serverContent: LiveServerContent) {
    const message = new LiveServerMessage();
    message.serverContent = serverContent;
    return this.onmessage(message);
  }
}

describe("GenAILiveClient interaction status", () => {
  it.each(Object.values(InteractionStatus))(
    "emits %s alongside the existing turncomplete event",
    async (interactionStatus) => {
      const client = new TestLiveClient({ apiKey: "test-key" });
      const onStatus = vi.fn();
      const onTurnComplete = vi.fn();
      client.on("interactionstatus", onStatus);
      client.on("turncomplete", onTurnComplete);

      await client.receive({ turnComplete: true, interactionStatus });

      expect(onStatus).toHaveBeenCalledExactlyOnceWith(interactionStatus);
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
    }
  );

  it("does not infer idle from a legacy turn without interactionStatus", async () => {
    const client = new TestLiveClient({ apiKey: "test-key" });
    const onStatus = vi.fn();
    const onTurnComplete = vi.fn();
    client.on("interactionstatus", onStatus);
    client.on("turncomplete", onTurnComplete);

    await client.receive({ turnComplete: true });

    expect(onStatus).not.toHaveBeenCalled();
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it("preserves transcription and audio when status accompanies content", async () => {
    const client = new TestLiveClient({ apiKey: "test-key" });
    const onStatus = vi.fn();
    const onContent = vi.fn();
    const onAudio = vi.fn();
    client.on("interactionstatus", onStatus);
    client.on("content", onContent);
    client.on("audio", onAudio);

    await client.receive({
      turnComplete: true,
      interactionStatus: InteractionStatus.IN_PROGRESS,
      outputTranscription: { text: "Checking that now." },
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }],
      },
    });

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(InteractionStatus.IN_PROGRESS);
    expect(onContent).toHaveBeenCalledExactlyOnceWith({
      modelTurn: { parts: [{ text: "Checking that now." }] },
    });
    expect(onAudio).toHaveBeenCalledExactlyOnceWith(new Uint8Array([0, 0]).buffer);
    expect(onContent.mock.invocationCallOrder[0]).toBeLessThan(onStatus.mock.invocationCallOrder[0]);
    expect(onAudio.mock.invocationCallOrder[0]).toBeLessThan(onStatus.mock.invocationCallOrder[0]);
  });

  it("delivers final transcription and model text before reporting IDLE", async () => {
    const client = new TestLiveClient({ apiKey: "test-key" });
    const onContent = vi.fn();
    const onStatus = vi.fn();
    client.on("content", onContent);
    client.on("interactionstatus", onStatus);

    await client.receive({
      turnComplete: true,
      interactionStatus: InteractionStatus.IDLE,
      outputTranscription: { text: "The result is ready." },
      modelTurn: { parts: [{ text: "Final details." }] },
    });

    expect(onContent).toHaveBeenCalledTimes(2);
    expect(onContent).toHaveBeenNthCalledWith(1, {
      modelTurn: { parts: [{ text: "The result is ready." }] },
    });
    expect(onContent).toHaveBeenNthCalledWith(2, {
      modelTurn: { parts: [{ text: "Final details." }] },
    });
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(InteractionStatus.IDLE);
    expect(onContent.mock.invocationCallOrder[1]).toBeLessThan(onStatus.mock.invocationCallOrder[0]);
  });

  it("forwards standalone status updates without inventing a spoken turn completion", async () => {
    const client = new TestLiveClient({ apiKey: "test-key" });
    const onStatus = vi.fn();
    const onTurnComplete = vi.fn();
    client.on("interactionstatus", onStatus);
    client.on("turncomplete", onTurnComplete);

    await client.receive({ interactionStatus: InteractionStatus.IDLE });

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(InteractionStatus.IDLE);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("does not drop status when interrupted content returns early", async () => {
    const client = new TestLiveClient({ apiKey: "test-key" });
    const onStatus = vi.fn();
    const onInterrupted = vi.fn();
    client.on("interactionstatus", onStatus);
    client.on("interrupted", onInterrupted);

    await client.receive({ interrupted: true, interactionStatus: InteractionStatus.IDLE });

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(InteractionStatus.IDLE);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
  });
});

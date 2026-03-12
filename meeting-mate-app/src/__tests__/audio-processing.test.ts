/**
 * VAD logic unit tests for audio-processing.ts worklet
 *
 * The VAD logic lives inside a template string that runs in AudioWorklet scope.
 * We eval it in Node.js by shimming AudioWorkletProcessor and the port interface.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import AudioRecordingWorklet from "../lib/worklets/audio-processing";

// ---- Helpers to build a testable worklet instance ----

interface WorkletInstance {
  buffer: Int16Array;
  bufferWriteIndex: number;
  vadEnabled: boolean;
  vadState: number;
  thresholdHigh: number;
  thresholdLow: number;
  speechConfirmFrames: number;
  holdFrames: number;
  postFrames: number;
  preBufferFrames: number;
  speechConfirmCount: number;
  holdCounter: number;
  postCounter: number;
  preBuffer: Float32Array;
  preWriteIndex: number;
  preFrameCount: number;
  port: {
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: ((e: { data: Record<string, unknown> }) => void) | null;
  };
  process: (inputs: Float32Array[][]) => boolean;
  vadProcess: (float32Array: Float32Array) => void;
  processChunk: (float32Array: Float32Array) => void;
  sendAndClearBuffer: () => void;
  preBufferWrite: (float32Array: Float32Array) => void;
  flushPreBuffer: () => void;
}

function createWorkletInstance(): WorkletInstance {
  const postMessage = vi.fn();

  // Shim AudioWorkletProcessor
  const shim = `
    class AudioWorkletProcessor {
      constructor() {
        this.port = { postMessage: __postMessage__, onmessage: null };
      }
    }
  `;

  // Build a factory that returns an instance
  const factory = new Function(
    "__postMessage__",
    `
    ${shim}
    ${AudioRecordingWorklet}
    return new AudioProcessingWorklet();
    `
  );

  const instance = factory(postMessage) as WorkletInstance;
  return instance;
}

/** Create a Float32Array frame filled with a constant value */
function makeFrame(value: number, length = 128): Float32Array {
  const frame = new Float32Array(length);
  frame.fill(value);
  return frame;
}

/**
 * Create a Float32Array frame whose RMS equals the target RMS.
 * For a constant-value signal, RMS = |value|, so value = targetRms.
 */
function makeFrameWithRms(targetRms: number, length = 128): Float32Array {
  return makeFrame(targetRms, length);
}

// ---- Tests ----

describe("AudioProcessingWorklet - VAD logic", () => {
  let worklet: WorkletInstance;

  beforeEach(() => {
    worklet = createWorkletInstance();
  });

  // ==============================
  // VAD disabled (pass-through)
  // ==============================
  describe("VAD disabled (pass-through)", () => {
    it("should pass all frames through processChunk when vadEnabled is false", () => {
      const spy = vi.fn();
      worklet.processChunk = spy;
      worklet.vadEnabled = false;

      const frame = makeFrame(0.5);
      worklet.process([[frame]]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(frame);
    });

    it("should pass silent frames through when vadEnabled is false", () => {
      const spy = vi.fn();
      worklet.processChunk = spy;
      worklet.vadEnabled = false;

      const silentFrame = makeFrame(0);
      worklet.process([[silentFrame]]);

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ==============================
  // SILENCE state
  // ==============================
  describe("SILENCE state", () => {
    it("should NOT call processChunk for silent frames when VAD is enabled", () => {
      const spy = vi.fn();
      worklet.processChunk = spy;
      worklet.vadEnabled = true;
      worklet.vadState = 0; // SILENCE

      const silentFrame = makeFrame(0);
      worklet.process([[silentFrame]]);

      // processChunk should NOT be called (audio is gated)
      expect(spy).not.toHaveBeenCalled();
    });

    it("should write silent frames to pre-buffer", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;

      const preBufferWriteSpy = vi.fn();
      worklet.preBufferWrite = preBufferWriteSpy;

      const frame = makeFrame(0);
      worklet.vadProcess(frame);

      expect(preBufferWriteSpy).toHaveBeenCalledWith(frame);
    });

    it("should reset speechConfirmCount when RMS drops below thresholdHigh", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;

      // One frame above threshold
      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);
      expect(worklet.speechConfirmCount).toBe(1);

      // One frame below threshold -> reset
      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);
      expect(worklet.speechConfirmCount).toBe(0);
    });
  });

  // ==============================
  // SILENCE -> SPEAKING transition
  // ==============================
  describe("SILENCE -> SPEAKING transition", () => {
    it("should transition after speechConfirmFrames consecutive loud frames", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.speechConfirmFrames = 3;

      const processChunkSpy = vi.fn();
      worklet.processChunk = processChunkSpy;

      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);

      // Frame 1, 2: still SILENCE
      worklet.vadProcess(loudFrame);
      expect(worklet.vadState).toBe(0);
      worklet.vadProcess(loudFrame);
      expect(worklet.vadState).toBe(0);

      // Frame 3: transition to SPEAKING
      worklet.vadProcess(loudFrame);
      expect(worklet.vadState).toBe(1);
    });

    it("should post 'speaking: true' event on transition", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.speechConfirmFrames = 1; // quick transition

      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);

      expect(worklet.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ event: "vad", speaking: true })
      );
    });

    it("should call processChunk for the triggering frame", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.speechConfirmFrames = 1;

      const processChunkSpy = vi.fn();
      worklet.processChunk = processChunkSpy;

      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);

      // processChunk should have been called (for pre-buffer flush + triggering frame)
      expect(processChunkSpy).toHaveBeenCalled();
    });
  });

  // ==============================
  // Pre-buffer flush
  // ==============================
  describe("Pre-buffer flush", () => {
    it("should flush pre-buffered frames in correct order on SILENCE->SPEAKING", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.speechConfirmFrames = 1;
      worklet.preBufferFrames = 3;
      // Re-initialize pre-buffer to match the new preBufferFrames
      worklet.preBuffer = new Float32Array(3 * 128);
      worklet.preWriteIndex = 0;
      worklet.preFrameCount = 0;

      const processChunkCalls: Float32Array[] = [];
      worklet.processChunk = vi.fn((frame: Float32Array) => {
        // Store a copy since subarray may be a view
        processChunkCalls.push(new Float32Array(frame));
      });

      // Write 3 silent frames to pre-buffer (values 0.001, 0.002, 0.003)
      const f1 = makeFrame(0.001);
      const f2 = makeFrame(0.002);
      const f3 = makeFrame(0.003);

      // These are below threshold, so they go to pre-buffer only
      worklet.speechConfirmFrames = 999; // prevent transition
      worklet.vadProcess(f1);
      worklet.vadProcess(f2);
      worklet.vadProcess(f3);

      expect(worklet.preFrameCount).toBe(3);
      expect(worklet.processChunk).not.toHaveBeenCalled();

      // Now trigger transition
      worklet.speechConfirmFrames = 1;
      worklet.speechConfirmCount = 0;
      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);

      // vadProcess first calls preBufferWrite(loudFrame) which overwrites slot 0 (f1),
      // then flushPreBuffer() flushes from startIdx=preWriteIndex=1: [f2, f3, loudFrame].
      // No duplicate processChunk — trigger frame is already in the ring buffer.
      expect(processChunkCalls.length).toBe(3);

      // f1 is overwritten by loudFrame in the ring buffer (slot 0)
      // Flush order starts at preWriteIndex=1: slot1(f2), slot2(f3), slot0(loudFrame)
      expect(processChunkCalls[0][0]).toBeCloseTo(0.002, 5);
      expect(processChunkCalls[1][0]).toBeCloseTo(0.003, 5);
      expect(processChunkCalls[2][0]).toBeCloseTo(worklet.thresholdHigh + 0.01, 5);
    });

    it("should flush ring buffer in correct order when wrapped around", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.preBufferFrames = 2;
      worklet.preBuffer = new Float32Array(2 * 128);
      worklet.preWriteIndex = 0;
      worklet.preFrameCount = 0;

      const processChunkCalls: Float32Array[] = [];
      worklet.processChunk = vi.fn((frame: Float32Array) => {
        processChunkCalls.push(new Float32Array(frame));
      });

      // Write 3 frames (buffer size is 2, so f1 gets overwritten)
      worklet.speechConfirmFrames = 999;
      worklet.vadProcess(makeFrame(0.001)); // slot 0, preWriteIndex->1
      worklet.vadProcess(makeFrame(0.002)); // slot 1, preWriteIndex->0
      worklet.vadProcess(makeFrame(0.003)); // slot 0 (overwrites 0.001), preWriteIndex->1

      expect(worklet.preFrameCount).toBe(2); // capped at preBufferFrames
      expect(worklet.preWriteIndex).toBe(1); // next write slot

      // Trigger transition
      worklet.speechConfirmFrames = 1;
      worklet.speechConfirmCount = 0;
      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);

      // vadProcess first writes loudFrame to preBuffer slot 1 (overwriting f2), preWriteIndex->0
      // flushPreBuffer: startIdx=preWriteIndex=0, flush order: slot0(f3), slot1(loudFrame)
      // Trigger frame is already in the ring buffer, so no extra processChunk call
      // Total: 2 calls: f3, loudFrame (from flush)
      expect(processChunkCalls.length).toBe(2);
      expect(processChunkCalls[0][0]).toBeCloseTo(0.003, 5);
      expect(processChunkCalls[1][0]).toBeCloseTo(worklet.thresholdHigh + 0.01, 5);
    });
  });

  // ==============================
  // SPEAKING -> POST_SPEECH transition
  // ==============================
  describe("SPEAKING -> POST_SPEECH transition", () => {
    it("should transition after holdFrames consecutive quiet frames", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 1; // SPEAKING
      worklet.holdFrames = 3;
      worklet.holdCounter = 0;

      const quietFrame = makeFrame(0); // RMS = 0, below thresholdLow

      worklet.vadProcess(quietFrame);
      expect(worklet.vadState).toBe(1);
      expect(worklet.holdCounter).toBe(1);

      worklet.vadProcess(quietFrame);
      expect(worklet.vadState).toBe(1);
      expect(worklet.holdCounter).toBe(2);

      worklet.vadProcess(quietFrame);
      expect(worklet.vadState).toBe(2); // POST_SPEECH
      expect(worklet.postCounter).toBe(worklet.postFrames);
    });

    it("should reset holdCounter when loud frame arrives", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 1;
      worklet.holdFrames = 5;

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);
      worklet.vadProcess(quietFrame);
      expect(worklet.holdCounter).toBe(2);

      // Loud frame resets counter (above thresholdLow)
      const loudFrame = makeFrameWithRms(worklet.thresholdLow + 0.01);
      worklet.vadProcess(loudFrame);
      expect(worklet.holdCounter).toBe(0);
    });

    it("should still call processChunk during SPEAKING state", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 1;

      const spy = vi.fn();
      worklet.processChunk = spy;

      const frame = makeFrame(0.5);
      worklet.vadProcess(frame);

      expect(spy).toHaveBeenCalledWith(frame);
    });
  });

  // ==============================
  // POST_SPEECH -> SILENCE transition
  // ==============================
  describe("POST_SPEECH -> SILENCE transition", () => {
    it("should transition when postCounter reaches 0", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2; // POST_SPEECH
      worklet.postCounter = 2;

      const quietFrame = makeFrame(0);

      worklet.vadProcess(quietFrame);
      expect(worklet.vadState).toBe(2);
      expect(worklet.postCounter).toBe(1);

      worklet.vadProcess(quietFrame);
      expect(worklet.vadState).toBe(0); // SILENCE
    });

    it("should post 'speaking: false' event on transition to SILENCE", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 1;

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);

      expect(worklet.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ event: "vad", speaking: false })
      );
    });

    it("should reset speechConfirmCount and pre-buffer on transition to SILENCE", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 1;
      worklet.speechConfirmCount = 5; // leftover
      worklet.preWriteIndex = 10;
      worklet.preFrameCount = 10;

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);

      expect(worklet.speechConfirmCount).toBe(0);
      expect(worklet.preWriteIndex).toBe(0);
      expect(worklet.preFrameCount).toBe(0);
    });

    it("should clear partial chunk buffer (bufferWriteIndex) on transition to SILENCE", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 1;
      worklet.bufferWriteIndex = 500; // partial data

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);

      expect(worklet.bufferWriteIndex).toBe(0);
    });
  });

  // ==============================
  // POST_SPEECH -> SPEAKING recovery
  // ==============================
  describe("POST_SPEECH -> SPEAKING recovery", () => {
    it("should return to SPEAKING if loud frame arrives during POST_SPEECH", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 10;

      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);
      worklet.vadProcess(loudFrame);

      expect(worklet.vadState).toBe(1); // SPEAKING
      expect(worklet.holdCounter).toBe(0);
    });

    it("should still call processChunk during POST_SPEECH", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 10;

      const spy = vi.fn();
      worklet.processChunk = spy;

      const frame = makeFrame(0.01);
      worklet.vadProcess(frame);

      expect(spy).toHaveBeenCalledWith(frame);
    });
  });

  // ==============================
  // int16 clamp
  // ==============================
  describe("int16 clamp in processChunk", () => {
    it("should clamp values above 1.0 to 32767", () => {
      worklet.vadEnabled = false;

      // Frame with value > 1.0
      const frame = makeFrame(1.5);
      worklet.process([[frame]]);

      // Check clamped values in the buffer
      // 1.5 * 32768 = 49152, should be clamped to 32767
      for (let i = 0; i < frame.length; i++) {
        expect(worklet.buffer[i]).toBe(32767);
      }
    });

    it("should clamp values below -1.0 to -32768", () => {
      worklet.vadEnabled = false;

      const frame = makeFrame(-1.5);
      worklet.process([[frame]]);

      for (let i = 0; i < frame.length; i++) {
        expect(worklet.buffer[i]).toBe(-32768);
      }
    });

    it("should correctly convert normal values without clamping", () => {
      worklet.vadEnabled = false;

      const frame = makeFrame(0.5);
      worklet.process([[frame]]);

      // 0.5 * 32768 = 16384
      for (let i = 0; i < frame.length; i++) {
        expect(worklet.buffer[i]).toBe(16384);
      }
    });
  });

  // ==============================
  // VAD events
  // ==============================
  describe("VAD events", () => {
    it("should post speaking:true exactly once on SILENCE->SPEAKING", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 0;
      worklet.speechConfirmFrames = 2;

      const loudFrame = makeFrameWithRms(worklet.thresholdHigh + 0.01);

      worklet.vadProcess(loudFrame); // confirm 1
      worklet.vadProcess(loudFrame); // confirm 2 -> transition

      const vadMessages = worklet.port.postMessage.mock.calls.filter(
        (call) => call[0]?.event === "vad"
      );
      expect(vadMessages).toHaveLength(1);
      expect(vadMessages[0][0]).toEqual({ event: "vad", speaking: true });
    });

    it("should post speaking:false exactly once on POST_SPEECH->SILENCE", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 2;
      worklet.postCounter = 1;

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);

      const vadMessages = worklet.port.postMessage.mock.calls.filter(
        (call) => call[0]?.event === "vad"
      );
      expect(vadMessages).toHaveLength(1);
      expect(vadMessages[0][0]).toEqual({ event: "vad", speaking: false });
    });

    it("should NOT post vad events during SPEAKING->POST_SPEECH transition", () => {
      worklet.vadEnabled = true;
      worklet.vadState = 1;
      worklet.holdFrames = 1;

      const quietFrame = makeFrame(0);
      worklet.vadProcess(quietFrame);

      expect(worklet.vadState).toBe(2); // POST_SPEECH

      const vadMessages = worklet.port.postMessage.mock.calls.filter(
        (call) => call[0]?.event === "vad"
      );
      expect(vadMessages).toHaveLength(0);
    });
  });

  // ==============================
  // process() return value
  // ==============================
  describe("process() return value", () => {
    it("should always return true (keep processor alive)", () => {
      expect(worklet.process([[makeFrame(0)]])).toBe(true);
      expect(worklet.process([[]])).toBe(true);
      expect(worklet.process([[makeFrame(0.5)]])).toBe(true);
    });
  });

  // ==============================
  // port.onmessage configuration
  // ==============================
  describe("port.onmessage configuration", () => {
    it("should update vadEnabled via port message", () => {
      expect(worklet.vadEnabled).toBe(false);
      worklet.port.onmessage!({ data: { vadEnabled: true } });
      expect(worklet.vadEnabled).toBe(true);
      worklet.port.onmessage!({ data: { vadEnabled: false } });
      expect(worklet.vadEnabled).toBe(false);
    });

    it("should update thresholds via port message", () => {
      worklet.port.onmessage!({ data: { thresholdHigh: 0.05, thresholdLow: 0.02 } });
      expect(worklet.thresholdHigh).toBe(0.05);
      expect(worklet.thresholdLow).toBe(0.02);
    });
  });

  // ==============================
  // sendAndClearBuffer
  // ==============================
  describe("sendAndClearBuffer", () => {
    it("should post chunk event with int16arrayBuffer", () => {
      worklet.bufferWriteIndex = 10;
      worklet.sendAndClearBuffer();

      expect(worklet.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "chunk",
          data: expect.objectContaining({
            int16arrayBuffer: expect.any(ArrayBuffer),
          }),
        })
      );
    });

    it("should reset bufferWriteIndex after sending", () => {
      worklet.bufferWriteIndex = 100;
      worklet.sendAndClearBuffer();
      expect(worklet.bufferWriteIndex).toBe(0);
    });
  });
});

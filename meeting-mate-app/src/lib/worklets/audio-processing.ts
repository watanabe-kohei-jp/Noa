const AudioRecordingWorklet = `
class AudioProcessingWorklet extends AudioWorkletProcessor {
  buffer = new Int16Array(2048);
  bufferWriteIndex = 0;

  constructor() {
    super();
    this.hasAudio = false;

    // --- VAD state ---
    this.vadEnabled = false;
    this.vadState = 0; // 0=SILENCE, 1=SPEAKING, 2=POST_SPEECH

    // Thresholds (configurable via port.postMessage)
    this.thresholdHigh = 0.015;
    this.thresholdLow = 0.008;

    // Frame counts (default for 16kHz / 128 samples per frame = 8ms per frame)
    this.speechConfirmFrames = 3;   // ~24ms
    this.holdFrames = 50;           // ~400ms
    this.postFrames = 25;           // ~200ms
    this.preBufferFrames = 25;      // ~200ms

    // Counters
    this.speechConfirmCount = 0;
    this.holdCounter = 0;
    this.postCounter = 0;

    // Pre-buffer: fixed-size ring buffer (preBufferFrames * 128 Float32 samples)
    this.preBuffer = new Float32Array(this.preBufferFrames * 128);
    this.preWriteIndex = 0;
    this.preFrameCount = 0;

    // Listen for config messages from main thread
    this.port.onmessage = (e) => {
      if (e.data.vadEnabled !== undefined) this.vadEnabled = !!e.data.vadEnabled;
      if (e.data.thresholdHigh !== undefined) this.thresholdHigh = e.data.thresholdHigh;
      if (e.data.thresholdLow !== undefined) this.thresholdLow = e.data.thresholdLow;
    };
  }

  process(inputs) {
    if (inputs[0].length) {
      const channel0 = inputs[0][0];

      if (!this.vadEnabled) {
        // VAD disabled: pass-through (original behavior)
        this.processChunk(channel0);
      } else {
        this.vadProcess(channel0);
      }
    }
    return true;
  }

  vadProcess(float32Array) {
    // Calculate RMS
    const len = float32Array.length;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += float32Array[i] * float32Array[i];
    }
    const rms = Math.sqrt(sum / len);

    switch (this.vadState) {
      case 0: // SILENCE
        this.preBufferWrite(float32Array);

        if (rms > this.thresholdHigh) {
          this.speechConfirmCount++;
          if (this.speechConfirmCount >= this.speechConfirmFrames) {
            // Transition: SILENCE → SPEAKING
            this.flushPreBuffer();
            this.vadState = 1;
            this.holdCounter = 0;
            this.port.postMessage({ event: "vad", speaking: true });
            this.processChunk(float32Array);
          }
        } else {
          this.speechConfirmCount = 0;
        }
        break;

      case 1: // SPEAKING
        this.processChunk(float32Array);

        if (rms < this.thresholdLow) {
          this.holdCounter++;
          if (this.holdCounter >= this.holdFrames) {
            // Transition: SPEAKING → POST_SPEECH
            this.vadState = 2;
            this.postCounter = this.postFrames;
          }
        } else {
          this.holdCounter = 0;
        }
        break;

      case 2: // POST_SPEECH
        this.processChunk(float32Array);
        this.postCounter--;

        if (rms > this.thresholdHigh) {
          // Speech resumed → back to SPEAKING
          this.vadState = 1;
          this.holdCounter = 0;
        } else if (this.postCounter <= 0) {
          // Transition: POST_SPEECH → SILENCE
          this.vadState = 0;
          this.speechConfirmCount = 0;
          this.preWriteIndex = 0;
          this.preFrameCount = 0;
          this.bufferWriteIndex = 0; // Clear partial chunk
          this.port.postMessage({ event: "vad", speaking: false });
        }
        break;
    }
  }

  preBufferWrite(float32Array) {
    // Write frame into fixed-size ring buffer (no allocation)
    const frameSize = float32Array.length;
    const offset = this.preWriteIndex * frameSize;

    for (let i = 0; i < frameSize; i++) {
      this.preBuffer[offset + i] = float32Array[i];
    }

    this.preWriteIndex = (this.preWriteIndex + 1) % this.preBufferFrames;
    if (this.preFrameCount < this.preBufferFrames) {
      this.preFrameCount++;
    }
  }

  flushPreBuffer() {
    // Flush ring buffer in correct order via subarray (no copy)
    const frameSize = 128;
    if (this.preFrameCount === 0) return;

    const startIdx = this.preFrameCount < this.preBufferFrames
      ? 0
      : this.preWriteIndex;

    for (let i = 0; i < this.preFrameCount; i++) {
      const idx = (startIdx + i) % this.preBufferFrames;
      const offset = idx * frameSize;
      this.processChunk(this.preBuffer.subarray(offset, offset + frameSize));
    }

    this.preWriteIndex = 0;
    this.preFrameCount = 0;
  }

  sendAndClearBuffer(){
    this.port.postMessage({
      event: "chunk",
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
      },
    });
    this.bufferWriteIndex = 0;
  }

  processChunk(float32Array) {
    const l = float32Array.length;
    for (let i = 0; i < l; i++) {
      const s = float32Array[i] * 32768;
      this.buffer[this.bufferWriteIndex++] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      if(this.bufferWriteIndex >= this.buffer.length) {
        this.sendAndClearBuffer();
      }
    }
    if(this.bufferWriteIndex >= this.buffer.length) {
      this.sendAndClearBuffer();
    }
  }
}
`;

export default AudioRecordingWorklet;

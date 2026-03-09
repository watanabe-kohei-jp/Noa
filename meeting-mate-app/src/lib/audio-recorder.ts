// Audio input recorder - Microphone → PCM16 base64
import { audioContext } from "./audio-utils";
import AudioRecordingWorklet from "./worklets/audio-processing";
import VolMeterWorklet from "./worklets/vol-meter";
import { createWorketFromSrc } from "./audioworklet-registry";
import { EventEmitter } from "eventemitter3";

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export class AudioRecorder extends EventEmitter {
  stream: MediaStream | undefined;
  audioContext: AudioContext | undefined;
  source: MediaStreamAudioSourceNode | undefined;
  recording: boolean = false;
  recordingWorklet: AudioWorkletNode | undefined;
  vuWorklet: AudioWorkletNode | undefined;

  /** true = stream は外部から渡されたので stop() 時に track を止めない */
  private externalStream = false;
  private starting: Promise<void> | null = null;
  private workletRegistered = false;
  private lastAudioContext: AudioContext | null = null;

  constructor(public sampleRate = 16000) {
    super();
  }

  /**
   * @param externalStream 外部の共有 MediaStream を渡すと getUserMedia() を呼ばない
   */
  async start(externalStream?: MediaStream) {
    // 多重起動ガード
    if (this.recording || this.starting) return;

    if (!externalStream && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
      throw new Error("Could not request user media");
    }

    this.starting = (async () => {
      try {
        if (externalStream) {
          this.stream = externalStream;
          this.externalStream = true;
        } else {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.externalStream = false;
        }

        // AudioContext をキャッシュして再利用（Chrome の上限回避）
        if (!this.audioContext || this.audioContext.state === "closed") {
          this.audioContext = await audioContext({ sampleRate: this.sampleRate, id: "audio-recorder" });
        }
        if (this.audioContext.state === "suspended") {
          await this.audioContext.resume();
        }

        // AudioContext が変わったら worklet 登録フラグをリセット
        if (this.lastAudioContext !== this.audioContext) {
          this.workletRegistered = false;
          this.lastAudioContext = this.audioContext;
        }

        this.source = this.audioContext.createMediaStreamSource(this.stream);

        const workletName = "audio-recorder-worklet";

        // Worklet 未登録の場合のみ addModule
        if (!this.workletRegistered) {
          const src = createWorketFromSrc(workletName, AudioRecordingWorklet);
          await this.audioContext.audioWorklet.addModule(src);

          const vuWorkletName = "vu-meter";
          await this.audioContext.audioWorklet.addModule(
            createWorketFromSrc(vuWorkletName, VolMeterWorklet),
          );
          this.workletRegistered = true;
        }

        this.recordingWorklet = new AudioWorkletNode(
          this.audioContext,
          workletName,
        );

        this.recordingWorklet.port.onmessage = async (ev: MessageEvent) => {
          const arrayBuffer = ev.data.data.int16arrayBuffer;
          if (arrayBuffer) {
            const arrayBufferString = arrayBufferToBase64(arrayBuffer);
            this.emit("data", arrayBufferString);
          }
        };
        this.source.connect(this.recordingWorklet);

        this.vuWorklet = new AudioWorkletNode(this.audioContext, "vu-meter");
        this.vuWorklet.port.onmessage = (ev: MessageEvent) => {
          this.emit("volume", ev.data.volume);
        };

        this.source.connect(this.vuWorklet);
        this.recording = true;
      } catch (err) {
        // 失敗時: 自前取得の stream track を停止してリーク防止
        if (!this.externalStream) {
          this.stream?.getTracks().forEach((track) => track.stop());
        }
        this.stream = undefined;
        this.source = undefined;
        throw err;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  stop() {
    const handleStop = () => {
      this.recording = false;
      this.source?.disconnect();
      // 外部 stream の場合は track を止めない（共有元が管理する）
      if (!this.externalStream) {
        this.stream?.getTracks().forEach((track) => track.stop());
      }
      this.stream = undefined;
      this.recordingWorklet = undefined;
      this.vuWorklet = undefined;
      this.externalStream = false;
    };
    if (this.starting) {
      this.starting.then(handleStop, handleStop);
      return;
    }
    handleStop();
  }
}

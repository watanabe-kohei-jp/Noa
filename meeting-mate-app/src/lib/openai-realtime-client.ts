// OpenAI Realtime API client — WebRTC 主経路 (Issue #180)
//
// GenAILiveClient (genai-live-client.ts) の代替。ブラウザ WebRTC で OpenAI Realtime に接続する。
// 音声は WebRTC track で送受信 (Opus)。出力は <audio> 要素で自動再生するため、Gemini 経路の
// AudioStreamer/AudioRecorder/worklet は使わない (16kHz 資産は Gemini 専用として温存)。
// イベント名は可能な範囲で GenAILiveClient に寄せる (open/close/error/interrupted/toolcall/turncomplete)。
//
// 接続フロー (developers.openai.com/api/docs/guides/realtime-webrtc):
//  1. サーバー /api/realtime/token で ephemeral client secret (ek_) を取得
//  2. RTCPeerConnection 作成、マイク track を addTrack、data channel "oai-events" 作成
//  3. createOffer → setLocalDescription → POST /v1/realtime/calls (SDP, Bearer ek_) → answer
//  4. data channel open で session.update を送信 → session.created/updated で open 発火
//
// ⚠️ session.update / イベント名の GA スキーマは実測で最終調整する (Step 1 検証)。

import { EventEmitter } from "eventemitter3";
import { authFetch } from "./api-client";

const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_MODEL = "gpt-realtime-2.1-mini";
const DEFAULT_VOICE = "marin";

export interface OpenAIToolDeclaration {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface OpenAIRealtimeConnectConfig {
  roomId: string;
  sessionId?: string;
  model?: string;
  instructions: string;
  voice?: string;
  tools: OpenAIToolDeclaration[];
  /** 共有マイク MediaStream (useSharedAudioStream)。無ければ getUserMedia する */
  inputStream?: MediaStream;
}

export interface OpenAIRealtimeEventTypes {
  open: () => void;
  close: () => void;
  error: (error: unknown) => void;
  interrupted: () => void;
  toolcall: (call: OpenAIToolCall) => void;
  /** 出力音声の書き起こし。final=true が確定 (response.output_audio_transcript.done) */
  transcript: (text: string, final: boolean) => void;
  turncomplete: () => void;
}

type ServerEvent = { type?: string; [k: string]: unknown };

export class OpenAIRealtimeClient extends EventEmitter<OpenAIRealtimeEventTypes> {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private ownStream: MediaStream | null = null; // 自前取得したマイクのみ (共有は stop しない)
  private config: OpenAIRealtimeConnectConfig | null = null;
  private _status: "connected" | "connecting" | "disconnected" = "disconnected";
  private opened = false;
  private transcriptBuf = "";

  get status() {
    return this._status;
  }

  async connect(config: OpenAIRealtimeConnectConfig): Promise<void> {
    if (this._status !== "disconnected") this.disconnect();
    this.config = config;
    this._status = "connecting";
    this.opened = false;
    this.transcriptBuf = "";

    // 1. ephemeral token (サーバーが OPENAI_API_KEY で発行。キーはブラウザに出ない)
    const tokenRes = await authFetch("/api/realtime/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: config.roomId,
        session_id: config.sessionId ?? null,
        model: config.model ?? DEFAULT_MODEL,
      }),
    });
    if (!tokenRes.ok) {
      this._status = "disconnected";
      throw new Error(`realtime token failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const tokenData = (await tokenRes.json()) as { value?: string };
    const ek = tokenData.value;
    if (!ek) {
      this._status = "disconnected";
      throw new Error("realtime token: missing 'value'");
    }

    // 2. peer connection
    const pc = new RTCPeerConnection();
    this.pc = pc;

    // 出力音声: WebRTC track を <audio> で自動再生
    const audioEl = new Audio();
    audioEl.autoplay = true;
    this.audioEl = audioEl;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
    };

    // マイク入力 (共有 stream 優先。無ければ自前取得)
    const stream =
      config.inputStream ??
      (this.ownStream = await navigator.mediaDevices.getUserMedia({ audio: true }));
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

    // data channel (イベント送受信)
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("message", (e) => this.handleServerEvent(e.data as string));
    dc.addEventListener("open", () => this.sendSessionUpdate());

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this._status !== "disconnected") {
          this._status = "disconnected";
          this.emit("close");
        }
      }
    });

    // 3. SDP offer/answer (ephemeral token で認証)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const model = config.model ?? DEFAULT_MODEL;
    const sdpRes = await fetch(`${OPENAI_CALLS_URL}?model=${encodeURIComponent(model)}`, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${ek}`, "Content-Type": "application/sdp" },
    });
    if (!sdpRes.ok) {
      this._status = "disconnected";
      throw new Error(`realtime SDP exchange failed: ${sdpRes.status} ${await sdpRes.text()}`);
    }
    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    // open は session.created/updated 受信後に emit する
  }

  private sendEvent(obj: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(obj));
  }

  /** config アダプタ: Gemini config → OpenAI session.update */
  private sendSessionUpdate(): void {
    const c = this.config;
    if (!c) return;
    this.sendEvent({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: c.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            // server VAD に委譲 (Codex 指摘: client VAD の gate / 16kHz 時間定数問題を回避)
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: c.voice ?? DEFAULT_VOICE },
        },
        tools: c.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    });
  }

  private handleServerEvent(raw: string): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    switch (evt.type) {
      case "session.created":
      case "session.updated":
        if (!this.opened) {
          this.opened = true;
          this._status = "connected";
          this.emit("open");
        }
        break;
      case "response.output_audio_transcript.delta":
        if (typeof evt.delta === "string") {
          this.transcriptBuf += evt.delta;
          this.emit("transcript", evt.delta, false);
        }
        break;
      case "response.output_audio_transcript.done":
        this.emit("transcript", (evt.transcript as string) ?? this.transcriptBuf, true);
        this.transcriptBuf = "";
        break;
      case "input_audio_buffer.speech_started":
        // ユーザー発話開始 = 割り込み
        this.emit("interrupted");
        break;
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try {
          args = evt.arguments ? (JSON.parse(evt.arguments as string) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        this.emit("toolcall", {
          callId: evt.call_id as string,
          name: evt.name as string,
          args,
        });
        break;
      }
      case "response.done":
        this.emit("turncomplete");
        break;
      case "error":
        this.emit("error", evt.error ?? evt);
        break;
      default:
        break;
    }
  }

  /**
   * FC 結果を返す。
   * Step 1: 同期1回 (function_call_output + response.create)。
   * Step 2 で response scheduler により willContinue/scheduling(INTERRUPT/WHEN_IDLE) を吸収する。
   */
  sendToolResult(callId: string, output: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  /** テキスト注入 (proactive 介入 / エラー通知) */
  sendText(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.sendEvent({ type: "response.create" });
  }

  disconnect(): void {
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    try {
      this.pc?.close();
    } catch {
      /* noop */
    }
    // 自前取得したマイクのみ停止 (共有 inputStream は呼び出し側が管理)
    this.ownStream?.getTracks().forEach((t) => t.stop());
    this.ownStream = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    this.dc = null;
    this.pc = null;
    this._status = "disconnected";
    this.opened = false;
  }
}

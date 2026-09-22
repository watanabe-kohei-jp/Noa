// OpenAI Realtime API client — WebRTC 主経路 (Issue #180)
//
// GenAILiveClient (genai-live-client.ts) の代替。ブラウザ WebRTC で OpenAI Realtime に接続する。
// 音声は WebRTC track で送受信 (Opus)。出力は <audio> 要素で自動再生するため、Gemini 経路の
// AudioStreamer/AudioRecorder/worklet は使わない (16kHz 資産は Gemini 専用として温存)。
//
// 接続フロー (developers.openai.com/api/docs/guides/realtime-webrtc):
//  1. マイクを先に取得 (許可ダイアログ待ちで ephemeral token の TTL を消費しないため)
//  2. サーバー /api/realtime/token で ephemeral client secret (ek_) を取得
//  3. RTCPeerConnection 作成、マイク track を addTrack、data channel "oai-events" 作成
//  4. createOffer → setLocalDescription → POST /v1/realtime/calls (SDP, Bearer ek_) → answer
//  5. data channel open で session.update を送信 → session.updated で open 発火
//
// GPT-5.6 Sol レビュー反映:
//  - idle scheduler: tool result の function_call_output+response.create を idle まで保留し競合回避
//  - connect 全体を try/catch し失敗時 cleanup (マイク残り/再接続不能を防止)
//  - open は session.updated のみ (session.update の成功を確認。設定エラーを見逃さない)
//  - arguments の JSON/型を検証してから toolcall emit
//  - /v1/realtime/calls の ?model= は不要 (ephemeral secret に model が束縛される)

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
  /** 計測: ユーザー発話終了 → 最初の出力までの時間 (TTFT 目安) */
  metrics: (m: { ttftMs: number }) => void;
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

  // idle scheduler 用の状態 (同時に走れる response は1つ)
  private hasActiveResponse = false;
  private audioPlaying = false;
  private userSpeaking = false;
  private pendingToolResults: { callId: string; output: string }[] = [];

  // TTFT 計測用
  private lastSpeechStoppedAt = 0;
  private awaitingFirstOutput = false;

  get status() {
    return this._status;
  }

  async connect(config: OpenAIRealtimeConnectConfig): Promise<void> {
    if (this._status !== "disconnected") this.disconnect();
    this.config = config;
    this._status = "connecting";
    this.opened = false;
    this.resetSchedulerState();

    try {
      // 1. マイクを先に取得 (許可ダイアログ待ちで token TTL を消費しない)
      const stream =
        config.inputStream ??
        (this.ownStream = await navigator.mediaDevices.getUserMedia({ audio: true }));

      // 2. ephemeral token (サーバーが OPENAI_API_KEY で発行。キーはブラウザに出ない)
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
        throw new Error(`realtime token failed: ${tokenRes.status} ${await tokenRes.text()}`);
      }
      const tokenData = (await tokenRes.json()) as { value?: string };
      const ek = tokenData.value;
      if (!ek) throw new Error("realtime token: missing 'value'");

      // 3. peer connection
      const pc = new RTCPeerConnection();
      this.pc = pc;

      const audioEl = new Audio();
      audioEl.autoplay = true;
      // detached な Audio 要素は autoplay policy でブロックされることがあるため DOM に追加
      audioEl.style.display = "none";
      if (typeof document !== "undefined") document.body.appendChild(audioEl);
      this.audioEl = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        void audioEl.play().catch((err) =>
          console.warn("[openai-realtime] audio play() blocked:", err)
        );
      };

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("message", (e) => this.handleServerEvent(e.data as string));
      dc.addEventListener("open", () => this.sendSessionUpdate());
      dc.addEventListener("close", () => this.handleTransportClosed());
      dc.addEventListener("error", () => this.handleTransportClosed());

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          this.handleTransportClosed();
        }
      });

      // 4. SDP offer/answer (ephemeral token で認証。?model= は不要 = ek に model 束縛)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch(OPENAI_CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ek}`,
          "Content-Type": "application/sdp",
          Accept: "application/sdp",
        },
      });
      if (!sdpRes.ok) {
        throw new Error(`realtime SDP exchange failed: ${sdpRes.status} ${await sdpRes.text()}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      // open は session.updated 受信後に emit する
    } catch (e) {
      // 失敗時は必ず cleanup (マイク残り / _status="connecting" 固着による再接続不能を防ぐ)
      this.disconnect();
      throw e;
    }
  }

  private resetSchedulerState(): void {
    this.transcriptBuf = "";
    this.hasActiveResponse = false;
    this.audioPlaying = false;
    this.userSpeaking = false;
    this.pendingToolResults = [];
    this.lastSpeechStoppedAt = 0;
    this.awaitingFirstOutput = false;
  }

  private handleTransportClosed(): void {
    if (this._status !== "disconnected") {
      this._status = "disconnected";
      this.emit("close");
    }
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
            // server VAD に委譲 (Codex: client VAD の gate / 16kHz 時間定数問題を回避)
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: c.voice ?? DEFAULT_VOICE },
          // WebRTC では format は Opus を SDP でネゴシエートするため省略 (Codex 確認)
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
      case "session.updated":
        // session.update の成功確認。初回のみ open (session.created では発火しない)
        if (!this.opened) {
          this.opened = true;
          this._status = "connected";
          this.emit("open");
        }
        break;

      case "response.created":
        this.hasActiveResponse = true;
        break;
      case "response.done": {
        this.hasActiveResponse = false;
        const status = (evt.response as { status?: string } | undefined)?.status;
        // cancelled は barge-in (interrupt_response) による正常な中断 → error 扱いしない
        if (status && status !== "completed" && status !== "cancelled") {
          this.emit("error", { where: "response.done", status, detail: evt.response });
        }
        this.emit("turncomplete");
        this.flushToolResults();
        break;
      }

      case "output_audio_buffer.started":
        this.audioPlaying = true;
        this.markFirstOutput();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.audioPlaying = false;
        this.flushToolResults();
        break;

      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        // 実際の barge-in は active response / 再生中のときだけ
        if (this.hasActiveResponse || this.audioPlaying) this.emit("interrupted");
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.lastSpeechStoppedAt = Date.now();
        this.awaitingFirstOutput = true;
        this.flushToolResults();
        break;

      case "response.output_audio_transcript.delta":
        if (typeof evt.delta === "string") {
          this.markFirstOutput();
          this.transcriptBuf += evt.delta;
          this.emit("transcript", evt.delta, false);
        }
        break;
      case "response.output_audio_transcript.done":
        this.emit("transcript", (evt.transcript as string) ?? this.transcriptBuf, true);
        this.transcriptBuf = "";
        break;

      case "response.function_call_arguments.done": {
        const callId = evt.call_id;
        const name = evt.name;
        if (typeof callId !== "string" || typeof name !== "string") {
          console.warn("[openai-realtime] FC done without call_id/name", evt);
          break;
        }
        // 中断/不完全時は arguments が不正なことがある → 実行しない
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse((evt.arguments as string) ?? "{}");
          if (typeof parsed !== "object" || parsed === null) throw new Error("not object");
          args = parsed as Record<string, unknown>;
        } catch {
          console.warn("[openai-realtime] FC args parse failed, skipping", evt.arguments);
          break;
        }
        this.emit("toolcall", { callId, name, args });
        break;
      }

      case "error":
        this.emit("error", evt.error ?? evt);
        break;
      default:
        break;
    }
  }

  private markFirstOutput(): void {
    if (this.awaitingFirstOutput && this.lastSpeechStoppedAt > 0) {
      this.awaitingFirstOutput = false;
      this.emit("metrics", { ttftMs: Date.now() - this.lastSpeechStoppedAt });
    }
  }

  /**
   * FC 結果を返す。idle (ユーザー無発話・response 非生成・音声非再生) になるまで保留し、
   * function_call_output + response.create をまとめて送る (Codex: response.create の競合回避)。
   * これにより「非同期FC が会話を止めない」ことを、単なる active-response 競合と区別して検証できる。
   */
  sendToolResult(callId: string, output: unknown): void {
    const outStr = typeof output === "string" ? output : JSON.stringify(output ?? {});
    this.pendingToolResults.push({ callId, output: outStr });
    this.flushToolResults();
  }

  private flushToolResults(): void {
    if (this.pendingToolResults.length === 0) return;
    if (this.userSpeaking || this.hasActiveResponse || this.audioPlaying) return; // idle 待ち
    for (const r of this.pendingToolResults) {
      this.sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: r.callId, output: r.output },
      });
    }
    this.pendingToolResults = [];
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
    this.resetSchedulerState();
  }
}

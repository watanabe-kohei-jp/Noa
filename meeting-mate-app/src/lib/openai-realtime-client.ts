// OpenAI Realtime API WebSocket client — PoC スケルトン (Issue #180)
//
// 目的: Gemini Live (genai-live-client.ts) の代替として OpenAI Realtime
// (gpt-realtime-2.1) を検証する。既存の GenAILiveClient と「切替可能な I/F」を
// 目指し、イベント名・メソッド名を可能な範囲で揃える。
//
// ⚠️ これは PoC スケルトンであり、疎通実装は段階的に埋める。
//    OPENAI_API_KEY と ephemeral token エンドポイント (server 側 /api/realtime/token)
//    が揃ってから接続テストを行う。
//
// 参考:
//   - WS エンドポイント: wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1
//   - 認証: ephemeral client_secret (サーバーが OPENAI_API_KEY で発行) を
//           Sec-WebSocket-Protocol / Authorization で渡す
//   - 音声: 入出力とも PCM16。OpenAI は 24kHz mono がデフォルト
//           (Gemini Live は 16kHz — リサンプリング差異に注意)
//   - 主要イベント (server→client):
//       session.created / session.updated
//       input_audio_buffer.speech_started / .speech_stopped  (VAD/割り込み)
//       response.output_audio.delta        (音声チャンク)
//       response.output_audio_transcript.delta
//       response.function_call_arguments.done  (FC 発火)
//       response.done
//   - 主要イベント (client→server):
//       session.update              (instructions / tools / voice / modalities)
//       input_audio_buffer.append   (base64 PCM16)
//       conversation.item.create + response.create  (テキスト注入)
//       conversation.item.create(function_call_output)  (FC 結果返却)

import { EventEmitter } from "eventemitter3";

// --- 型 (GenAILiveClient のイベントと対応させる) ---
export interface OpenAIRealtimeEventTypes {
  open: () => void;
  close: (event: CloseEvent) => void;
  error: (error: Event) => void;
  /** 出力音声チャンク (PCM16 ArrayBuffer) — GenAILiveClient.audio と対応 */
  audio: (data: ArrayBuffer) => void;
  /** 出力音声の書き起こし delta — outputAudioTranscription と対応 */
  transcript: (text: string) => void;
  /** モデルのターン完了 — turncomplete と対応 */
  turncomplete: () => void;
  /** ユーザー発話開始による割り込み — interrupted と対応 */
  interrupted: () => void;
  /**
   * Function Calling 発火 — toolcall と対応。
   * ★PoC 検証ポイント: 非同期 FC (長時間ツール) が会話を止めないこと。
   *   Gemini の willContinue / FunctionResponseScheduling に相当する挙動を
   *   OpenAI がネイティブに担保するかをここで実測する。
   */
  toolcall: (call: OpenAIFunctionCall) => void;
}

export interface OpenAIFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface OpenAIRealtimeToolDeclaration {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface OpenAIRealtimeConnectConfig {
  model?: string; // default: gpt-realtime-2.1
  instructions: string; // system prompt 相当
  voice?: string; // 例: "marin" / "cedar"
  tools: OpenAIRealtimeToolDeclaration[];
  /** TODO(#180): built-in web_search を使うか、Brain 経由 web_search で代替するか検証 */
}

const DEFAULT_MODEL = "gpt-realtime-2.1";
const REALTIME_WS_BASE = "wss://api.openai.com/v1/realtime";

export class OpenAIRealtimeClient extends EventEmitter<OpenAIRealtimeEventTypes> {
  private ws: WebSocket | null = null;
  private _status: "connected" | "connecting" | "disconnected" = "disconnected";
  private config: OpenAIRealtimeConnectConfig | null = null;

  /** サーバーの ephemeral token 発行エンドポイント (要実装: server /api/realtime/token) */
  constructor(private readonly tokenEndpoint: string = "/api/realtime/token") {
    super();
  }

  get status() {
    return this._status;
  }

  /**
   * 接続: (1) サーバーから ephemeral token を取得 → (2) WS 接続 → (3) session.update
   * TODO(#180): ephemeral token フローの実装。サーバー側で OPENAI_API_KEY を用いて
   *             短命の client_secret を発行する (キーをブラウザに出さない)。
   */
  async connect(config: OpenAIRealtimeConnectConfig): Promise<void> {
    this.config = config;
    this._status = "connecting";

    // (1) ephemeral token
    // const { client_secret } = await fetch(this.tokenEndpoint, { method: "POST" }).then(r => r.json());

    // (2) WebSocket
    const model = config.model ?? DEFAULT_MODEL;
    void `${REALTIME_WS_BASE}?model=${model}`; // TODO: new WebSocket(url, [subprotocol with token])

    // (3) session.update で instructions / tools / voice / modalities を送る
    // this.sendEvent({ type: "session.update", session: { instructions, tools, ... } });

    throw new Error("OpenAIRealtimeClient.connect: PoC 未実装 (Issue #180)");
  }

  /** マイク音声を送る (base64 PCM16) — GenAILiveClient.sendRealtimeInput 相当 */
  sendAudio(_base64Pcm16: string): void {
    // this.sendEvent({ type: "input_audio_buffer.append", audio: base64Pcm16 });
    throw new Error("sendAudio: PoC 未実装 (Issue #180)");
  }

  /** テキスト注入 (proactive 介入など) — GenAILiveClient.send 相当 */
  sendText(_text: string): void {
    // conversation.item.create(message) + response.create
    throw new Error("sendText: PoC 未実装 (Issue #180)");
  }

  /**
   * FC 結果を返す — tool-handler の willContinue/scheduling ロジックの置換対象。
   * ★検証: 長時間ツールでも会話が止まらない (async FC) ことを確認する。
   */
  sendToolResult(_callId: string, _output: unknown): void {
    // conversation.item.create(function_call_output) + response.create
    throw new Error("sendToolResult: PoC 未実装 (Issue #180)");
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._status = "disconnected";
  }
}

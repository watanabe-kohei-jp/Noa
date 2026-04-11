// Gemini Live API WebSocket client
import {
  Content,
  GoogleGenAI,
  LiveCallbacks,
  LiveClientToolResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerGoAway,
  LiveServerMessage,
  LiveServerSessionResumptionUpdate,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
  Session,
} from "@google/genai";

import { EventEmitter } from "eventemitter3";
import { LiveClientOptions, StreamingLog } from "../types/live-api";
import { base64ToArrayBuffer } from "./audio-utils";

export interface LiveClientEventTypes {
  audio: (data: ArrayBuffer) => void;
  close: (event: CloseEvent) => void;
  content: (data: LiveServerContent) => void;
  error: (error: ErrorEvent) => void;
  interrupted: () => void;
  log: (log: StreamingLog) => void;
  open: () => void;
  setupcomplete: () => void;
  toolcall: (toolCall: LiveServerToolCall) => void;
  toolcallcancellation: (
    toolcallCancellation: LiveServerToolCallCancellation
  ) => void;
  turncomplete: () => void;
  sessionresumptionupdate: (update: LiveServerSessionResumptionUpdate) => void;
  goaway: (goAway: LiveServerGoAway) => void;
}

export class GenAILiveClient extends EventEmitter<LiveClientEventTypes> {
  protected client: GoogleGenAI;

  private _status: "connected" | "disconnected" | "connecting" = "disconnected";
  public get status() {
    return this._status;
  }

  private _session: Session | null = null;
  public get session() {
    return this._session;
  }

  private _model: string | null = null;
  public get model() {
    return this._model;
  }

  protected config: LiveConnectConfig | null = null;

  public getConfig() {
    return { ...this.config };
  }

  constructor(options: LiveClientOptions) {
    super();
    this.client = new GoogleGenAI(options);
    this.send = this.send.bind(this);
    this.onopen = this.onopen.bind(this);
    this.onerror = this.onerror.bind(this);
    this.onclose = this.onclose.bind(this);
    this.onmessage = this.onmessage.bind(this);
  }

  protected log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  async connect(model: string, config: LiveConnectConfig): Promise<boolean> {
    if (this._status === "connected" || this._status === "connecting") {
      return false;
    }

    this._status = "connecting";
    this.config = config;
    this._model = model;

    const callbacks: LiveCallbacks = {
      onopen: this.onopen,
      onmessage: this.onmessage,
      onerror: this.onerror,
      onclose: this.onclose,
    };

    console.log("[GenAILive] Connecting...", { model, configKeys: Object.keys(config) });
    try {
      this._session = await this.client.live.connect({
        model,
        config,
        callbacks,
      });
      console.log("[GenAILive] Session created OK");
    } catch (e) {
      console.error("[GenAILive] Connection failed:", e);
      this._status = "disconnected";
      return false;
    }

    this._status = "connected";
    return true;
  }

  public disconnect() {
    if (!this.session) {
      return false;
    }
    this.session?.close();
    this._session = null;
    this._status = "disconnected";

    this.log("client.close", `Disconnected`);
    return true;
  }

  protected onopen() {
    console.log("[GenAILive] WebSocket opened");
    this.log("client.open", "Connected");
    this.emit("open");
  }

  protected onerror(e: ErrorEvent) {
    console.error("[GenAILive] WebSocket error:", e.message);
    this.log("server.error", e.message);
    this.emit("error", e);
  }

  protected onclose(e: CloseEvent) {
    console.log("[GenAILive] WebSocket closed:", e.code, e.reason);
    this._status = "disconnected";
    this._session = null;
    this.log(
      `server.close`,
      `disconnected ${e.reason ? `with reason: ${e.reason}` : ``}`
    );
    this.emit("close", e);
  }

  protected async onmessage(message: LiveServerMessage) {
    const msgKeys = Object.keys(message).filter(k => (message as unknown as Record<string, unknown>)[k] != null);
    console.log("[GenAILive] onmessage:", msgKeys.join(", "));
    if (message.setupComplete) {
      console.log("[GenAILive] Setup complete!");
      this.log("server.send", "setupComplete");
      this.emit("setupcomplete");
      return;
    }
    if (message.sessionResumptionUpdate) {
      const { resumable, newHandle } = message.sessionResumptionUpdate;
      this.log("server.sessionResumptionUpdate", `resumable=${resumable}, hasHandle=${!!newHandle}`);
      this.emit("sessionresumptionupdate", message.sessionResumptionUpdate);
      return;
    }
    if (message.goAway) {
      this.log("server.goAway", `timeLeft=${message.goAway.timeLeft}`);
      this.emit("goaway", message.goAway);
      return;
    }
    if (message.toolCall) {
      this.log("server.toolCall", message);
      this.emit("toolcall", message.toolCall);
      return;
    }
    if (message.toolCallCancellation) {
      this.log("server.toolCallCancellation", message);
      this.emit("toolcallcancellation", message.toolCallCancellation);
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;
      if ("interrupted" in serverContent) {
        this.log("server.content", "interrupted");
        this.emit("interrupted");
        return;
      }
      if ("turnComplete" in serverContent) {
        this.log("server.content", "turnComplete");
        this.emit("turncomplete");
      }

      if ("outputTranscription" in serverContent && serverContent.outputTranscription) {
        const text = serverContent.outputTranscription.text || "";
        if (text) {
          this.log("server.transcript", text);
          const content: { modelTurn: Content } = {
            modelTurn: { parts: [{ text }] },
          };
          this.emit("content", content);
        }
      }

      if ("modelTurn" in serverContent) {
        let parts: Part[] = serverContent.modelTurn?.parts || [];

        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/pcm")
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);

        const otherParts = parts.filter((p) => !audioParts.includes(p));

        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.emit("audio", data);
            this.log(`server.audio`, `buffer (${data.byteLength})`);
          }
        });
        if (!otherParts.length) {
          return;
        }

        parts = otherParts;
        const content: { modelTurn: Content } = { modelTurn: { parts } };
        this.emit("content", content);
        this.log(`server.content`, message);
      }
    } else {
      console.log("received unmatched message", message);
    }
  }

  sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    let hasAudio = false;
    let hasVideo = false;
    for (const ch of chunks) {
      if (ch.mimeType.includes("audio")) {
        this.session?.sendRealtimeInput({ audio: ch });
        hasAudio = true;
      } else if (ch.mimeType.includes("image")) {
        this.session?.sendRealtimeInput({ video: ch });
        hasVideo = true;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
        ? "audio"
        : hasVideo
        ? "video"
        : "unknown";
    this.log(`client.realtimeInput`, message);
  }

  sendToolResponse(toolResponse: LiveClientToolResponse) {
    if (
      toolResponse.functionResponses &&
      toolResponse.functionResponses.length
    ) {
      this.session?.sendToolResponse({
        functionResponses: toolResponse.functionResponses,
      });
      this.log(`client.toolResponse`, toolResponse);
    }
  }

  send(parts: Part | Part[], turnComplete: boolean = true) {
    this.session?.sendClientContent({ turns: parts, turnComplete });
    this.log(`client.send`, {
      turns: Array.isArray(parts) ? parts : [parts],
      turnComplete,
    });
  }
}

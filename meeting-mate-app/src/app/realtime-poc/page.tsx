"use client";

// OpenAI Realtime 疎通確認ページ (Issue #180, Step B: 疎通優先)
// 既存 /room・LivePanel を一切触らず、基盤 (openai-realtime-client + useOpenAIRealtime + /api/realtime/token)
// が実際に WebRTC 接続でき、音声往復・FC・非同期FC が動くかを最小導線で実測する。
// 統合(LivePanel への provider 対応)はこの疎通の確証を得てから。

import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenAIRealtime } from "../../hooks/useOpenAIRealtime";
import type {
  OpenAIToolCall,
  OpenAIToolDeclaration,
} from "../../lib/openai-realtime-client";

const ROOM_ID = "dev-room"; // 検証用 (participant である前提)

// 最小の検証用ツール (tool-handler は使わず、非同期FC の挙動だけを見る)
const TOOLS: OpenAIToolDeclaration[] = [
  {
    type: "function",
    name: "get_current_time",
    description: "現在時刻を返す。ユーザーが時刻を尋ねたら呼ぶ。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "slow_lookup",
    description: "社内データを調べる(時間がかかる)。ユーザーが調査を依頼したら呼ぶ。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "調べる内容" } },
      required: ["query"],
    },
  },
];

export default function RealtimePocPage() {
  const { client, setConnectConfig, connectionState, connected, connect, disconnect } =
    useOpenAIRealtime();
  const [logs, setLogs] = useState<string[]>([]);
  const [transcript, setTranscript] = useState("");
  const connectStartRef = useRef<number>(0);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const log = useCallback((m: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    setLogs((prev) => [...prev.slice(-80), `${ts}  ${m}`]);
  }, []);

  // client イベント配線 (hook の open/close/error 配線とは別に、検証用イベントを購読)
  useEffect(() => {
    const onInterrupted = () => log("interrupted (barge-in)");
    const onTurn = () => log("turncomplete");
    const onError = (e: unknown) =>
      log(`error: ${typeof e === "string" ? e : JSON.stringify(e)}`);
    const onMetrics = (m: { ttftMs: number }) =>
      log(`★ TTFT (speech_stopped→first output): ${m.ttftMs}ms`);
    const onTranscript = (text: string, final: boolean) => {
      if (final) setTranscript((p) => p + text + "\n");
    };
    const onToolcall = (call: OpenAIToolCall) => {
      log(`toolcall: ${call.name}(${JSON.stringify(call.args)})`);
      if (call.name === "get_current_time") {
        client.sendToolResult(call.callId, { time: new Date().toISOString() });
        log("→ get_current_time 応答をキュー (idle で送信)");
      } else if (call.name === "slow_lookup") {
        log("→ slow_lookup 10秒待機 ★この間に別応答を要求する発話をして会話継続を確認");
        if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
        slowTimerRef.current = setTimeout(() => {
          client.sendToolResult(call.callId, {
            result: `「${String(call.args.query ?? "")}」の調査結果: 売上は前年比+12%`,
          });
          log("→ slow_lookup 完了 (function_call_output を idle で送信)");
        }, 10000);
      }
    };

    client
      .on("interrupted", onInterrupted)
      .on("turncomplete", onTurn)
      .on("error", onError)
      .on("metrics", onMetrics)
      .on("transcript", onTranscript)
      .on("toolcall", onToolcall);
    return () => {
      client
        .off("interrupted", onInterrupted)
        .off("turncomplete", onTurn)
        .off("error", onError)
        .off("metrics", onMetrics)
        .off("transcript", onTranscript)
        .off("toolcall", onToolcall);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, [client, log]);

  const handleConnect = useCallback(async () => {
    connectStartRef.current = Date.now();
    setConnectConfig({
      roomId: ROOM_ID,
      instructions:
        "あなたは会議アシスタント Noa。日本語で簡潔に話す。時刻を聞かれたら get_current_time、" +
        "調査を頼まれたら slow_lookup を呼ぶ。ツール結果を待つ間も、無関係な質問には答えてよい。",
      voice: "marin",
      tools: TOOLS,
    });
    try {
      await connect();
      log("connect() resolved (SDP交換完了、session.updated待ち)");
    } catch (e) {
      log(`connect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [connect, setConnectConfig, log]);

  return (
    <div style={{ padding: 24, fontFamily: "ui-monospace, Consolas, monospace", maxWidth: 860 }}>
      <h1 style={{ fontSize: 20 }}>OpenAI Realtime PoC 疎通確認 (#180)</h1>
      <p>
        room: <b>{ROOM_ID}</b> / model: <b>gpt-realtime-2.1-mini</b> / status:{" "}
        <b>{connectionState}</b>
      </p>
      <div style={{ display: "flex", gap: 8, margin: "12px 0 16px" }}>
        <button onClick={handleConnect} disabled={connected} style={{ padding: "6px 16px" }}>
          接続
        </button>
        <button onClick={disconnect} disabled={!connected} style={{ padding: "6px 16px" }}>
          切断
        </button>
      </div>
      <h3 style={{ fontSize: 15 }}>検証手順</h3>
      <ol style={{ fontSize: 13, lineHeight: 1.7 }}>
        <li>「接続」→ マイク許可 → 話しかけて音声が返るか (往復)</li>
        <li>「今何時？」→ get_current_time が即応答するか (同期FC)</li>
        <li>
          「売上を調べて」→ slow_lookup(10秒)。<b>待機中に「3+4は？」等、別応答を
          要求する発話をして会話が止まらないか</b> (★非同期FC = 移行の本丸)
        </li>
      </ol>
      <h3 style={{ fontSize: 15 }}>イベントログ</h3>
      <pre
        style={{
          background: "#0d1117",
          color: "#3fb950",
          padding: 12,
          height: 260,
          overflow: "auto",
          fontSize: 12,
          borderRadius: 6,
        }}
      >
        {logs.join("\n")}
      </pre>
      <h3 style={{ fontSize: 15 }}>確定 transcript</h3>
      <pre style={{ background: "#f4f4f4", padding: 12, fontSize: 12, borderRadius: 6 }}>
        {transcript}
      </pre>
    </div>
  );
}

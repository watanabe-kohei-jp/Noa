import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveToolHandler } from "@/lib/live-tools/tool-handler";

// GenAILiveClient のモック
function createMockClient() {
  return {
    sendToolResponse: vi.fn(),
    send: vi.fn(),
    sendRealtimeInput: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as import("@/lib/genai-live-client").GenAILiveClient;
}

function makeBrainToolCall(fcId: string, request: string) {
  return {
    functionCalls: [
      { id: fcId, name: "delegate_to_brain", args: { request } },
    ],
  };
}

describe("LiveToolHandler - disconnect & session generation", () => {
  let handler: LiveToolHandler;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    handler = new LiveToolHandler();
    mockClient = createMockClient();
    handler.setContextProvider({
      getRoomData: () => null,
      getSessionState: () => null,
    });
  });

  it("resetForDisconnect() で active FC が全キャンセルされる", async () => {
    // onBrainRequested を遅延させて、途中で resetForDisconnect を呼ぶ
    let brainResolve: (v: { response_text: string }) => void;
    const brainPromise = new Promise<{ response_text: string }>((resolve) => {
      brainResolve = resolve;
    });

    handler.setCallbacks({
      onBrainRequested: () => brainPromise,
    });

    // Brain 呼び出しを開始（非同期）
    const handlePromise = handler.handleToolCall(
      makeBrainToolCall("fc1", "テストリクエスト"),
      mockClient
    );

    // willContinue: true ACK が送信されるのを待つ
    await vi.waitFor(() => {
      expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
    });

    // disconnect 発動
    handler.resetForDisconnect();

    // Brain 結果を返す
    brainResolve!({ response_text: "結果" });
    await handlePromise;

    // willContinue: true の1回のみ（世代チェックで final response はスキップ）
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
    const ackCall = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(ackCall.functionResponses[0].willContinue).toBe(true);
  });

  it("resetForDisconnect() で debounce 状態がリセットされる", async () => {
    // 最初のリクエストを通常処理
    handler.setCallbacks({
      onBrainRequested: vi.fn().mockResolvedValue({
        response_text: "結果1",
      }),
    });

    await handler.handleToolCall(
      makeBrainToolCall("fc1", "同じリクエスト"),
      mockClient
    );

    // fc1 は ACK + final = 2回
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(2);

    // disconnect → resetForDisconnect で debounce リセット
    handler.resetForDisconnect();
    (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mockClear();

    // 再接続後に同じリクエストが debounce されずに通ること
    handler.setCallbacks({
      onBrainRequested: vi.fn().mockResolvedValue({
        response_text: "結果2",
      }),
    });

    await handler.handleToolCall(
      makeBrainToolCall("fc2", "同じリクエスト"),
      mockClient
    );

    // debounce されていなければ ACK + final = 2回
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(2);
    const finalCall = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>)
      .mock.calls[1][0];
    expect(finalCall.functionResponses[0].willContinue).toBe(false);
    expect(finalCall.functionResponses[0].response.answer).toBe("結果2");
  });

  it("resetForDisconnect() で世代が進む", () => {
    const gen1 = handler.incrementGeneration(); // 1
    handler.resetForDisconnect(); // 2 (内部で ++)
    const gen3 = handler.incrementGeneration(); // 3
    expect(gen1).toBe(1);
    expect(gen3).toBe(3);
  });

  it("世代変更で stale response が送信されない", async () => {
    let brainResolve: (v: { response_text: string }) => void;
    const brainPromise = new Promise<{ response_text: string }>((resolve) => {
      brainResolve = resolve;
    });

    handler.setCallbacks({
      onBrainRequested: () => brainPromise,
    });

    const handlePromise = handler.handleToolCall(
      makeBrainToolCall("fc1", "テスト"),
      mockClient
    );

    // ACK 待ち
    await vi.waitFor(() => {
      expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
    });

    // 世代を進める（disconnect シミュレーション）
    handler.incrementGeneration();

    // Brain 結果を返す
    brainResolve!({ response_text: "stale な結果" });
    await handlePromise;

    // ACK の1回のみ（世代不一致で final response はスキップ）
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
  });

  it("正常ケースで世代チェックが影響しない", async () => {
    handler.setCallbacks({
      onBrainRequested: vi.fn().mockResolvedValue({
        response_text: "正常な結果",
      }),
    });

    await handler.handleToolCall(
      makeBrainToolCall("fc1", "正常リクエスト"),
      mockClient
    );

    // ACK + final = 2回
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(2);
    const calls = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[0][0].functionResponses[0].willContinue).toBe(true);
    expect(calls[1][0].functionResponses[0].willContinue).toBe(false);
    expect(calls[1][0].functionResponses[0].response.answer).toBe(
      "正常な結果"
    );
  });

  it("disconnect 直後の新規 tool call が世代チェックで弾かれる", async () => {
    let brainResolve: (v: { response_text: string }) => void;

    handler.setCallbacks({
      onBrainRequested: () =>
        new Promise<{ response_text: string }>((resolve) => {
          brainResolve = resolve;
        }),
    });

    // disconnect 発動（世代が進む）
    handler.resetForDisconnect();

    // disconnect 後に新しいリクエストが来る（滑り込み）
    const handlePromise = handler.handleToolCall(
      makeBrainToolCall("fc-new", "新しいリクエスト"),
      mockClient
    );

    // ACK 待ち
    await vi.waitFor(() => {
      expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
    });

    // ここで再度世代を進める（再接続シミュレーション）
    handler.incrementGeneration();

    // Brain 結果を返す
    brainResolve!({ response_text: "新セッションに送るべきでない" });
    await handlePromise;

    // ACK の1回のみ
    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
  });
});

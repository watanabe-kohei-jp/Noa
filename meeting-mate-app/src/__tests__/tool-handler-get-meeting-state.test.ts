import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveToolHandler } from "@/lib/live-tools/tool-handler";
import type { SessionMeetingState } from "@/lib/meeting-context";

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

const mockSessionState: SessionMeetingState = {
  transcript: [
    { userId: "u1", userName: "Alice", text: "hi", timestamp: "t1", role: "user", origin: "human_chat" },
    { userId: "noa", userName: "Noa", text: "hello", timestamp: "t2", role: "ai", origin: "live_ai" },
  ],
  tasks: [{ id: "1", title: "Task1", assignee: "Alice", status: "todo", priority: "high" }],
  notes: [{ type: "decision", text: "Note1" }],
  currentAgenda: { mainTopic: "Topic1", details: [{ text: "Detail1" }] },
  suggestedNextTopics: ["Next1"],
  participants: [{ id: "u1", name: "Alice", role: "host" }],
};

describe("LiveToolHandler - get_meeting_state", () => {
  let handler: LiveToolHandler;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    handler = new LiveToolHandler();
    mockClient = createMockClient();
    handler.setContextProvider({
      getRoomData: () => null,
      getSessionState: () => mockSessionState,
    });
    handler.setCallbacks({});
  });

  it("get_meeting_state(tasks) → タスク一覧を返す", async () => {
    await handler.handleToolCall(
      {
        functionCalls: [
          { id: "fc1", name: "get_meeting_state", args: { category: "tasks" } },
        ],
      },
      mockClient
    );

    expect(mockClient.sendToolResponse).toHaveBeenCalledTimes(1);
    const call = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const response = call.functionResponses[0].response;
    expect(response.tasks).toHaveLength(1);
    expect(response.tasks[0].title).toBe("Task1");
  });

  it("get_meeting_state(recent_messages) → human メッセージのみ返す", async () => {
    await handler.handleToolCall(
      {
        functionCalls: [
          { id: "fc2", name: "get_meeting_state", args: { category: "recent_messages" } },
        ],
      },
      mockClient
    );

    const call = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const response = call.functionResponses[0].response;
    expect(response.recent_messages).toHaveLength(1);
    expect(response.recent_messages[0].origin).toBe("human_chat");
  });

  it("get_meeting_state(all) → すべて含む", async () => {
    await handler.handleToolCall(
      {
        functionCalls: [
          { id: "fc3", name: "get_meeting_state", args: { category: "all" } },
        ],
      },
      mockClient
    );

    const call = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const response = call.functionResponses[0].response;
    expect(response).toHaveProperty("tasks");
    expect(response).toHaveProperty("notes");
    expect(response).toHaveProperty("currentAgenda");
    expect(response).toHaveProperty("recent_messages");
  });

  it("contextProvider が null → エラーを返す", async () => {
    handler.setContextProvider({
      getRoomData: () => null,
      getSessionState: () => null,
    });

    await handler.handleToolCall(
      {
        functionCalls: [
          { id: "fc4", name: "get_meeting_state", args: { category: "tasks" } },
        ],
      },
      mockClient
    );

    const call = (mockClient.sendToolResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const response = call.functionResponses[0].response;
    expect(response).toHaveProperty("error");
  });
});

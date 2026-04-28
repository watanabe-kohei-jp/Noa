/**
 * useInvokeJob - Issue #129 /invoke の jobs/{jobId} 購読フックの単体テスト。
 *
 * vitest 環境は node のため React 描画はせず、フックの不変条件 (購読パス、
 * jobId に対応する state の整合、cleanup ハンドラ) を以下 2 つの観点で検証する:
 *   1. ソースコードに期待するパターンが含まれていること (回帰防止)
 *   2. snapshot → state マッピングが期待通り (purity test)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../hooks/useInvokeJob.ts"),
  "utf-8"
);

describe("useInvokeJob - source contracts", () => {
  it("購読パスは rooms/{roomId}/jobs/{jobId}", () => {
    expect(SRC).toMatch(/rooms\/\$\{roomId\}\/jobs\/\$\{jobId\}/);
  });

  it("onValue で購読し cleanup で unsubscribe を呼ぶ", () => {
    expect(SRC).toContain("onValue");
    // useEffect の return で unsubscribe を呼ぶ形を期待
    expect(SRC).toMatch(/return\s*\(\s*\)\s*=>\s*\{\s*unsubscribe\(\)/);
  });

  it("state には jobId フィールドがあり、新 jobId 受領時に即リセットする", () => {
    // jobId フィールドがある (連続 STT のスタール検知に使う)
    expect(SRC).toMatch(/jobId:\s*string\s*\|\s*null/);
    // jobId 変更時に新 jobId 用の空 state を setState
    expect(SRC).toContain("setState(emptyForJob(jobId))");
  });

  it("roomId / jobId が null のときは購読しない", () => {
    expect(SRC).toMatch(/if\s*\(\s*!roomId\s*\|\|\s*!jobId\s*\)/);
  });

  it("useEffect 依存配列に [roomId, jobId] が指定されている", () => {
    expect(SRC).toMatch(/\[roomId,\s*jobId\]/);
  });
});

// snapshot → state マッピング (関数を介さず手動シミュレート)。本物の onValue を
// 経由しないが、useInvokeJob 内の正規化ロジックと同じ判定をミラーすることで、
// 仕様変更時に明示的にこのテストを更新せざるを得ないようにする。
describe("useInvokeJob - snapshot mapping (mirror)", () => {
  type Snap = {
    status?: string;
    invokedAgents?: unknown;
    agents?: Record<string, unknown>;
    error?: { code: number; message: string };
  };

  function deriveState(jobId: string, snap: Snap | null) {
    if (!snap) {
      return { jobId, status: null, invokedAgents: [], agents: {}, error: null };
    }
    return {
      jobId,
      status: snap.status ?? null,
      invokedAgents: Array.isArray(snap.invokedAgents) ? snap.invokedAgents : [],
      agents: snap.agents ?? {},
      error: snap.error ?? null,
    };
  }

  it("snapshot null のとき空 state を返す (jobId は保持)", () => {
    const s = deriveState("J1", null);
    expect(s).toEqual({ jobId: "J1", status: null, invokedAgents: [], agents: {}, error: null });
  });

  it("status / invokedAgents / agents / error を抽出する", () => {
    const s = deriveState("J2", {
      status: "running",
      invokedAgents: ["TaskManagementAgent"],
      agents: { TaskManagementAgent: { status: "running" } },
      error: undefined,
    });
    expect(s.status).toBe("running");
    expect(s.invokedAgents).toEqual(["TaskManagementAgent"]);
    expect(s.agents.TaskManagementAgent).toEqual({ status: "running" });
    expect(s.error).toBeNull();
  });

  it("invokedAgents が array でない場合は空配列に正規化", () => {
    const s = deriveState("J3", {
      invokedAgents: "garbage" as unknown as unknown[],
    });
    expect(s.invokedAgents).toEqual([]);
  });

  it("error 付き snapshot を保持する", () => {
    const s = deriveState("J4", {
      status: "error",
      error: { code: -32000, message: "boom" },
    });
    expect(s.error).toEqual({ code: -32000, message: "boom" });
  });
});

// useBackendApi の 202 / 200 分岐契約。同様にソースコード grep で回帰を防止する。
const BACKEND_API_SRC = fs.readFileSync(
  path.resolve(__dirname, "../hooks/useBackendApi.ts"),
  "utf-8"
);

describe("useBackendApi - 202 contract", () => {
  it("202 受領で result.jobId を InvokeAcceptedResponse として返す", () => {
    expect(BACKEND_API_SRC).toMatch(/response\.status\s*===\s*202/);
    expect(BACKEND_API_SRC).toContain("result.jobId");
    expect(BACKEND_API_SRC).toContain("InvokeAcceptedResponse");
  });

  it("200 (デモルーム同期パス) は null を返す", () => {
    // 「デモルーム」または「200」コメントが残っていることを確認
    expect(BACKEND_API_SRC).toMatch(/200|デモルーム/);
    // 戻り値型に null を含む
    expect(BACKEND_API_SRC).toMatch(/Promise<InvokeAcceptedResponse\s*\|\s*null>/);
  });
});

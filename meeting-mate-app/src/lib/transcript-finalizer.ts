import { InteractionStatus } from "@google/genai";

interface TranscriptFinalizerOptions {
  onFinalize: (text: string) => void;
  schedule?: (fn: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createTranscriptFinalizer({
  onFinalize,
  schedule = (fn) => setTimeout(fn, 0),
  cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: TranscriptFinalizerOptions) {
  // Accumulate model text across spoken turns until the interaction is idle.
  let text = "";
  let pendingFinalize: { handle: unknown } | null = null;

  const cancelPendingFinalize = () => {
    if (pendingFinalize !== null) {
      cancel(pendingFinalize.handle);
      pendingFinalize = null;
    }
  };

  const finalize = () => {
    cancelPendingFinalize();
    if (text.trim()) {
      onFinalize(text);
    }
    text = "";
  };

  return {
    appendText(chunk: string): void {
      text += chunk;
    },

    onTurnComplete(): void {
      // 文字起こしの確定タイミング:
      //   同じ onmessage 内で turncomplete -> content -> interactionstatus が同期 emit される。
      //   実測では gemini-3.8-live / 2.5 native audio とも interactionStatus を送ってこないため、
      //   turnComplete で確定する必要がある。一方、裏で非同期ツール実行や推論が続いている場合は
      //   IN_PROGRESS が来るので、その時だけ確定を IDLE まで遅らせる。
      //   そのため turnComplete では一拍置いて最後の文字起こしを受け取り、同じメッセージの
      //   interactionStatus に取り消す機会を与える。
      cancelPendingFinalize();
      pendingFinalize = { handle: schedule(finalize) };
    },

    onInteractionStatus(status: InteractionStatus): void {
      if (status === InteractionStatus.IDLE || status === InteractionStatus.REQUIRES_ACTION) {
        finalize();
      } else if (status === InteractionStatus.IN_PROGRESS) {
        // 裏で処理が続いている間は確定しない（IDLE を待つ）。
        cancelPendingFinalize();
      }
      // Unspecified or unknown statuses keep the turnComplete fallback.
    },

    dispose(): void {
      // Discard at session boundaries: writing back to a deleted session creates
      // a ghost session. Interim until Issue #164 moves RTDB writes to the server.
      cancelPendingFinalize();
      text = "";
    },
  };
}

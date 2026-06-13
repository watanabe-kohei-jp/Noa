// meeting-mate-app/src/hooks/useBackendApi.ts
// Issue #129: /invoke は 202 Accepted + {jobId} を返すパターンに変更。
// 結果と進捗は呼び出し側が useInvokeJob で RTDB を購読して受け取る。
// デモルームのみ従来通り 200 + AgentResult(invokedAgents=[]) で同期完結する。
import { useCallback } from 'react';
import { TranscriptEntry, generateUniqueId } from '@/types/data';
import { authFetch } from '../lib/api-client';

export interface InvokeAcceptedResponse {
  jobId: string;
  status: 'queued';
}

interface UseBackendApiResult {
  callBackendApi: (
    newestEntry: TranscriptEntry,
    currentRoomId: string,
    pageCurrentUser: { id: string; name: string } | null,
    sessionId?: string | null
  ) => Promise<InvokeAcceptedResponse | null>;
}

interface JsonRpcEnvelope<T = Record<string, unknown>> {
  jsonrpc?: string;
  result?: T;
  error?: { code?: string | number; message?: string };
  id?: string;
}

export const useBackendApi = (): UseBackendApiResult => {
  const callBackendApi = useCallback(
    async (
      newestEntry: TranscriptEntry,
      currentRoomId: string,
      pageCurrentUser: { id: string; name: string } | null,
      sessionId?: string | null
    ): Promise<InvokeAcceptedResponse | null> => {
      if (!currentRoomId || !pageCurrentUser) {
        throw new Error('Room ID or User not available for API call');
      }
      const requestBody = {
        jsonrpc: '2.0',
        method: 'ExecuteTask',
        params: {
          task: {
            taskId: generateUniqueId(),
            messages: [{ role: 'user', parts: [{ text: newestEntry.text }] }],
            roomId: currentRoomId,
            sessionId: sessionId || null,
            speakerId: newestEntry.userId,
            speakerName: newestEntry.userName || newestEntry.userId,
          },
        },
        id: generateUniqueId(),
      };

      const fullUrl = `/invoke`;
      const response = await authFetch(fullUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData: Record<string, unknown> | null = null;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          // JSON 解析不可 → errorData は null のまま
        }

        if (errorData && typeof errorData === 'object') {
          const errObj = errorData as {
            error?: { message?: string };
            detail?: string;
          };
          if (errObj.error?.message) {
            throw new Error(`APIエラー ${response.status}: ${errObj.error.message}`);
          }
          if (errObj.detail) {
            throw new Error(`APIエラー ${response.status}: ${errObj.detail}`);
          }
          throw new Error(`APIエラー ${response.status}: ${JSON.stringify(errorData)}`);
        }
        throw new Error(`APIエラー ${response.status}: ${errorText}`);
      }

      const responseText = await response.text();
      let envelope: JsonRpcEnvelope;
      try {
        envelope = JSON.parse(responseText);
      } catch {
        console.error(
          'Failed to parse API response as JSON:',
          responseText.substring(0, 200)
        );
        throw new Error('APIレスポンスの解析に失敗しました');
      }

      if (envelope.error) {
        const errorMessage = envelope.error.message || 'Unknown error occurred';
        const errorCode = envelope.error.code ?? 'UNKNOWN';
        throw new Error(`APIエラー [${errorCode}]: ${errorMessage}`);
      }

      // 202 Accepted: result = { jobId, status: "queued" }
      if (response.status === 202) {
        const result = envelope.result as { jobId?: string; status?: string } | undefined;
        if (!result || typeof result.jobId !== 'string') {
          throw new Error('APIエラー: 202 レスポンスに jobId が含まれていません');
        }
        return { jobId: result.jobId, status: 'queued' };
      }

      // 200: デモルーム同期パス (AgentResult)。jobId は無いので null を返し、
      // 呼び出し側は AI 処理が走らなかったとみなす。
      return null;
    },
    []
  );

  return { callBackendApi };
};

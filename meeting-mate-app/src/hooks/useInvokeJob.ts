// meeting-mate-app/src/hooks/useInvokeJob.ts
// Issue #129: /invoke の job レコード (rooms/{roomId}/jobs/{jobId}) を購読し、
// status / invokedAgents / per-agent 進捗 / error を返すフック。
import { useEffect, useState } from 'react';
import { ref, onValue } from 'firebase/database';
import { database as db } from '@/firebase';

export type InvokeJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface InvokeJobAgentStatus {
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

export interface InvokeJobError {
  code: number;
  message: string;
}

export interface InvokeJobState {
  // 現在 state がどの jobId に対応するか。null = 未購読。
  // consumer はこれと自身の activeJobId を比較してスタール検知する。
  jobId: string | null;
  status: InvokeJobStatus | null;
  invokedAgents: string[];
  agents: Record<string, InvokeJobAgentStatus>;
  error: InvokeJobError | null;
}

const EMPTY_STATE: InvokeJobState = {
  jobId: null,
  status: null,
  invokedAgents: [],
  agents: {},
  error: null,
};

const emptyForJob = (jobId: string | null): InvokeJobState => ({
  ...EMPTY_STATE,
  jobId,
});

export const useInvokeJob = (
  roomId: string | null,
  jobId: string | null
): InvokeJobState => {
  const [state, setState] = useState<InvokeJobState>(EMPTY_STATE);

  useEffect(() => {
    if (!roomId || !jobId) {
      setState(EMPTY_STATE);
      return;
    }

    const firebaseDb = db();
    if (!firebaseDb) {
      return;
    }

    // jobId 切替時は即座に新 jobId 用の空 state にリセット (スタール検知用)
    setState(emptyForJob(jobId));

    const jobRef = ref(firebaseDb, `rooms/${roomId}/jobs/${jobId}`);
    const unsubscribe = onValue(
      jobRef,
      (snapshot) => {
        const data = snapshot.val() as
          | {
              status?: InvokeJobStatus;
              invokedAgents?: string[];
              agents?: Record<string, InvokeJobAgentStatus>;
              error?: InvokeJobError;
            }
          | null;
        if (!data) {
          setState(emptyForJob(jobId));
          return;
        }
        setState({
          jobId,
          status: data.status ?? null,
          invokedAgents: Array.isArray(data.invokedAgents) ? data.invokedAgents : [],
          agents: data.agents ?? {},
          error: data.error ?? null,
        });
      },
      (err) => {
        console.error('[useInvokeJob] subscribe error:', err);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [roomId, jobId]);

  return state;
};

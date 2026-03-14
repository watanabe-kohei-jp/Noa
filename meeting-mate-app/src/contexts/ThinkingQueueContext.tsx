"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

export interface ThinkingTask {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  model?: string;
  startedAt: number;
  completedAt?: number;
  elapsed_ms?: number;
  error?: string;
}

interface ThinkingQueueContextValue {
  tasks: ThinkingTask[];
  isActive: boolean;
  addTask: (task: Omit<ThinkingTask, "startedAt" | "status"> & { status?: ThinkingTask["status"] }) => void;
  updateTask: (id: string, update: Partial<ThinkingTask>) => void;
  clear: () => void;
}

const ThinkingQueueContext = createContext<ThinkingQueueContextValue | null>(null);

export function ThinkingQueueProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<ThinkingTask[]>([]);

  const addTask = useCallback((task: Omit<ThinkingTask, "startedAt" | "status"> & { status?: ThinkingTask["status"] }) => {
    setTasks((prev) => {
      const nextStatus = task.status || "running";
      const now = Date.now();
      const nextTask: ThinkingTask = {
        ...task,
        status: nextStatus,
        startedAt: now,
        completedAt: nextStatus === "running" ? undefined : now,
      };

      const existingIndex = prev.findIndex((t) => t.id === task.id);
      if (existingIndex === -1) {
        return [...prev, nextTask];
      }

      return prev.map((t, index) =>
        index === existingIndex
          ? {
              ...t,
              ...nextTask,
              startedAt: t.startedAt,
              // running に戻す場合は completedAt をクリア
              completedAt: nextStatus === "running" ? undefined : (nextTask.completedAt ?? t.completedAt),
            }
          : t
      );
    });
  }, []);

  const updateTask = useCallback((id: string, update: Partial<ThinkingTask>) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;

        const nextStatus = update.status ?? t.status;
        const isTerminal = nextStatus === "completed" || nextStatus === "error";

        return {
          ...t,
          ...update,
          completedAt:
            update.completedAt ??
            (isTerminal ? t.completedAt ?? Date.now() : undefined),
        };
      })
    );
  }, []);

  const clear = useCallback(() => setTasks([]), []);

  const isActive = tasks.some((t) => t.status === "running");

  return (
    <ThinkingQueueContext.Provider value={{ tasks, isActive, addTask, updateTask, clear }}>
      {children}
    </ThinkingQueueContext.Provider>
  );
}

export function useThinkingQueue() {
  const ctx = useContext(ThinkingQueueContext);
  if (!ctx) throw new Error("useThinkingQueue must be used within ThinkingQueueProvider");
  return ctx;
}

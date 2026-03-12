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
    setTasks((prev) => [
      ...prev,
      { ...task, status: task.status || "running", startedAt: Date.now() },
    ]);
  }, []);

  const updateTask = useCallback((id: string, update: Partial<ThinkingTask>) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...update } : t))
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

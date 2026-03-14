"use client";

import React, { useState, useEffect, useRef } from "react";
import { Loader2, Check, X, Brain, Search } from "lucide-react";
import { useThinkingQueue, type ThinkingTask } from "../../contexts/ThinkingQueueContext";

/* ------------------------------------------------------------------ */
/*  Elapsed time display helper                                        */
/* ------------------------------------------------------------------ */

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ */
/*  Status icon per task                                               */
/* ------------------------------------------------------------------ */

function TaskStatusIcon({ status }: { status: ThinkingTask["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 size={12} className="animate-spin text-blue-400" />;
    case "completed":
      return <Check size={12} className="text-green-400" />;
    case "error":
      return <X size={12} className="text-red-400" />;
  }
}

/* ------------------------------------------------------------------ */
/*  Label icon - Brain for analysis, Search for others                 */
/* ------------------------------------------------------------------ */

function TaskLabelIcon({ label }: { label: string }) {
  const isBrain = /分析|analysis|brain|opus|deep/i.test(label);
  if (isBrain) {
    return <Brain size={12} className="text-purple-400 flex-shrink-0" />;
  }
  return <Search size={12} className="text-cyan-400 flex-shrink-0" />;
}

/* ------------------------------------------------------------------ */
/*  Single task row                                                    */
/* ------------------------------------------------------------------ */

function TaskRow({ task, now }: { task: ThinkingTask; now: number }) {
  const elapsed =
    task.elapsed_ms ??
    (task.completedAt
      ? task.completedAt - task.startedAt
      : now - task.startedAt);

  return (
    <div className="flex items-center gap-2 text-xs leading-tight py-0.5">
      <TaskLabelIcon label={task.label} />
      <span className="flex-1 truncate text-gray-200">
        {task.label}
        {task.model && (
          <span className="text-gray-500 ml-1">({task.model})</span>
        )}
      </span>
      <TaskStatusIcon status={task.status} />
      <span
        className={`w-12 text-right tabular-nums ${
          task.status === "running" ? "text-yellow-400" : "text-gray-400"
        }`}
      >
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ThinkingQueuePanel                                                 */
/* ------------------------------------------------------------------ */

export default function ThinkingQueuePanel() {
  const { tasks, isActive, clear } = useThinkingQueue();
  const [now, setNow] = useState(Date.now());
  const [visible, setVisible] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live elapsed time ticker (100ms)
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isActive]);

  // Show/hide logic
  useEffect(() => {
    if (tasks.length > 0) {
      setVisible(true);
      // Cancel any pending auto-clear
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    }
  }, [tasks.length]);

  // Auto-clear 3s after all tasks complete
  useEffect(() => {
    if (tasks.length > 0 && !isActive) {
      clearTimerRef.current = setTimeout(() => {
        setVisible(false);
        // Small delay for fade-out before clearing data
        setTimeout(() => clear(), 300);
      }, 3000);
      return () => {
        if (clearTimerRef.current) {
          clearTimeout(clearTimerRef.current);
          clearTimerRef.current = null;
        }
      };
    }
  }, [tasks.length, isActive, clear]);

  if (!visible || tasks.length === 0) return null;

  return (
    <div
      className={`
        rounded-lg border border-gray-700/50 bg-gray-900/90 backdrop-blur-sm
        px-3 py-2 shadow-lg
        transition-all duration-300 ease-in-out
        ${isActive ? "opacity-100" : "opacity-70"}
      `}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-1 text-[10px] font-medium text-gray-400 uppercase tracking-wider">
        <Brain size={10} className="text-purple-400" />
        Noa&apos;s thinking
      </div>

      {/* Task list */}
      <div className="space-y-0">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} now={now} />
        ))}
      </div>
    </div>
  );
}

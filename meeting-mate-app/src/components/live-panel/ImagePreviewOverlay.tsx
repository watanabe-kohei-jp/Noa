"use client";

import React, { useEffect, useState } from "react";
import { X, Send, Check, AlertCircle } from "lucide-react";

type PreviewStatus = "pending" | "sent" | "error";

interface ImagePreviewOverlayProps {
  previewUrl: string | null;
  status: PreviewStatus;
  errorMessage?: string;
  onSend: () => void;
  onCancel: () => void;
}

export default function ImagePreviewOverlay({
  previewUrl,
  status,
  errorMessage,
  onSend,
  onCancel,
}: ImagePreviewOverlayProps) {
  const [visible, setVisible] = useState(true);

  // Auto-dismiss after send success
  useEffect(() => {
    if (status !== "sent") return;
    const timer = setTimeout(() => {
      setVisible(false);
      onCancel(); // cleanup
    }, 3000);
    return () => clearTimeout(timer);
  }, [status, onCancel]);

  if (!previewUrl || !visible) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-30">
      <div className="mx-2 p-3 rounded-xl bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-lg backdrop-blur-sm flex items-center gap-3">
        {/* Thumbnail */}
        <img
          src={previewUrl}
          alt="添付画像プレビュー"
          className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-600 flex-shrink-0"
        />

        {/* Status / Actions */}
        <div className="flex-1 min-w-0">
          {status === "pending" && (
            <p className="text-sm text-gray-600 dark:text-gray-300 truncate">
              画像を Live AI に送信しますか？
            </p>
          )}
          {status === "sent" && (
            <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
              <Check size={14} />
              送信済み — 音声で質問してください
            </p>
          )}
          {status === "error" && (
            <p className="text-sm text-red-500 flex items-center gap-1">
              <AlertCircle size={14} />
              {errorMessage || "送信に失敗しました"}
            </p>
          )}
        </div>

        {/* Buttons */}
        {status === "pending" && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onSend}
              className="p-2 rounded-lg bg-teal-500 hover:bg-teal-600 text-white transition"
              title="送信"
            >
              <Send size={14} />
            </button>
            <button
              onClick={onCancel}
              className="p-2 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300 transition"
              title="キャンセル"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Close button for error/sent states */}
        {status !== "pending" && (
          <button
            onClick={onCancel}
            className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition flex-shrink-0"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

"use client";

import React, { useEffect, useRef } from "react";

export interface LiveChatMessage {
  role: "user" | "model";
  text: string;
  timestamp: Date;
}

interface LiveChatDisplayProps {
  messages: LiveChatMessage[];
}

export default function LiveChatDisplay({ messages }: LiveChatDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        <p>会話を開始すると、ここにトランスクリプトが表示されます</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 overflow-y-auto h-full">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
              msg.role === "user"
                ? "bg-blue-500 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            }`}
          >
            <div className="text-xs opacity-60 mb-0.5">
              {msg.role === "user" ? "あなた" : "Noa"}
            </div>
            <div className="whitespace-pre-wrap">{msg.text}</div>
          </div>
        </div>
      ))}
      <div ref={scrollRef} />
    </div>
  );
}

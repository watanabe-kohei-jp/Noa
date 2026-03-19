"use client";

import React from "react";
import {
  Lightbulb,
  AlertTriangle,
  Database,
  Scale,
  FileText,
  X,
} from "lucide-react";
import type { ProactiveSuggestion } from "../../hooks/useProactiveMonitor";

const ACTION_ICONS: Record<string, React.ReactNode> = {
  fact_check: <AlertTriangle size={14} />,
  data_available: <Database size={14} />,
  decision_support: <Scale size={14} />,
  risk_alert: <AlertTriangle size={14} />,
  summary_offer: <FileText size={14} />,
};

interface ProactiveSuggestionBannerProps {
  suggestion: ProactiveSuggestion | null;
  onDismiss: () => void;
}

export default function ProactiveSuggestionBanner({
  suggestion,
  onDismiss,
}: ProactiveSuggestionBannerProps) {
  if (!suggestion) return null;

  const icon = ACTION_ICONS[suggestion.actionType] || <Lightbulb size={14} />;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50 animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className="mx-2 px-3 py-2 rounded-lg bg-amber-900/80 backdrop-blur-sm border border-amber-700/50 text-amber-100 text-xs shadow-lg">
        <div className="flex items-start gap-2">
          <span className="flex-shrink-0 mt-0.5 text-amber-400">{icon}</span>
          <p className="flex-1 leading-relaxed">{suggestion.suggestion}</p>
          <button
            onClick={onDismiss}
            className="flex-shrink-0 p-0.5 hover:bg-amber-800/50 rounded transition-colors"
            title="閉じる"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import React from "react";
import { AlertTriangle, Database, Scale, FileText, X } from "lucide-react";
import type { ProactiveSuggestion } from "../../hooks/useProactiveMonitor";

const ACTION_ICONS: Record<string, React.ElementType> = {
  fact_check: AlertTriangle,
  data_available: Database,
  decision_support: Scale,
  risk_alert: AlertTriangle,
  summary_offer: FileText,
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

  const Icon = ACTION_ICONS[suggestion.actionType] || AlertTriangle;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50 animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className="mx-2 flex items-start gap-2 rounded-lg border border-amber-700/50 bg-amber-900/80 px-3 py-2 text-amber-100 shadow-lg backdrop-blur-sm">
        <Icon size={16} className="mt-0.5 flex-shrink-0 text-amber-400" />
        <span className="flex-1 text-xs leading-relaxed">
          {suggestion.suggestion}
        </span>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-0.5 hover:bg-amber-800/50 transition-colors"
          title="閉じる"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * 統合会議レポートフォーマッター
 * 全データをまとめた Markdown / JSON を生成
 */

import type { TranscriptEntry, TodoItem, NoteItem, CurrentAgenda, OverviewDiagramData, CalendarLinkItem } from '@/types/data';
import {
  formatTranscriptAsMarkdown, formatTranscriptAsJson,
  formatTasksAsMarkdown, formatTasksAsJson,
  formatNotesAsMarkdown, formatNotesAsJson,
  formatAgendaAsMarkdown, formatAgendaAsJson,
  formatCalendarLinksAsMarkdown, formatCalendarLinksAsJson,
} from './text-export';

export interface ReportData {
  sessionName?: string;
  roomTitle?: string;
  exportedAt: string;
  transcript: TranscriptEntry[];
  tasks: TodoItem[];
  notes: NoteItem[];
  currentAgenda: CurrentAgenda | null;
  suggestedNextTopics: string[];
  overviewDiagram: OverviewDiagramData | null;
  calendarLinks: CalendarLinkItem[];
}

/** 統合 Markdown レポートを生成 */
export function formatReportAsMarkdown(data: ReportData): string {
  const lines: string[] = [];

  // ヘッダー
  lines.push(`# 会議レポート${data.roomTitle ? `: ${data.roomTitle}` : ''}`);
  lines.push('');
  if (data.sessionName) lines.push(`**セッション**: ${data.sessionName}`);
  lines.push(`**エクスポート日時**: ${data.exportedAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 議題
  lines.push(formatAgendaAsMarkdown(data.currentAgenda, data.suggestedNextTopics));
  lines.push('---');
  lines.push('');

  // 概要図 (Mermaid コードブロックで埋め込み)
  if (data.overviewDiagram?.mermaidDefinition) {
    lines.push('# 概要図\n');
    lines.push(`**${data.overviewDiagram.title || '概要図'}**\n`);
    lines.push('```mermaid');
    lines.push(data.overviewDiagram.mermaidDefinition);
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // タスク
  lines.push(formatTasksAsMarkdown(data.tasks));
  lines.push('---');
  lines.push('');

  // ノート
  lines.push(formatNotesAsMarkdown(data.notes));
  lines.push('---');
  lines.push('');

  // カレンダーリンク
  lines.push(formatCalendarLinksAsMarkdown(data.calendarLinks));
  lines.push('---');
  lines.push('');

  // トランスクリプト
  lines.push(formatTranscriptAsMarkdown(data.transcript));

  return lines.join('\n');
}

/** 統合 JSON レポートを生成 (allowlist ベース) */
export function formatReportAsJson(data: ReportData): object {
  return {
    meta: {
      sessionName: data.sessionName || null,
      roomTitle: data.roomTitle || null,
      exportedAt: data.exportedAt,
    },
    agenda: formatAgendaAsJson(data.currentAgenda, data.suggestedNextTopics),
    overviewDiagram: data.overviewDiagram ? {
      title: data.overviewDiagram.title,
      mermaidDefinition: data.overviewDiagram.mermaidDefinition,
    } : null,
    tasks: formatTasksAsJson(data.tasks),
    notes: formatNotesAsJson(data.notes),
    calendarLinks: formatCalendarLinksAsJson(data.calendarLinks),
    transcript: formatTranscriptAsJson(data.transcript),
  };
}

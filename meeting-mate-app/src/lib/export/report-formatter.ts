/**
 * 統合会議レポートフォーマッター
 * 全データをまとめた Markdown / JSON を生成
 */

import type { TranscriptEntry, TodoItem, NoteItem, CurrentAgenda, OverviewDiagramData, OverviewDiagramEntry, CalendarLinkItem } from '@/types/data';
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
  /** 旧 1 図 (Issue #131 互換のため残置)。overviewDiagrams が空の時のみ参照 */
  overviewDiagram: OverviewDiagramData | null;
  /** 論点単位の図リスト (Issue #131)。空配列なら overviewDiagram にフォールバック */
  overviewDiagrams?: OverviewDiagramEntry[];
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
  // Issue #131: overviewDiagrams が空でなければ全件、空なら legacy 1 件
  const diagramList: Array<{ title: string; mermaidDefinition: string; status?: string }> = [];
  if (data.overviewDiagrams && data.overviewDiagrams.length > 0) {
    for (const d of data.overviewDiagrams) {
      if (d.mermaidDefinition) {
        diagramList.push({ title: d.title, mermaidDefinition: d.mermaidDefinition, status: d.status });
      }
    }
  } else if (data.overviewDiagram?.mermaidDefinition) {
    diagramList.push({ title: data.overviewDiagram.title || '概要図', mermaidDefinition: data.overviewDiagram.mermaidDefinition });
  }
  if (diagramList.length > 0) {
    lines.push('# 概要図\n');
    for (const d of diagramList) {
      const closedBadge = d.status === 'closed' ? ' (完了)' : '';
      lines.push(`**${d.title || '概要図'}${closedBadge}**\n`);
      lines.push('```mermaid');
      lines.push(d.mermaidDefinition);
      lines.push('```');
      lines.push('');
    }
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
    // Issue #131: 新スキーマで N 件出力。空なら legacy 1 件にフォールバック
    overviewDiagrams: data.overviewDiagrams && data.overviewDiagrams.length > 0
      ? data.overviewDiagrams.map(d => ({
          topicId: d.topicId,
          title: d.title,
          mermaidDefinition: d.mermaidDefinition,
          status: d.status,
          createdAt: d.createdAt,
          lastUpdated: d.lastUpdated,
        }))
      : (data.overviewDiagram ? [{
          topicId: 'legacy',
          title: data.overviewDiagram.title,
          mermaidDefinition: data.overviewDiagram.mermaidDefinition,
          status: 'active' as const,
        }] : []),
    tasks: formatTasksAsJson(data.tasks),
    notes: formatNotesAsJson(data.notes),
    calendarLinks: formatCalendarLinksAsJson(data.calendarLinks),
    transcript: formatTranscriptAsJson(data.transcript),
  };
}

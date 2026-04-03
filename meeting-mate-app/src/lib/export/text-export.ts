/**
 * テキストデータのエクスポート (Markdown / CSV / JSON)
 *
 * CSV: BOM付きUTF-8 + 式注入対策 (RFC 4180 準拠)
 * JSON: allowlist ベース (内部メタデータ除外)
 */

import { downloadText, sanitizeFileName, getTimestamp } from './download-utils';
import type { TranscriptEntry, TodoItem, NoteItem, CurrentAgenda } from '@/types/data';

// ============================================================
// CSV セキュリティ: 式注入対策
// ============================================================

/** CSV セル値のサニタイズ: 式注入対策 + RFC 4180 エスケープ */
function sanitizeCsvCell(value: string): string {
  let sanitized = value;
  // 式注入対策: =, +, -, @ で始まるセルに ' を前置
  if (/^[=+\-@]/.test(sanitized)) {
    sanitized = `'${sanitized}`;
  }
  // RFC 4180: ダブルクォート、カンマ、改行を含む場合はクォート
  if (sanitized.includes('"') || sanitized.includes(',') || sanitized.includes('\n') || sanitized.includes('\r')) {
    sanitized = `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

/** CSV 行を生成 */
function csvRow(cells: string[]): string {
  return cells.map(sanitizeCsvCell).join(',');
}

/** BOM 付き CSV をダウンロード */
function downloadCsv(content: string, fileName: string): void {
  const bom = '\uFEFF';
  downloadText(bom + content, fileName, 'text/csv');
}

// ============================================================
// トランスクリプト
// ============================================================

export function formatTranscriptAsMarkdown(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return '# トランスクリプト\n\nデータがありません。\n';
  const lines = ['# トランスクリプト\n'];
  for (const e of entries) {
    const speaker = e.speakerLabel || e.userName || e.userId || '不明';
    const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ja-JP') : '';
    lines.push(`**${speaker}** ${time ? `(${time})` : ''}`);
    lines.push(`${e.text}\n`);
  }
  return lines.join('\n');
}

export function formatTranscriptAsJson(entries: TranscriptEntry[]): object[] {
  return entries.map(e => ({
    speaker: e.speakerLabel || e.userName || e.userId || '不明',
    text: e.text,
    timestamp: e.timestamp,
    source: e.source,
    origin: e.origin,
  }));
}

// ============================================================
// タスク
// ============================================================

const STATUS_LABELS: Record<string, string> = { todo: '未着手', doing: '進行中', done: '完了' };
const PRIORITY_LABELS: Record<string, string> = { high: '高', medium: '中', low: '低' };

export function formatTasksAsMarkdown(tasks: TodoItem[]): string {
  if (tasks.length === 0) return '# タスク\n\nタスクがありません。\n';
  const lines = ['# タスク\n'];
  for (const t of tasks) {
    const checkbox = t.status === 'done' ? '[x]' : '[ ]';
    const priority = t.priority ? ` (${PRIORITY_LABELS[t.priority] || t.priority})` : '';
    const assignee = t.assignee ? ` @${t.assignee}` : '';
    const due = t.dueDate ? ` 〆${t.dueDate}` : '';
    lines.push(`- ${checkbox} ${t.title}${priority}${assignee}${due}`);
    if (t.detail) lines.push(`  ${t.detail}`);
  }
  return lines.join('\n') + '\n';
}

export function formatTasksAsCsv(tasks: TodoItem[]): string {
  const header = csvRow(['タイトル', 'ステータス', '優先度', '担当者', '期限', '詳細']);
  const rows = tasks.map(t => csvRow([
    t.title,
    STATUS_LABELS[t.status] || t.status,
    t.priority ? (PRIORITY_LABELS[t.priority] || t.priority) : '',
    t.assignee || '',
    t.dueDate || '',
    t.detail || '',
  ]));
  return [header, ...rows].join('\n');
}

export function formatTasksAsJson(tasks: TodoItem[]): object[] {
  return tasks.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee,
    dueDate: t.dueDate,
    detail: t.detail,
  }));
}

// ============================================================
// ノート
// ============================================================

const NOTE_TYPE_LABELS: Record<string, string> = { memo: 'メモ', decision: '決定事項', issue: '課題' };
const NOTE_TYPE_ICONS: Record<string, string> = { memo: '📝', decision: '✅', issue: '⚠️' };

export function formatNotesAsMarkdown(notes: NoteItem[]): string {
  if (notes.length === 0) return '# ノート\n\nノートがありません。\n';
  const lines = ['# ノート\n'];

  // タイプ別にグループ化
  const grouped: Record<string, NoteItem[]> = {};
  for (const n of notes) {
    const type = n.type || 'memo';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(n);
  }

  for (const [type, items] of Object.entries(grouped)) {
    const label = NOTE_TYPE_LABELS[type] || type;
    const icon = NOTE_TYPE_ICONS[type] || '';
    lines.push(`## ${icon} ${label}\n`);
    for (const n of items) {
      lines.push(`- ${n.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatNotesAsCsv(notes: NoteItem[]): string {
  const header = csvRow(['タイプ', 'テキスト', 'タイムスタンプ']);
  const rows = notes.map(n => csvRow([
    NOTE_TYPE_LABELS[n.type] || n.type,
    n.text,
    n.timestamp ? new Date(n.timestamp).toLocaleString('ja-JP') : '',
  ]));
  return [header, ...rows].join('\n');
}

export function formatNotesAsJson(notes: NoteItem[]): object[] {
  return notes.map(n => ({
    id: n.id,
    type: n.type,
    text: n.text,
    timestamp: n.timestamp,
  }));
}

// ============================================================
// 議題
// ============================================================

export function formatAgendaAsMarkdown(agenda: CurrentAgenda | null, suggestedTopics?: string[]): string {
  const lines = ['# 議題\n'];
  if (agenda?.mainTopic) {
    lines.push(`## 現在の議題\n`);
    lines.push(`**${agenda.mainTopic}**\n`);
    if (agenda.details && agenda.details.length > 0) {
      for (const d of agenda.details) {
        lines.push(`- ${d.text}`);
      }
      lines.push('');
    }
  } else {
    lines.push('現在の議題はありません。\n');
  }

  if (suggestedTopics && suggestedTopics.length > 0) {
    lines.push('## 提案される次の議題\n');
    for (const t of suggestedTopics) {
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatAgendaAsJson(agenda: CurrentAgenda | null, suggestedTopics?: string[]): object {
  return {
    currentAgenda: agenda ? {
      mainTopic: agenda.mainTopic,
      details: agenda.details?.map(d => ({ id: d.id, text: d.text })) || [],
    } : null,
    suggestedNextTopics: suggestedTopics || [],
  };
}

// ============================================================
// エクスポート実行関数
// ============================================================

export type TextExportTarget = 'transcript' | 'tasks' | 'notes' | 'agenda' | 'suggestedTopics';
export type TextExportFormat = 'markdown' | 'csv' | 'json';

interface ExportData {
  transcript?: TranscriptEntry[];
  tasks?: TodoItem[];
  notes?: NoteItem[];
  currentAgenda?: CurrentAgenda | null;
  suggestedNextTopics?: string[];
}

export function exportTextData(
  target: TextExportTarget,
  format: TextExportFormat,
  data: ExportData,
  sessionName?: string,
): void {
  const prefix = sanitizeFileName(sessionName || 'session');
  const ts = getTimestamp();

  let content: string;
  let fileName: string;

  switch (target) {
    case 'transcript': {
      const entries = data.transcript || [];
      if (format === 'markdown') {
        content = formatTranscriptAsMarkdown(entries);
        fileName = `${prefix}_transcript_${ts}.md`;
        downloadText(content, fileName, 'text/markdown');
      } else {
        content = JSON.stringify(formatTranscriptAsJson(entries), null, 2);
        fileName = `${prefix}_transcript_${ts}.json`;
        downloadText(content, fileName, 'application/json');
      }
      return;
    }
    case 'tasks': {
      const tasks = data.tasks || [];
      if (format === 'markdown') {
        content = formatTasksAsMarkdown(tasks);
        fileName = `${prefix}_tasks_${ts}.md`;
        downloadText(content, fileName, 'text/markdown');
      } else if (format === 'csv') {
        content = formatTasksAsCsv(tasks);
        fileName = `${prefix}_tasks_${ts}.csv`;
        downloadCsv(content, fileName);
      } else {
        content = JSON.stringify(formatTasksAsJson(tasks), null, 2);
        fileName = `${prefix}_tasks_${ts}.json`;
        downloadText(content, fileName, 'application/json');
      }
      return;
    }
    case 'notes': {
      const notes = data.notes || [];
      if (format === 'markdown') {
        content = formatNotesAsMarkdown(notes);
        fileName = `${prefix}_notes_${ts}.md`;
        downloadText(content, fileName, 'text/markdown');
      } else if (format === 'csv') {
        content = formatNotesAsCsv(notes);
        fileName = `${prefix}_notes_${ts}.csv`;
        downloadCsv(content, fileName);
      } else {
        content = JSON.stringify(formatNotesAsJson(notes), null, 2);
        fileName = `${prefix}_notes_${ts}.json`;
        downloadText(content, fileName, 'application/json');
      }
      return;
    }
    case 'agenda':
    case 'suggestedTopics': {
      if (format === 'markdown') {
        content = formatAgendaAsMarkdown(data.currentAgenda || null, data.suggestedNextTopics);
        fileName = `${prefix}_agenda_${ts}.md`;
        downloadText(content, fileName, 'text/markdown');
      } else {
        content = JSON.stringify(formatAgendaAsJson(data.currentAgenda || null, data.suggestedNextTopics), null, 2);
        fileName = `${prefix}_agenda_${ts}.json`;
        downloadText(content, fileName, 'application/json');
      }
      return;
    }
  }
}

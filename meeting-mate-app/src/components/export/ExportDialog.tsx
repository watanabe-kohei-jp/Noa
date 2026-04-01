'use client';

import React, { useState } from 'react';
import { X, FileDown } from 'lucide-react';
import { themes } from '@/constants/themes';
import { downloadText, sanitizeFileName, getTimestamp } from '@/lib/export/download-utils';
import { formatReportAsMarkdown, formatReportAsJson } from '@/lib/export/report-formatter';
import type { ReportData } from '@/lib/export/report-formatter';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: typeof themes.dark;
  reportData: ReportData;
}

type ReportFormat = 'markdown' | 'json';

const ExportDialog: React.FC<ExportDialogProps> = ({ isOpen, onClose, currentTheme, reportData }) => {
  const [isExporting, setIsExporting] = useState(false);

  if (!isOpen) return null;

  const isDark = currentTheme === themes.dark || currentTheme === themes.modern;

  const handleExport = async (format: ReportFormat) => {
    setIsExporting(true);
    try {
      const prefix = sanitizeFileName(reportData.sessionName || 'meeting-report');
      const ts = getTimestamp();

      if (format === 'markdown') {
        const content = formatReportAsMarkdown(reportData);
        downloadText(content, `${prefix}_report_${ts}.md`, 'text/markdown');
      } else {
        const content = JSON.stringify(formatReportAsJson(reportData), null, 2);
        downloadText(content, `${prefix}_report_${ts}.json`, 'application/json');
      }
      onClose();
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const formatOptions: { format: ReportFormat; label: string; description: string }[] = [
    { format: 'markdown', label: 'Markdown', description: '議題・概要図・タスク・ノート・トランスクリプトを1つのファイルに' },
    { format: 'json', label: 'JSON', description: '構造化データとして出力（プログラム連携用）' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`relative w-full max-w-md mx-4 rounded-2xl shadow-2xl border p-6
          ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            会議レポートをエクスポート
          </h2>
          <button onClick={onClose} className={`p-1 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}>
            <X className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          </button>
        </div>

        {/* セッション情報 */}
        <div className={`mb-4 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          {reportData.sessionName && <p>セッション: {reportData.sessionName}</p>}
          <p>エクスポート日時: {reportData.exportedAt}</p>
        </div>

        {/* データサマリー */}
        <div className={`mb-5 p-3 rounded-lg text-sm ${isDark ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
          <p className={`font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>含まれるデータ:</p>
          <ul className={`space-y-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <li>トランスクリプト: {reportData.transcript.length} 件</li>
            <li>タスク: {reportData.tasks.length} 件</li>
            <li>ノート: {reportData.notes.length} 件</li>
            <li>概要図: {reportData.overviewDiagram ? 'あり' : 'なし'}</li>
            <li>議題: {reportData.currentAgenda?.mainTopic ? 'あり' : 'なし'}</li>
          </ul>
        </div>

        {/* フォーマット選択 */}
        <div className="space-y-2">
          {formatOptions.map((opt) => (
            <button
              key={opt.format}
              onClick={() => handleExport(opt.format)}
              disabled={isExporting}
              className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-all
                ${isDark
                  ? 'hover:bg-gray-700 border border-gray-700'
                  : 'hover:bg-gray-50 border border-gray-200'
                }
                ${isExporting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <FileDown className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-blue-400' : 'text-blue-500'}`} />
              <div>
                <p className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{opt.label}</p>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{opt.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;

import React from 'react';
import { GripVertical, EyeOff } from 'lucide-react';
import { getPanelConfig } from '@/app/room/constants/panelConfig';
import { themes } from '@/constants/themes';
import { ParticipantEntry, NoteItem, TodoItem, CurrentAgenda, OverviewDiagramData, PanelId, TranscriptEntry, SpeakerMap } from '@/types/data';
import type { MermaidDiagramHandle } from '@/app/room/components/MermaidDiagram';
import ExportDropdown from '@/components/export/ExportDropdown';
import type { ExportOption } from '@/components/export/ExportDropdown';

interface PanelProps {
  id: PanelId;
  idx: number;
  participants: ParticipantEntry[];
  transcripts: TranscriptEntry[];
  notes: NoteItem[];
  tasks: TodoItem[];
  currentAgenda: CurrentAgenda | null;
  suggestedNextTopics: string[];
  overviewDiagramData: OverviewDiagramData | null;
  currentTheme: typeof themes.dark;
  themeType: 'light' | 'dark' | 'modern';
  chatHistory: Array<{ id: number; user: string; avatar: string; message: string; timestamp: string; type: 'chat' | 'system'; userId?: string; speakerId?: string; speakerLabel?: string }>;
  speakerMap: SpeakerMap;
  onDragStart: (e: React.DragEvent, id: PanelId) => void;
  onDragEnd: () => void;
  onTouchStart: (e: React.TouchEvent, id: PanelId, idx: number) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onDoubleClick: () => void;
  onToggleVisibility?: (id: PanelId) => void;
  onParticipantEnter: (id: string) => void;
  onParticipantLeave: (id: string) => void;
  dragged: PanelId | null;
  /** パネル個別エクスポートのオプション */
  exportOptions?: ExportOption[];
  /** Mermaid 図エクスポート用 ref */
  diagramRef?: React.RefObject<MermaidDiagramHandle | null>;
}

const Panel = ({
  id,
  idx,
  participants,
  transcripts,
  notes,
  tasks,
  currentAgenda,
  suggestedNextTopics,
  overviewDiagramData,
  currentTheme,
  themeType,
  chatHistory,
  speakerMap,
  onDragStart,
  onDragEnd,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onDoubleClick,
  onToggleVisibility,
  onParticipantEnter,
  onParticipantLeave,
  dragged,
  exportOptions,
  diagramRef,
}: PanelProps) => {
  const panelConfig = React.useMemo(() =>
    getPanelConfig(participants, notes, tasks, currentAgenda, suggestedNextTopics, overviewDiagramData, currentTheme, themeType, chatHistory, transcripts, speakerMap, onParticipantEnter, onParticipantLeave, diagramRef),
    [participants, notes, tasks, currentAgenda, suggestedNextTopics, overviewDiagramData, currentTheme, themeType, chatHistory, transcripts, speakerMap, onParticipantEnter, onParticipantLeave, diagramRef]
  );

  const cfg = panelConfig[id];
  if (!cfg) return null;

  return (
    <div
      className={`panel-draggable ${currentTheme.card} p-4 group
        ${dragged === id ? 'opacity-40 scale-95' : ''}`}>
      {/* ヘッダー: タイトル (ドラッグ可能) + 操作ボタン (ドラッグ不可) */}
      <div className="flex justify-between items-center mb-2">
        {/* ドラッグ可能領域: タイトル + Grip */}
        <div
          draggable
          onDragStart={e => onDragStart(e, id)}
          onDragEnd={onDragEnd}
          onTouchStart={e => onTouchStart(e, id, idx)}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onDoubleClick={onDoubleClick}
          className="flex items-center gap-2 cursor-move flex-1 min-w-0"
        >
          <h3 className={`flex items-center gap-2 text-sm font-semibold ${currentTheme.text.primary} truncate`}>
            <cfg.icon className="w-4 h-4 flex-shrink-0" />{cfg.title}
          </h3>
        </div>
        {/* 操作ボタン領域: ドラッグ不可 */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {exportOptions && exportOptions.length > 0 && (
            <ExportDropdown
              options={exportOptions}
              currentTheme={currentTheme}
            />
          )}
          {onToggleVisibility && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleVisibility(id);
              }}
              className={`p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200
                hover:bg-red-500/20 hover:text-red-500 ${currentTheme.text.secondary}`}
              title="パネルを非表示にする"
            >
              <EyeOff className="w-4 h-4" />
            </button>
          )}
          <GripVertical className={`w-4 h-4 opacity-0 group-hover:opacity-70 transition-opacity ${currentTheme === themes.dark || currentTheme === themes.modern ? 'text-white' : ''}`} />
        </div>
      </div>
      <div>{cfg.content}</div>
    </div>
  );
};

export default Panel;

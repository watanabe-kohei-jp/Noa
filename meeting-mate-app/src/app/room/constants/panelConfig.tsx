import React from 'react';
import { Users, GitBranch, CheckSquare, Network, ClipboardList, BookOpen, MessageSquare, CalendarPlus } from 'lucide-react';
import ParticipantsList from '@/app/room/components/ParticipantsList';
import NotesDisplay from '@/app/room/components/NotesDisplay';
import TasksPanel from '@/app/room/components/TasksPanel';
import OverviewDiagramPanel from '@/app/room/components/OverviewDiagramPanel';
import CurrentAgendaDisplayPanel from '@/app/room/components/CurrentAgendaDisplayPanel';
import SuggestedNextTopicsPanel from '@/app/room/components/SuggestedNextTopicsPanel';
import ConversationHistoryPanel from '@/app/room/components/ConversationHistoryPanel';
import CalendarLinksPanel from '@/app/room/components/CalendarLinksPanel';
import { PanelId, ParticipantEntry, Notes, TodoItem, CurrentAgenda, OverviewDiagramData, TranscriptEntry, CalendarLinkItem } from '@/types/data';
import type { MermaidDiagramHandle } from '@/app/room/components/MermaidDiagram';
import { themes } from '@/constants/themes';

export type ExportFormat = 'svg' | 'png' | 'pdf' | 'markdown' | 'csv' | 'json';

type PanelConfig = {
  [key in PanelId]: {
    title: string;
    icon: React.ElementType;
    content: React.ReactNode;
    exportFormats: ExportFormat[];
  };
};

interface ChatHistoryItem {
  id: number;
  user: string;
  avatar: string;
  message: string;
  timestamp: string;
  type: 'chat' | 'system';
}

export const getPanelConfig = (
  participants: ParticipantEntry[],
  notes: Notes,
  tasks: TodoItem[],
  currentAgenda: CurrentAgenda | null,
  suggestedNextTopics: string[],
  overviewDiagramData: OverviewDiagramData | null,
  currentTheme: typeof themes.dark,
  themeType: 'light' | 'dark' | 'modern',
  chatHistory: ChatHistoryItem[],
  transcripts: TranscriptEntry[],
  onParticipantEnter: (id: string) => void,
  onParticipantLeave: (id: string) => void,
  diagramRef?: React.RefObject<MermaidDiagramHandle | null>,
  calendarLinks?: CalendarLinkItem[],
): PanelConfig => ({
  participants: {
    title: '参加者',
    icon: Users,
    content: <ParticipantsList participants={participants} transcripts={transcripts} currentTheme={currentTheme} onParticipantEnter={onParticipantEnter} onParticipantLeave={onParticipantLeave} />,
    exportFormats: [],
  },
  currentAgenda: {
    title: '現在の議題',
    icon: ClipboardList,
    content: <CurrentAgendaDisplayPanel agenda={currentAgenda} currentTheme={currentTheme} />,
    exportFormats: ['markdown', 'json'],
  },
  suggestedTopics: {
    title: '提案される次の議題',
    icon: GitBranch,
    content: <SuggestedNextTopicsPanel topics={suggestedNextTopics} currentTheme={currentTheme} />,
    exportFormats: ['markdown', 'json'],
  },
  overviewDiagram: {
    title: '会議の概要図',
    icon: Network,
    content: <OverviewDiagramPanel diagramData={overviewDiagramData} currentTheme={currentTheme} themeType={themeType} diagramRef={diagramRef} />,
    exportFormats: ['svg', 'png', 'pdf'],
  },
  notes: {
    title: 'ノート',
    icon: BookOpen,
    content: <NotesDisplay notes={notes} currentTheme={currentTheme} />,
    exportFormats: ['markdown', 'csv', 'json'],
  },
  tasks: {
    title: 'タスク',
    icon: CheckSquare,
    content: <TasksPanel tasks={tasks} currentTheme={currentTheme} />,
    exportFormats: ['markdown', 'csv', 'json'],
  },
  conversationHistory: {
    title: '会話履歴',
    icon: MessageSquare,
    content: <ConversationHistoryPanel chatHistory={chatHistory} currentTheme={currentTheme} />,
    exportFormats: ['markdown', 'json'],
  },
  calendarLinks: {
    title: 'カレンダー',
    icon: CalendarPlus,
    content: <CalendarLinksPanel calendarLinks={calendarLinks || []} currentTheme={currentTheme} />,
    exportFormats: ['json'],
  },
} as PanelConfig);

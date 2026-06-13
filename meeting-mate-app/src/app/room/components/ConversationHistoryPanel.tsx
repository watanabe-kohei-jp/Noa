import React, { useEffect, useRef } from 'react';
import { participantColors, getParticipantColorIndex } from './ParticipantsList';
import type { SpeakerMap } from '@/types/data';

interface ChatHistoryItem {
  id: number;
  user: string;
  avatar: string;
  message: string;
  timestamp: string;
  type: 'chat' | 'system';
  userId?: string;
  speakerId?: string;
  speakerLabel?: string;
}

interface ConversationHistoryPanelProps {
  chatHistory: ChatHistoryItem[];
  currentTheme: typeof import('@/constants/themes').themes.dark;
  speakerMap: SpeakerMap;
}

const ConversationHistoryPanel: React.FC<ConversationHistoryPanelProps> = ({
  chatHistory,
  currentTheme,
  speakerMap,
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message when chat history updates
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [chatHistory]);

  if (!chatHistory || chatHistory.length === 0) {
    return (
      <div className={`text-center py-8 ${currentTheme.text.secondary}`}>
        <p>まだ会話がありません</p>
      </div>
    );
  }

  return (
    <div ref={chatContainerRef} className="h-48 overflow-y-auto space-y-4">
      {chatHistory.map((chat) => {
        // 話者分離 (speaker_N) のみ speakerMap を適用。AI/agent 系は従来表示
        const isHumanStt = chat.type !== 'system' && !!chat.speakerId?.startsWith('speaker_');
        const mapEntry = isHumanStt ? speakerMap[chat.speakerId!] : undefined;

        const displayName = mapEntry?.label ?? chat.speakerLabel ?? chat.user;
        const avatarText = Array.from(displayName).slice(0, 2).join('');

        const fallbackBg = chat.type === 'system'
          ? 'bg-gray-500'
          : `bg-gradient-to-r ${participantColors[getParticipantColorIndex(chat.userId || chat.user)]}`;

        const avatarClass = `w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white font-semibold text-xs${mapEntry ? '' : ` ${fallbackBg}`}`;
        const avatarStyle = mapEntry ? { background: mapEntry.color } : undefined;

        return (
          <div key={chat.id} className="flex items-start space-x-3 text-sm">
            <div className={avatarClass} style={avatarStyle}>
              {avatarText}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2 mb-1">
                <span className={`font-medium ${currentTheme.text.primary}`}>{displayName}</span>
                <span className={`text-xs ${currentTheme.text.tertiary}`}>
                  {new Date(chat.timestamp).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>
              <div className={`${currentTheme.text.secondary} break-words whitespace-pre-line`}>{chat.message}</div>
            </div>
          </div>
        );
      })}
      <div ref={chatEndRef} />
    </div>
  );
};

export default ConversationHistoryPanel;
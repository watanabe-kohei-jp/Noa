import React from 'react';
import { CalendarLinkItem } from '@/types/data';
import { themes } from '@/constants/themes';
import { isSafeCalendarUrl } from '@/lib/url-safety';
import { CalendarPlus, ExternalLink } from 'lucide-react';

interface CalendarLinksPanelProps {
  calendarLinks: CalendarLinkItem[];
  currentTheme: typeof themes.dark;
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

const CalendarLinksPanel: React.FC<CalendarLinksPanelProps> = ({ calendarLinks, currentTheme }) => {
  if (!calendarLinks || calendarLinks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <CalendarPlus className={`${currentTheme.text.muted} w-12 h-12 mb-3 mx-auto`} />
          <p className={`${currentTheme.text.secondary} text-sm`}>カレンダーリンクはありません</p>
        </div>
      </div>
    );
  }

  const sorted = [...calendarLinks].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div className="space-y-3">
      {sorted.map((link) => (
        <div
          key={link.id}
          className={`${currentTheme.cardInner} rounded-lg p-4 transition-all duration-200 hover:shadow-md border ${
            currentTheme === themes.dark
              ? 'border-gray-700/50 hover:bg-gray-800/50'
              : currentTheme === themes.modern
              ? 'border-white/30 hover:bg-white/15'
              : 'border-gray-200 hover:bg-gray-50'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className={`${currentTheme.text.primary} font-medium text-sm leading-relaxed truncate`}>
                {link.summary}
              </h3>
              {link.startTime && (
                <p className={`${currentTheme.text.secondary} text-xs mt-1`}>
                  {formatDateTime(link.startTime)}
                  {link.endTime && ` 〜 ${formatDateTime(link.endTime)}`}
                </p>
              )}
            </div>
            {isSafeCalendarUrl(link.calendarUrl) ? (
              <a
                href={link.calendarUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                追加
              </a>
            ) : (
              <span
                title="無効な URL のため開けません"
                className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-gray-400 text-white opacity-60 cursor-not-allowed"
              >
                <ExternalLink className="w-3 h-3" />
                追加
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default CalendarLinksPanel;

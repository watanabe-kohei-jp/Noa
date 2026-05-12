import React from 'react';
import { themes } from '@/constants/themes';
import type { OverviewDiagramEntry } from '@/types/data';

interface OverviewDiagramTabsProps {
  diagrams: OverviewDiagramEntry[];
  activeTopicId: string | null;
  onSelect: (topicId: string) => void;
  currentTheme: typeof themes.dark;
}

/**
 * 論点 (topic) ごとの概要図を切り替えるタブストリップ (Issue #131)。
 * 1 件以下なら表示しない (UI ノイズ削減)。
 */
const OverviewDiagramTabs: React.FC<OverviewDiagramTabsProps> = React.memo(({ diagrams, activeTopicId, onSelect, currentTheme }) => {
  if (diagrams.length <= 1) return null;

  return (
    <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="概要図の論点切替">
      {diagrams.map((d) => {
        const isActive = d.topicId === activeTopicId;
        const isClosed = d.status === 'closed';
        const baseCls = `px-2.5 py-1 text-xs rounded-md transition-colors truncate max-w-[160px] border`;
        const activeCls = isActive
          ? `${currentTheme.text.primary} bg-blue-500/15 border-blue-500/40 font-semibold`
          : `${currentTheme.text.secondary} border-transparent hover:bg-white/5`;
        const closedCls = isClosed && !isActive ? ' opacity-60' : '';
        return (
          <button
            key={d.topicId}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(d.topicId)}
            className={`${baseCls} ${activeCls}${closedCls}`}
            title={d.title}
          >
            <span className="truncate">{d.title}</span>
            {isClosed && (
              <span
                className="ml-1.5 inline-block px-1 py-px text-[10px] rounded bg-gray-500/20 text-gray-300"
                aria-label="完了済み"
              >
                済
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
OverviewDiagramTabs.displayName = 'OverviewDiagramTabs';

export default OverviewDiagramTabs;

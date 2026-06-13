import React, { useRef, useState, useEffect, useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { themes } from '@/constants/themes';
import type { OverviewDiagramEntry } from '@/types/data';
import { resolveActiveDiagram } from '@/lib/overview-diagram-utils';
import MermaidDiagram from './MermaidDiagram';
import type { MermaidDiagramHandle } from './MermaidDiagram';
import OverviewDiagramTabs from './OverviewDiagramTabs';

interface OverviewDiagramPanelProps {
  /** 論点単位の概要図リスト (Issue #131) */
  diagrams: OverviewDiagramEntry[];
  /** 現在の議題 (タブの初期選択判定に使用) */
  mainTopic?: string | null;
  currentTheme: typeof themes.dark;
  themeType: 'light' | 'dark' | 'modern';
  isFullScreen?: boolean;
  /** 外部から MermaidDiagram の handle にアクセスするための ref */
  diagramRef?: React.RefObject<MermaidDiagramHandle | null>;
}

const OverviewDiagramPanel: React.FC<OverviewDiagramPanelProps> = React.memo(({ diagrams, mainTopic, currentTheme, themeType, isFullScreen = false, diagramRef }) => {
  const internalRef = useRef<MermaidDiagramHandle>(null);
  const ref = diagramRef || internalRef;

  // ユーザーがタブを手動選択していなければ mainTopic ベースで自動追従
  const autoActive = useMemo(
    () => resolveActiveDiagram(diagrams, mainTopic),
    [diagrams, mainTopic]
  );
  const [manualTopicId, setManualTopicId] = useState<string | null>(null);

  // mainTopic が変わった瞬間に手動選択をリセット (新議題に追従)
  useEffect(() => {
    setManualTopicId(null);
  }, [mainTopic]);

  // 手動選択が現存しなくなったら (図が削除された等) リセット
  useEffect(() => {
    if (manualTopicId && !diagrams.some((d) => d.topicId === manualTopicId)) {
      setManualTopicId(null);
    }
  }, [diagrams, manualTopicId]);

  const activeTopicId = manualTopicId ?? autoActive?.topicId ?? null;
  const active = activeTopicId ? diagrams.find((d) => d.topicId === activeTopicId) : null;

  if (diagrams.length === 0 || !active || !active.mermaidDefinition) {
    return (
      <div className={`${isFullScreen ? 'w-full h-full' : `${currentTheme.cardInner} border rounded-xl p-4`} flex items-center justify-center`} style={isFullScreen ? {} : { minHeight: '200px' }}>
        <div className="text-center">
          <div className={`w-16 h-16 ${currentTheme === themes.dark ? 'bg-gray-700' : currentTheme === themes.modern ? 'bg-white/10' : 'bg-gray-200'} rounded-full flex items-center justify-center mx-auto mb-4`}>
            <GitBranch className={`w-8 h-8 ${currentTheme.text.muted}`} />
          </div>
          <p className={`${currentTheme.text.secondary} text-sm`}>概要図が生成されると<br />ここに表示されます</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`${isFullScreen ? 'w-full h-full flex flex-col' : `${currentTheme.cardInner} border rounded-xl p-4 flex flex-col`}`} style={isFullScreen ? {} : { minHeight: '200px' }}>
      <OverviewDiagramTabs
        diagrams={diagrams}
        activeTopicId={activeTopicId}
        onSelect={setManualTopicId}
        currentTheme={currentTheme}
      />
      <div className="flex-1 flex items-center justify-center min-h-0">
        <MermaidDiagram ref={ref} definition={active.mermaidDefinition} theme={themeType} />
      </div>
    </div>
  );
});
OverviewDiagramPanel.displayName = 'OverviewDiagramPanel';

export default OverviewDiagramPanel;

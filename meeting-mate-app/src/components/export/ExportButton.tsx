'use client';

import React from 'react';
import { FileDown } from 'lucide-react';
import { themes } from '@/constants/themes';

interface ExportButtonProps {
  onClick: () => void;
  currentTheme: typeof themes.dark;
}

const ExportButton: React.FC<ExportButtonProps> = ({ onClick, currentTheme }) => {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200
        ${currentTheme === themes.dark
          ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
          : currentTheme === themes.modern
            ? 'bg-white/10 hover:bg-white/20 text-white/80'
            : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
        }`}
      title="会議データをエクスポート"
    >
      <FileDown className="w-4 h-4" />
      <span className="hidden sm:inline">エクスポート</span>
    </button>
  );
};

export default ExportButton;

'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Download } from 'lucide-react';
import { themes } from '@/constants/themes';

export interface ExportOption {
  label: string;
  format: string;
  onClick: () => void | Promise<void>;
}

interface ExportDropdownProps {
  options: ExportOption[];
  currentTheme: typeof themes.dark;
  disabled?: boolean;
}

const ExportDropdown: React.FC<ExportDropdownProps> = ({ options, currentTheme, disabled = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleOptionClick = async (option: ExportOption) => {
    setIsExporting(true);
    setIsOpen(false);
    try {
      await option.onClick();
    } catch (err) {
      console.error(`Export failed (${option.format}):`, err);
    } finally {
      setIsExporting(false);
    }
  };

  if (options.length === 0) return null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (!disabled && !isExporting) setIsOpen(!isOpen);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        disabled={disabled || isExporting}
        className={`p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200
          ${disabled || isExporting
            ? 'cursor-not-allowed opacity-30'
            : `hover:bg-blue-500/20 hover:text-blue-500 ${currentTheme.text.secondary}`
          }`}
        title="エクスポート"
      >
        <Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
      </button>

      {isOpen && (
        <div
          className={`absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg shadow-lg border
            ${currentTheme === themes.dark
              ? 'bg-gray-800 border-gray-700'
              : currentTheme === themes.modern
                ? 'bg-gray-900 border-gray-700'
                : 'bg-white border-gray-200'
            }`}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="py-1">
            {options.map((option) => (
              <button
                key={option.format}
                onClick={() => handleOptionClick(option)}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors
                  ${currentTheme === themes.dark || currentTheme === themes.modern
                    ? 'text-gray-300 hover:bg-gray-700 hover:text-white'
                    : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                  }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ExportDropdown;

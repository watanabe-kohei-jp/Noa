/**
 * Mermaid 概要図のエクスポート (SVG / PNG / PDF)
 *
 * SVG: htmlLabels: false で再レンダリングし、foreignObject を回避
 * PNG: html2canvas で DOM キャプチャ (dynamic import)
 * PDF: PNG → jspdf (dynamic import)
 */

import { downloadBlob, downloadText, sanitizeFileName, getTimestamp } from './download-utils';

/** テーマに応じた背景色を返す */
function getBackgroundColor(theme: 'light' | 'dark' | 'modern'): string {
  switch (theme) {
    case 'dark': return '#1f2937';
    case 'modern': return '#0f172a'; // slate-900
    case 'light':
    default: return '#ffffff';
  }
}

/**
 * Mermaid 定義を htmlLabels: false で再レンダリングし、純粋な SVG 文字列を取得
 * foreignObject を含まないため、外部ビューアとの互換性が高い
 */
async function renderCleanSvg(
  definition: string,
  theme: 'light' | 'dark' | 'modern'
): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  const mermaidTheme = theme === 'dark' || theme === 'modern' ? 'dark' : 'neutral';
  const isDarkTheme = theme === 'dark' || theme === 'modern';

  mermaid.initialize({
    startOnLoad: false,
    theme: mermaidTheme,
    securityLevel: 'strict',
    fontFamily: 'Arial, sans-serif',
    flowchart: {
      useMaxWidth: true,
      htmlLabels: false, // foreignObject を回避
    },
    themeVariables: {
      fontFamily: 'Arial, sans-serif',
      ...(isDarkTheme && {
        primaryColor: '#374151',
        primaryTextColor: '#f3f4f6',
        primaryBorderColor: '#6b7280',
        lineColor: '#9ca3af',
        secondaryColor: '#4b5563',
        tertiaryColor: '#1f2937',
        background: '#1f2937',
        mainBkg: '#374151',
        secondBkg: '#4b5563',
        tertiaryBkg: '#6b7280',
      }),
    },
  });

  const tempId = `export-svg-${Date.now()}`;
  const { svg } = await mermaid.render(tempId, definition);
  return svg;
}

/**
 * Mermaid 図を SVG としてダウンロード
 * htmlLabels: false で再レンダリングし、foreignObject のない純粋 SVG を出力
 */
export async function exportDiagramAsSvg(
  definition: string,
  theme: 'light' | 'dark' | 'modern',
  title?: string
): Promise<void> {
  const svgContent = await renderCleanSvg(definition, theme);

  // xmlns が含まれているか確認し、なければ追加
  let svgString = svgContent;
  if (!svgString.includes('xmlns=')) {
    svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  // XML 宣言を追加
  const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>\n${svgString}`;

  const fileName = `${sanitizeFileName(title || 'overview-diagram')}_${getTimestamp()}.svg`;
  downloadText(fullSvg, fileName, 'image/svg+xml');
}

/**
 * Mermaid 図を PNG としてダウンロード
 * html2canvas で DOM コンテナをキャプチャ (Retina 2x)
 */
export async function exportDiagramAsPng(
  containerElement: HTMLElement,
  theme: 'light' | 'dark' | 'modern',
  title?: string
): Promise<void> {
  const { default: html2canvas } = await import('html2canvas');

  const canvas = await html2canvas(containerElement, {
    scale: 2,
    backgroundColor: getBackgroundColor(theme),
    useCORS: false,
    logging: false,
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
      'image/png'
    );
  });

  const fileName = `${sanitizeFileName(title || 'overview-diagram')}_${getTimestamp()}.png`;
  downloadBlob(blob, fileName);
}

/**
 * Mermaid 図を PDF としてダウンロード
 * html2canvas → PNG → jspdf
 */
export async function exportDiagramAsPdf(
  containerElement: HTMLElement,
  theme: 'light' | 'dark' | 'modern',
  title?: string
): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const canvas = await html2canvas(containerElement, {
    scale: 2,
    backgroundColor: getBackgroundColor(theme),
    useCORS: false,
    logging: false,
  });

  const imgData = canvas.toDataURL('image/png');
  const imgWidth = canvas.width;
  const imgHeight = canvas.height;

  // A4 横向き (landscape) でフィット
  const pdf = new jsPDF({
    orientation: imgWidth > imgHeight ? 'landscape' : 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const maxWidth = pageWidth - margin * 2;
  const maxHeight = pageHeight - margin * 2;

  // アスペクト比を維持してフィット
  const ratio = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);
  const fitWidth = imgWidth * ratio;
  const fitHeight = imgHeight * ratio;

  // 中央配置
  const x = (pageWidth - fitWidth) / 2;
  const y = (pageHeight - fitHeight) / 2;

  pdf.addImage(imgData, 'PNG', x, y, fitWidth, fitHeight);

  const fileName = `${sanitizeFileName(title || 'overview-diagram')}_${getTimestamp()}.pdf`;
  pdf.save(fileName);
}

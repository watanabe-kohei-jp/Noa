/**
 * ダウンロードユーティリティ
 * Blob → ブラウザダウンロードのトリガー + ファイル名 sanitize
 */

/** Windows 禁止文字を除去し、長さを制限 */
export function sanitizeFileName(name: string, maxLength = 200): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLength);
}

/** 現在日時を YYYYMMDD_HHmm 形式で返す */
export function getTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}`;
}

/** Blob をブラウザダウンロードとしてトリガー */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** テキストをファイルとしてダウンロード */
export function downloadText(content: string, fileName: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  downloadBlob(blob, fileName);
}

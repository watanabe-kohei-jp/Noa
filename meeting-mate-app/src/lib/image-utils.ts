/**
 * 画像リサイズユーティリティ
 * ユーザーがアップロードした画像を Gemini Live API に送信できるサイズに変換する
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * 画像ファイルをリサイズし、base64 エンコードされた文字列を返す
 * - 最大サイズ (maxSize x maxSize) にリサイズ
 * - 透過画像は PNG、それ以外は JPEG で出力
 * - Gemini API のインライン画像制限 (~4MB base64) に収まるよう制限
 */
export async function resizeImageToBase64(
  file: File,
  maxSize: number = 1024,
  quality: number = 0.7
): Promise<{ base64: string; mimeType: string }> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`ファイルサイズが大きすぎます (${Math.round(file.size / 1024 / 1024)}MB)。20MB以下の画像を選択してください。`);
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(
      "この画像形式はサポートされていません。JPEG, PNG, WebP, GIF をお試しください。"
    );
  });

  const { width, height } = bitmap;
  let targetWidth = width;
  let targetHeight = height;

  if (width > maxSize || height > maxSize) {
    const ratio = Math.min(maxSize / width, maxSize / height);
    targetWidth = Math.round(width * ratio);
    targetHeight = Math.round(height * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas の初期化に失敗しました。");
  }

  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  // 透過判定: PNG/WebP で alpha チャネルがある場合は PNG 出力
  const hasAlpha = file.type === "image/png" || file.type === "image/webp";
  const mimeType = hasAlpha ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

  return { base64, mimeType };
}

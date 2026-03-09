/**
 * Gemini Live API の outputAudioTranscription から
 * 内部思考テキスト（英語推論・markdown・ツール名）を除去する
 *
 * outputAudioTranscription は音声の書き起こし（日本語）なので、
 * 以下のパターンは内部思考テキストと判定できる:
 * - **太字** markdown ヘッダー
 * - 英語の長い文（音声は日本語のみ）
 * - バッククォートで囲まれたツール名 (`delegate_to_brain` 等)
 */
export function filterThinkingText(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // 空行は保持

    // **Header** パターン（markdown太字）
    if (/^\*\*[^*]+\*\*/.test(trimmed)) return false;

    // バッククォートでツール名を含む行
    if (/`delegate_to_brain`/.test(trimmed)) return false;

    // 英語主体の行を除去（ASCII比率が高い = 英語推論テキスト）
    // 日本語の音声書き起こしは大部分がマルチバイト文字
    const asciiChars = trimmed.replace(/[\s\d.,!?;:'"()\-/]/g, ""); // 記号除去
    if (asciiChars.length > 20) {
      const latinCount = (asciiChars.match(/[a-zA-Z]/g) || []).length;
      const ratio = latinCount / asciiChars.length;
      if (ratio > 0.5) return false; // ASCII文字が50%超 = 英語テキスト
    }

    return true;
  });

  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Overview diagram utilities (Issue #131).
 *
 * 論点 (topic) 単位の概要図リストへ移行するための shim と共通ヘルパ。
 */
import type { OverviewDiagramData, OverviewDiagramEntry } from "@/types/data";

export const LEGACY_TOPIC_ID = "legacy";
export const GENERAL_TOPIC_ID = "_general";

// slug 末尾の hash suffix 長 (Issue #131 P1 fix #6, Python 側と同一)
const SLUG_HASH_LEN = 6;
const SLUG_MAX_LEN = 80;
const SLUG_BODY_MAX = SLUG_MAX_LEN - 1 - SLUG_HASH_LEN; // 73

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * FNV-1a 32bit hash の hex 下 6 桁を返す (Python 側 fnv1a_hex6 と同一実装)。
 * UTF-8 byte sequence をハッシュ対象とする (multi-byte safe)。
 */
export function fnv1aHex6(text: string): string {
  let h = 0x811c9dc5;
  // TextEncoder で UTF-8 byte 列に変換 → Python の text.encode("utf-8") と一致
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0; // 32bit unsigned multiply
  }
  return h.toString(16).padStart(8, "0").slice(-SLUG_HASH_LEN);
}

export function slugifyTopicId(text: string | null | undefined): string {
  if (!text) return "";
  const raw = text.trim();
  if (!raw) return "";
  let body = raw.replace(/\s+/g, "_").replace(/[.#$\[\]/]/g, "_");
  if (body.length > SLUG_BODY_MAX) {
    body = body.slice(0, SLUG_BODY_MAX);
  }
  return `${body}_${fnv1aHex6(raw)}`;
}

/**
 * Firebase 上の overviewDiagrams (list / keyed dict) と旧 overviewDiagram (単数) を
 * 統一的に OverviewDiagramEntry[] に変換する。
 *
 * - 新 overviewDiagrams が list なら順序保持
 * - 新 overviewDiagrams が keyed dict なら createdAt 昇順で sort
 * - 旧 overviewDiagram (単数) しか無ければ topicId="legacy" の 1 要素に変換
 * - 何も無ければ空配列
 */
export function normalizeOverviewDiagrams(
  data: { overviewDiagram?: OverviewDiagramData | null; overviewDiagrams?: unknown } | null | undefined
): OverviewDiagramEntry[] {
  if (!data) return [];

  const newField = data.overviewDiagrams;
  if (Array.isArray(newField)) {
    return newField.filter(isOverviewEntry);
  }
  if (isObject(newField)) {
    const entries = Object.values(newField).filter(isOverviewEntry);
    entries.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    return entries;
  }

  const legacy = data.overviewDiagram;
  if (legacy && legacy.mermaidDefinition) {
    const now = new Date().toISOString();
    return [
      {
        topicId: LEGACY_TOPIC_ID,
        title: legacy.title || "概要図",
        mermaidDefinition: legacy.mermaidDefinition,
        status: "active",
        createdAt: now,
        lastUpdated: now,
      },
    ];
  }

  return [];
}

function isOverviewEntry(v: unknown): v is OverviewDiagramEntry {
  return (
    isObject(v) &&
    typeof v.topicId === "string" &&
    typeof v.mermaidDefinition === "string" &&
    typeof v.title === "string"
  );
}

/**
 * currentAgenda.mainTopic から「現在アクティブな概要図」を選択する。
 * 一致が無ければ最後に追加された active を返す。
 */
export function resolveActiveDiagram(
  diagrams: OverviewDiagramEntry[],
  mainTopic?: string | null
): OverviewDiagramEntry | null {
  if (!diagrams.length) return null;
  if (mainTopic) {
    const slug = slugifyTopicId(mainTopic);
    const match = diagrams.find((d) => d.topicId === slug);
    if (match) return match;
  }
  const actives = diagrams.filter((d) => d.status !== "closed");
  return actives[actives.length - 1] || diagrams[diagrams.length - 1];
}

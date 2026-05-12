/**
 * Overview diagram utilities (Issue #131).
 *
 * 論点 (topic) 単位の概要図リストへ移行するための shim と共通ヘルパ。
 */
import type { OverviewDiagramData, OverviewDiagramEntry } from "@/types/data";

export const LEGACY_TOPIC_ID = "legacy";
export const GENERAL_TOPIC_ID = "_general";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function slugifyTopicId(text: string | null | undefined): string {
  if (!text) return "";
  const slug = text
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[.#$\[\]/]/g, "_");
  return slug.slice(0, 80);
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

/**
 * Mermaid render gateway.
 *
 * Mermaid 11.6.0 / khroma / d3-color は CSS の oklch() 色関数を解釈できない。
 * Tailwind CSS v4 は :root に --color-* 変数を oklch() で注入するため、
 * Mermaid が内部で拾って解析失敗する (Issue #95)。
 *
 * 本 gateway は:
 *   1. Mutex で render / export の並行実行を直列化 (global initialize 競合を回避)
 *   2. Root 上で oklch を含む CSS 変数を一時的に rgb に上書き
 *   3. Snapshot/restore で元の inline 値を破壊しない
 *   4. 3 箇所に散らばっていた initialize を一本化 (DRY)
 */

import type mermaidType from 'mermaid';

type Mermaid = typeof mermaidType;

export type MermaidThemeKind = 'light' | 'dark' | 'modern';

interface RenderOpts {
  theme: MermaidThemeKind;
  htmlLabels?: boolean;
  definition: string;
  elementId: string;
}

// --- Mutex (Promise chain 方式) ---
let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // 次のタスクを止めないようにエラーを飲む。run 自体のエラーは呼び出し側で handle される
  chain = run.catch(() => {});
  return run;
}

// --- Root isolation with snapshot ---
type Snapshot = Map<string, string | null>; // null = inline 値が元々無かった

function resolveVarToRgb(varName: string, hostEl: HTMLElement): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${varName}, #000)`;
  probe.style.display = 'none';
  hostEl.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  hostEl.removeChild(probe);
  return computed || '#000000';
}

function snapshotAndNeutralize(root: HTMLElement): Snapshot {
  const snap: Snapshot = new Map();
  const computed = getComputedStyle(root);
  for (let i = 0; i < computed.length; i++) {
    const name = computed[i];
    if (!name.startsWith('--')) continue;
    const value = computed.getPropertyValue(name);
    if (!value.includes('oklch(')) continue;
    const inline = root.style.getPropertyValue(name);
    snap.set(name, inline === '' ? null : inline);
    root.style.setProperty(name, resolveVarToRgb(name, root));
  }
  return snap;
}

function restore(root: HTMLElement, snap: Snapshot): void {
  for (const [name, original] of snap) {
    if (original === null) root.style.removeProperty(name);
    else root.style.setProperty(name, original);
  }
}

// --- Initialize キャッシュ ---
let lastInitKey: string | null = null;

function buildThemeVariables(isDark: boolean): Record<string, string> {
  const base: Record<string, string> = { fontFamily: 'Arial, sans-serif' };
  if (!isDark) return base;
  return {
    ...base,
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
  };
}

async function initializeInternal(
  theme: MermaidThemeKind,
  htmlLabels: boolean,
): Promise<Mermaid> {
  const mermaid = (await import('mermaid')).default;
  const key = `${theme}:${htmlLabels}`;
  if (lastInitKey !== key) {
    const isDark = theme === 'dark' || theme === 'modern';
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'neutral',
      securityLevel: 'strict',
      fontFamily: 'Arial, sans-serif',
      flowchart: { useMaxWidth: true, htmlLabels },
      themeVariables: buildThemeVariables(isDark),
    });
    lastInitKey = key;
  }
  return mermaid;
}

// --- 公開 API ---

/**
 * Mermaid を安全に render する。
 * - Mutex で並行呼び出しを直列化
 * - render 実行中のみ oklch CSS 変数を rgb に無害化
 */
export async function renderMermaid(opts: RenderOpts): Promise<{ svg: string }> {
  return withLock(async () => {
    const mermaid = await initializeInternal(opts.theme, opts.htmlLabels ?? true);
    const root = document.documentElement;
    const snap = snapshotAndNeutralize(root);
    try {
      return await mermaid.render(opts.elementId, opts.definition);
    } finally {
      restore(root, snap);
    }
  });
}

/**
 * Mermaid 以外の処理 (例: html2canvas) を Mermaid と同じ isolation 内で実行する。
 * PNG/PDF エクスポートのように SVG 化済みの要素を再キャプチャする経路で使う。
 */
export async function withMermaidIsolation<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(async () => {
    const root = document.documentElement;
    const snap = snapshotAndNeutralize(root);
    try {
      return await fn();
    } finally {
      restore(root, snap);
    }
  });
}

// --- テスト用 hook (本番コードからは使わない) ---
export const __testing = {
  resetInitCache: () => {
    lastInitKey = null;
  },
  snapshotAndNeutralize,
  restore,
  resolveVarToRgb,
};

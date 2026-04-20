/**
 * Mermaid render gateway.
 *
 * Mermaid 11.6.0 / khroma / d3-color は CSS の oklch() 色関数を解釈できない。
 * Tailwind CSS v4 は :root に --color-* 変数を oklch() で注入するため、
 * Mermaid が内部で拾って解析失敗する (Issue #95)。
 *
 * 本 gateway は:
 *   1. Mutex で render の並行実行を直列化 (global initialize 競合を回避)
 *   2. CSSOM を走査して :root / html / :host ルール内の --* を抽出
 *   3. oklch() を含むものを canvas 2D fillStyle で rgb/hex に正規化して上書き
 *   4. Snapshot/restore で元の inline 値を破壊しない
 *   5. 3 箇所に散らばっていた initialize を一本化 (DRY)
 *
 * html2canvas (PNG/PDF エクスポート) は live DOM を触らず、onclone で
 * clone 側の documentElement だけを neutralize する。neutralizeDocOklch を export。
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
  // キュー破断を防ぐために次タスクは成功/失敗どちらでも進める
  chain = run.catch(() => {});
  return run;
}

// --- CSSOM 列挙 ---
// :root / html / :host ルール内の --* を全て集める。
// getComputedStyle() の数値インデックス列挙は実装依存で抜け漏れがあるため、
// stylesheets を直接走査する方が確実。

function collectRootCustomPropNames(doc: Document): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList | undefined) => {
    if (!rules) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if ((rule as CSSStyleRule).selectorText && (rule as CSSStyleRule).style) {
        const styleRule = rule as CSSStyleRule;
        const selectors = styleRule.selectorText.split(',').map((s) => s.trim());
        if (selectors.some((s) => s === ':root' || s === 'html' || s === ':host')) {
          const style = styleRule.style;
          for (let j = 0; j < style.length; j++) {
            const name = style.item(j);
            if (name.startsWith('--')) names.add(name);
          }
        }
      }
      const groupRules = (rule as CSSGroupingRule).cssRules;
      if (groupRules) visit(groupRules);
    }
  };
  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i];
    try {
      visit(sheet.cssRules);
    } catch {
      // cross-origin stylesheet は cssRules アクセスで SecurityError
    }
  }
  return [...names];
}

// --- 色正規化 (canvas fillStyle を使って oklch / lab / color() を rgb/hex に落とす) ---
let colorCtx: CanvasRenderingContext2D | null | undefined;

function getColorCtx(): CanvasRenderingContext2D | null {
  if (colorCtx !== undefined) return colorCtx;
  try {
    const canvas = document.createElement('canvas');
    colorCtx = canvas.getContext('2d');
  } catch {
    colorCtx = null;
  }
  return colorCtx;
}

const SAFE_FALLBACK = '#000000';

function normalizeToSupportedColor(value: string): string {
  const ctx = getColorCtx();
  if (!ctx) return SAFE_FALLBACK;
  // sentinel 方式: 無効な値を設定しても fillStyle は変化しない。
  // 直前に SAFE_FALLBACK を入れておき、次の代入が失敗したら SAFE_FALLBACK のままになる。
  ctx.fillStyle = SAFE_FALLBACK;
  try {
    ctx.fillStyle = value;
  } catch {
    return SAFE_FALLBACK;
  }
  const normalized = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : '';
  return normalized || SAFE_FALLBACK;
}

// --- Snapshot / neutralize ---
type Snapshot = Map<string, string | null>; // null = inline 値が元々無かった

function neutralizeOklchVars(
  root: HTMLElement,
  doc: Document,
  snap?: Snapshot,
): Snapshot {
  const snapshot = snap ?? (new Map() as Snapshot);
  const names = collectRootCustomPropNames(doc);
  const computed = getComputedStyle(root);
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (!value.includes('oklch(')) continue;
    const inline = root.style.getPropertyValue(name);
    if (!snapshot.has(name)) {
      snapshot.set(name, inline === '' ? null : inline);
    }
    root.style.setProperty(name, normalizeToSupportedColor(value));
  }
  return snapshot;
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
 * - render 実行中のみ oklch CSS 変数を rgb に無害化 (live DOM)
 * - finally で必ず restore
 */
export async function renderMermaid(opts: RenderOpts): Promise<{ svg: string }> {
  return withLock(async () => {
    const mermaid = await initializeInternal(opts.theme, opts.htmlLabels ?? true);
    const root = document.documentElement;
    const snap = neutralizeOklchVars(root, document);
    try {
      return await mermaid.render(opts.elementId, opts.definition);
    } finally {
      restore(root, snap);
    }
  });
}

/**
 * html2canvas の onclone から呼び出して、clone 側の documentElement の
 * oklch CSS 変数を rgb に無害化する。live DOM は一切触らない。
 *
 * 戻り値は snap だが restore する必要はない (clone はそのまま破棄される)。
 */
export function neutralizeDocOklch(clonedDoc: Document): void {
  const root = clonedDoc.documentElement;
  if (!root) return;
  neutralizeOklchVars(root as HTMLElement, clonedDoc);
}

// --- テスト用 hook (本番コードからは使わない) ---
export const __testing = {
  resetInitCache: () => {
    lastInitKey = null;
  },
  resetColorCtx: () => {
    colorCtx = undefined;
  },
  neutralizeOklchVars,
  restore,
  normalizeToSupportedColor,
  collectRootCustomPropNames,
  withLock,
};

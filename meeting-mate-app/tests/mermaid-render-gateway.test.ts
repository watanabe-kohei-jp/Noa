import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- DOM スタブ (Node 環境向けの最小実装) -----------------------------------
// vitest の environment: 'node' のままで動くように、document / getComputedStyle を
// 手動で差し込む。jsdom/happy-dom を追加せずにテストするための措置。

type PropMap = Map<string, string>;

function createFakeStyle(initial: Record<string, string> = {}) {
  const props: PropMap = new Map(Object.entries(initial));
  return {
    setProperty(name: string, value: string) { props.set(name, String(value)); },
    getPropertyValue(name: string) { return props.get(name) ?? ''; },
    removeProperty(name: string) { props.delete(name); },
  };
}

function installDom(opts: {
  computedVars: Record<string, string>;
  initialInlineVars?: Record<string, string>;
  resolvedColor?: string;
}) {
  const { computedVars, initialInlineVars = {}, resolvedColor = 'rgb(128, 128, 128)' } = opts;
  const style = createFakeStyle(initialInlineVars);
  // inline は computed に優先して上書きする (ブラウザ挙動と同等)
  const computedSource: Record<string, string> = { ...computedVars, ...initialInlineVars };
  const names = Object.keys(computedSource);

  const rootComputed: Record<string | number, unknown> & {
    length: number;
    getPropertyValue: (n: string) => string;
  } = {
    length: names.length,
    getPropertyValue: (n: string) => computedSource[n] ?? '',
  };
  names.forEach((n, i) => { rootComputed[i] = n; });

  const root: Record<string, unknown> & {
    style: ReturnType<typeof createFakeStyle>;
    appendChild: (el: unknown) => void;
    removeChild: (el: unknown) => void;
  } = {
    style,
    appendChild: () => {},
    removeChild: () => {},
  };

  // @ts-expect-error Node 環境にスタブを注入
  globalThis.document = {
    documentElement: root,
    createElement: () => ({ style: createFakeStyle(), __isProbe: true }),
  };
  // @ts-expect-error Node 環境にスタブを注入
  globalThis.getComputedStyle = (el: unknown) => {
    if (el === root) return rootComputed;
    if ((el as { __isProbe?: boolean }).__isProbe) return { color: resolvedColor };
    return { length: 0, getPropertyValue: () => '' };
  };

  return { root, style };
}

// mermaid の動的 import をモック
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, _def: string) => ({ svg: '<svg data-test="ok"/>' })),
  },
}));

beforeEach(() => {
  // @ts-expect-error reset DOM stubs
  delete globalThis.document;
  // @ts-expect-error reset DOM stubs
  delete globalThis.getComputedStyle;
  vi.resetModules();
  vi.clearAllMocks();
});

async function loadFreshGateway() {
  const mod = await import('../src/lib/mermaid/render-gateway');
  mod.__testing.resetInitCache();
  return mod;
}

describe('render-gateway: snapshotAndNeutralize / restore', () => {
  it('detects oklch vars and overrides them with resolved rgb', async () => {
    const { root, style } = installDom({
      computedVars: {
        '--color-red-500': 'oklch(0.7 0.2 25)',
        '--color-blue-500': 'oklch(0.5 0.15 250)',
        '--color-non-oklch': 'rgb(100, 100, 100)',
      },
      resolvedColor: 'rgb(128, 128, 128)',
    });
    const { __testing } = await loadFreshGateway();

    const snap = __testing.snapshotAndNeutralize(root as unknown as HTMLElement);
    expect(snap.size).toBe(2);
    expect(snap.get('--color-red-500')).toBeNull();
    expect(snap.get('--color-blue-500')).toBeNull();
    expect(style.getPropertyValue('--color-red-500')).toBe('rgb(128, 128, 128)');
    expect(style.getPropertyValue('--color-blue-500')).toBe('rgb(128, 128, 128)');
    // non-oklch はスナップショットに含まれない
    expect(snap.has('--color-non-oklch')).toBe(false);
  });

  it('restore removes inline value when originally absent', async () => {
    const { root, style } = installDom({
      computedVars: { '--color-red-500': 'oklch(0.7 0.2 25)' },
      resolvedColor: 'rgb(10, 20, 30)',
    });
    const { __testing } = await loadFreshGateway();

    const snap = __testing.snapshotAndNeutralize(root as unknown as HTMLElement);
    expect(style.getPropertyValue('--color-red-500')).toBe('rgb(10, 20, 30)');
    __testing.restore(root as unknown as HTMLElement, snap);
    expect(style.getPropertyValue('--color-red-500')).toBe('');
  });

  it('restore reinstates original inline value when snapshot holds one', async () => {
    // snapshot を手動で組み立てる (スナップショットに既存 inline 値が入っているケース)
    // 実運用では並行呼び出しの直列化で発生しないが、restore 関数の単独動作を検証する
    const { root, style } = installDom({ computedVars: {} });
    const { __testing } = await loadFreshGateway();

    style.setProperty('--color-red-500', 'rgb(128, 128, 128)'); // 上書き中の rgb
    const snap = new Map<string, string | null>([
      ['--color-red-500', 'rgb(255, 0, 0)'], // 元の inline 値
    ]);

    __testing.restore(root as unknown as HTMLElement, snap);
    expect(style.getPropertyValue('--color-red-500')).toBe('rgb(255, 0, 0)');
  });
});

describe('render-gateway: withMermaidIsolation mutex', () => {
  it('serializes concurrent calls', async () => {
    installDom({ computedVars: {} });
    const { withMermaidIsolation } = await loadFreshGateway();

    const order: string[] = [];
    const p1 = withMermaidIsolation(async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end-1');
      return 1;
    });
    const p2 = withMermaidIsolation(async () => {
      order.push('start-2');
      await new Promise((r) => setTimeout(r, 5));
      order.push('end-2');
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('restores root on exception inside isolation', async () => {
    const { style } = installDom({
      computedVars: { '--color-red-500': 'oklch(0.7 0.2 25)' },
      resolvedColor: 'rgb(10, 20, 30)',
    });
    const { withMermaidIsolation } = await loadFreshGateway();

    await expect(
      withMermaidIsolation(async () => {
        expect(style.getPropertyValue('--color-red-500')).toBe('rgb(10, 20, 30)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(style.getPropertyValue('--color-red-500')).toBe('');
  });
});

describe('render-gateway: renderMermaid', () => {
  it('initializes mermaid once for same theme + htmlLabels', async () => {
    installDom({ computedVars: {} });
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');

    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'graph TD; A', elementId: 't1' });
    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'graph TD; B', elementId: 't2' });

    // theme+htmlLabels が同じなので initialize は 1 回のみ
    expect(mermaidMod.default.initialize).toHaveBeenCalledTimes(1);
  });

  it('re-initializes when theme changes', async () => {
    installDom({ computedVars: {} });
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');

    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'graph TD; A', elementId: 't1' });
    await renderMermaid({ theme: 'dark', htmlLabels: true, definition: 'graph TD; B', elementId: 't2' });
    await renderMermaid({ theme: 'modern', htmlLabels: true, definition: 'graph TD; C', elementId: 't3' });

    expect(mermaidMod.default.initialize).toHaveBeenCalledTimes(3);
  });
});

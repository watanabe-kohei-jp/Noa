import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Node 環境 (vitest environment: 'node') に最小 DOM を手動で差し込むテスト。
 * - document / getComputedStyle / styleSheets / createElement('canvas') を個別にスタブ
 * - CSSOM 列挙 (collectRootCustomPropNames) と canvas 正規化 (normalizeToSupportedColor)
 *   の両方を stub で検証できるようにする
 */

type PropMap = Map<string, string>;

function createStyleDecl(initial: Record<string, string> = {}) {
  const props: PropMap = new Map(Object.entries(initial));
  const decl: {
    length: number;
    setProperty(n: string, v: string): void;
    getPropertyValue(n: string): string;
    removeProperty(n: string): void;
    item(i: number): string;
  } = {
    get length() { return props.size; },
    setProperty(n, v) { props.set(n, String(v)); },
    getPropertyValue(n) { return props.get(n) ?? ''; },
    removeProperty(n) { props.delete(n); },
    item(i) { return Array.from(props.keys())[i] ?? ''; },
  };
  return decl;
}

interface InstallDomOpts {
  /** :root / html セレクタのルール内で定義された CSS 変数 (name -> value) */
  rootRuleVars?: Record<string, string>;
  /** documentElement の computed 値 */
  computedVars?: Record<string, string>;
  /** documentElement の inline スタイル初期値 */
  initialInlineVars?: Record<string, string>;
  /** canvas.fillStyle に値を入れたときに返す正規化済み文字列のマッピング */
  normalizeMap?: Record<string, string>;
}

function installDom(opts: InstallDomOpts = {}) {
  const {
    rootRuleVars = {},
    computedVars = {},
    initialInlineVars = {},
    normalizeMap = {},
  } = opts;

  const rootStyle = createStyleDecl(initialInlineVars);
  const computedSource = { ...computedVars, ...initialInlineVars };
  const rootComputed = createStyleDecl(computedSource);

  const ruleStyle = createStyleDecl(rootRuleVars);
  const rootRule: CSSStyleRule = {
    selectorText: ':root',
    style: ruleStyle as unknown as CSSStyleDeclaration,
    cssText: '',
    parentStyleSheet: null,
    parentRule: null,
    type: 1,
    STYLE_RULE: 1,
  } as unknown as CSSStyleRule;

  const cssRules = [rootRule] as unknown as CSSRuleList;
  (cssRules as unknown as { length: number }).length = 1;
  // Array.from 互換で iterable にする
  (cssRules as unknown as { [i: number]: CSSRule })[0] = rootRule as unknown as CSSRule;

  const sheet = { cssRules } as unknown as CSSStyleSheet;

  const root = {
    style: rootStyle,
  } as unknown as HTMLElement;

  // canvas 正規化スタブ: 与えた map で変換、未定義は値そのまま返す (brower が oklch を
  // rgb に落とす挙動を模倣)。sentinel を必ず黒にリセットする仕様もあわせる。
  let fillStyleHolder = '#000000';
  const fakeCtx = {
    get fillStyle() { return fillStyleHolder; },
    set fillStyle(v: string) {
      if (v === '#000000') { fillStyleHolder = '#000000'; return; }
      fillStyleHolder = normalizeMap[v] ?? v;
    },
  };

  // @ts-expect-error stub
  globalThis.document = {
    documentElement: root,
    styleSheets: { length: 1, 0: sheet } as unknown as StyleSheetList,
    createElement(tag: string) {
      if (tag === 'canvas') {
        return { getContext: (type: string) => (type === '2d' ? fakeCtx : null) };
      }
      return { style: createStyleDecl() };
    },
  };
  // @ts-expect-error stub
  globalThis.getComputedStyle = (el: unknown) => {
    if (el === root) return rootComputed;
    return createStyleDecl();
  };

  return { root, rootStyle, rootComputed, ruleStyle };
}

// mermaid の動的 import モック
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, _def: string) => ({ svg: '<svg data-test="ok"/>' })),
  },
}));

beforeEach(() => {
  // @ts-expect-error stub reset
  delete globalThis.document;
  // @ts-expect-error stub reset
  delete globalThis.getComputedStyle;
  vi.resetModules();
  vi.clearAllMocks();
});

async function loadFreshGateway() {
  const mod = await import('../src/lib/mermaid/render-gateway');
  mod.__testing.resetInitCache();
  mod.__testing.resetColorCtx();
  return mod;
}

describe('render-gateway: collectRootCustomPropNames (CSSOM 列挙)', () => {
  it('collects --* names from :root rule', async () => {
    installDom({
      rootRuleVars: {
        '--color-red-500': 'oklch(0.7 0.2 25)',
        '--color-blue-500': 'oklch(0.5 0.15 250)',
        '--spacing': '8px',
      },
    });
    const { __testing } = await loadFreshGateway();
    const names = __testing.collectRootCustomPropNames(document);
    expect(names).toEqual(
      expect.arrayContaining(['--color-red-500', '--color-blue-500', '--spacing']),
    );
  });

  it('survives SecurityError when a sheet is cross-origin', async () => {
    installDom({ rootRuleVars: { '--color-red-500': 'oklch(0.7 0.2 25)' } });
    // 2 枚目の sheet を cross-origin シミュレーションとして追加
    const corsSheet = {
      get cssRules() { throw new DOMException('SecurityError', 'SecurityError'); },
    } as unknown as CSSStyleSheet;
    // @ts-expect-error extend stub
    document.styleSheets = { length: 2, 0: document.styleSheets[0], 1: corsSheet };

    const { __testing } = await loadFreshGateway();
    const names = __testing.collectRootCustomPropNames(document);
    expect(names).toContain('--color-red-500');
  });
});

describe('render-gateway: normalizeToSupportedColor (canvas 正規化)', () => {
  it('returns normalized rgb when canvas accepts the color', async () => {
    installDom({ normalizeMap: { 'oklch(0.7 0.2 25)': 'rgb(200, 10, 10)' } });
    const { __testing } = await loadFreshGateway();
    expect(__testing.normalizeToSupportedColor('oklch(0.7 0.2 25)')).toBe('rgb(200, 10, 10)');
  });

  it('falls back to #000000 when canvas 2d context is unavailable', async () => {
    // canvas.getContext が null を返すケース
    // @ts-expect-error stub
    globalThis.document = {
      documentElement: { style: createStyleDecl() },
      styleSheets: { length: 0 },
      createElement: () => ({ getContext: () => null }),
    };
    // @ts-expect-error stub
    globalThis.getComputedStyle = () => createStyleDecl();
    const { __testing } = await loadFreshGateway();
    expect(__testing.normalizeToSupportedColor('oklch(0.7 0.2 25)')).toBe('#000000');
  });
});

describe('render-gateway: neutralizeOklchVars / restore', () => {
  it('neutralizes only oklch vars and snapshot records original state', async () => {
    const { root, rootStyle } = installDom({
      rootRuleVars: {
        '--color-red-500': '',
        '--color-blue-500': '',
        '--color-plain': '',
      },
      computedVars: {
        '--color-red-500': 'oklch(0.7 0.2 25)',
        '--color-blue-500': 'oklch(0.5 0.15 250)',
        '--color-plain': 'rgb(100, 100, 100)',
      },
      normalizeMap: {
        'oklch(0.7 0.2 25)': 'rgb(200, 10, 10)',
        'oklch(0.5 0.15 250)': 'rgb(10, 10, 200)',
      },
    });
    const { __testing } = await loadFreshGateway();

    const snap = __testing.neutralizeOklchVars(root, document);
    expect(snap.size).toBe(2);
    expect(snap.get('--color-red-500')).toBeNull();
    expect(snap.get('--color-blue-500')).toBeNull();
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('rgb(200, 10, 10)');
    expect(rootStyle.getPropertyValue('--color-blue-500')).toBe('rgb(10, 10, 200)');
    // non-oklch は触らない
    expect(snap.has('--color-plain')).toBe(false);

    __testing.restore(root, snap);
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('');
    expect(rootStyle.getPropertyValue('--color-blue-500')).toBe('');
  });

  it('restore reinstates original inline value when snapshot holds one', async () => {
    const { root, rootStyle } = installDom();
    const { __testing } = await loadFreshGateway();

    rootStyle.setProperty('--color-red-500', 'rgb(128, 128, 128)');
    const snap = new Map<string, string | null>([
      ['--color-red-500', 'rgb(255, 0, 0)'],
    ]);
    __testing.restore(root, snap);
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('rgb(255, 0, 0)');
  });
});

describe('render-gateway: renderMermaid integration', () => {
  it('neutralizes during render and restores after', async () => {
    const { rootStyle } = installDom({
      rootRuleVars: { '--color-red-500': '' },
      computedVars: { '--color-red-500': 'oklch(0.7 0.2 25)' },
      normalizeMap: { 'oklch(0.7 0.2 25)': 'rgb(200, 10, 10)' },
    });
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');

    // mermaid.render 内で差し替え状態を観察
    (mermaidMod.default.render as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(rootStyle.getPropertyValue('--color-red-500')).toBe('rgb(200, 10, 10)');
      return { svg: '<svg/>' };
    });

    const result = await renderMermaid({
      theme: 'light', htmlLabels: true, definition: 'graph TD; A', elementId: 't1',
    });
    expect(result.svg).toBe('<svg/>');
    // render 完了後は復帰済み (元々 inline 無しなので空)
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('');
  });

  it('restores root even when render throws', async () => {
    const { rootStyle } = installDom({
      rootRuleVars: { '--color-red-500': '' },
      computedVars: { '--color-red-500': 'oklch(0.7 0.2 25)' },
      normalizeMap: { 'oklch(0.7 0.2 25)': 'rgb(200, 10, 10)' },
    });
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');
    (mermaidMod.default.render as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await expect(
      renderMermaid({ theme: 'light', htmlLabels: true, definition: 'graph TD; A', elementId: 't1' }),
    ).rejects.toThrow('boom');
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('');
  });

  it('initializes mermaid once for same theme + htmlLabels', async () => {
    installDom();
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');

    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'g', elementId: 't1' });
    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'g', elementId: 't2' });
    expect(mermaidMod.default.initialize).toHaveBeenCalledTimes(1);
  });

  it('re-initializes when theme changes', async () => {
    installDom();
    const { renderMermaid } = await loadFreshGateway();
    const mermaidMod = await import('mermaid');

    await renderMermaid({ theme: 'light', htmlLabels: true, definition: 'g', elementId: 't1' });
    await renderMermaid({ theme: 'dark', htmlLabels: true, definition: 'g', elementId: 't2' });
    await renderMermaid({ theme: 'modern', htmlLabels: true, definition: 'g', elementId: 't3' });
    expect(mermaidMod.default.initialize).toHaveBeenCalledTimes(3);
  });
});

describe('render-gateway: withLock mutex', () => {
  it('serializes concurrent calls', async () => {
    installDom();
    const { __testing } = await loadFreshGateway();

    const order: string[] = [];
    const p1 = __testing.withLock(async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 15));
      order.push('end-1');
      return 1;
    });
    const p2 = __testing.withLock(async () => {
      order.push('start-2');
      order.push('end-2');
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('continues the queue after a rejected task', async () => {
    installDom();
    const { __testing } = await loadFreshGateway();
    await expect(__testing.withLock(async () => { throw new Error('x'); })).rejects.toThrow('x');
    const r = await __testing.withLock(async () => 42);
    expect(r).toBe(42);
  });
});

describe('render-gateway: neutralizeDocOklch (onclone 用)', () => {
  it('neutralizes the cloned document without touching live root snapshot', async () => {
    const { root, rootStyle } = installDom({
      rootRuleVars: { '--color-red-500': '' },
      computedVars: { '--color-red-500': 'oklch(0.7 0.2 25)' },
      normalizeMap: { 'oklch(0.7 0.2 25)': 'rgb(200, 10, 10)' },
    });
    const { neutralizeDocOklch } = await loadFreshGateway();

    // neutralizeDocOklch は引数に渡された document の root を直接書き換える
    // (onclone のユースケース: clone は短寿命で破棄されるので restore しない)
    neutralizeDocOklch(document);
    expect(rootStyle.getPropertyValue('--color-red-500')).toBe('rgb(200, 10, 10)');

    // root 参照は install した root そのもの (clone ではない) だが、
    // onclone 内では渡される clonedDoc に対して同じ処理をする API であることを確認
    expect(root).toBe(document.documentElement);
  });
});

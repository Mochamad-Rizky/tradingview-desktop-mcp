import { z } from 'zod';
import type { PageHandle } from '../../../../src/core/connection.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { uiEvaluate } from '../../../../src/tools/ui/evaluate.js';
import { uiTools } from '../../../../src/tools/ui/index.js';
import { uiPressKey, uiTypeText } from '../../../../src/tools/ui/keyboard.js';
import { uiFullscreen, uiOpenPanel } from '../../../../src/tools/ui/panels.js';
import {
  uiClick,
  uiFindElement,
  uiHover,
  uiScroll,
  uiTargetPage,
} from '../../../../src/tools/ui/pointer.js';

// What the model and the client see of the ui tools: their names, annotations, input schemas and
// descriptions, and the page each acts on. Their behavior is tested through a server in
// test/integration/tools/ui.test.ts, and the guard behind them in test/unit/core/tv/input.test.ts.

const names = (tools: { name: string }[]) => tools.map(({ name }) => name);

test('uiTools lists the tools of the ui domain in the order of the catalog of the design', () => {
  expect(uiTools).toEqual([
    uiClick,
    uiHover,
    uiTypeText,
    uiPressKey,
    uiScroll,
    uiFindElement,
    uiOpenPanel,
    uiFullscreen,
    uiEvaluate,
  ]);
  expect(names(uiTools)).toEqual([
    'ui_click',
    'ui_hover',
    'ui_type_text',
    'ui_press_key',
    'ui_scroll',
    'ui_find_element',
    'ui_open_panel',
    'ui_fullscreen',
    'ui_evaluate',
  ]);
  for (const tool of uiTools) {
    expect(tool.domain, tool.name).toBe('ui');
  }
});

test('the catalog lists the ui tools after the screenshot tool and before the batch', () => {
  const catalog = names(allTools);
  const first = catalog.indexOf('ui_click');

  expect(first).toBeGreaterThan(catalog.indexOf('screenshot_capture'));
  expect(catalog.slice(first, first + uiTools.length)).toEqual(names(uiTools));
  expect(catalog.indexOf('ui_evaluate')).toBeLessThan(catalog.indexOf('batch_run'));
});

test('ui_type_text, ui_press_key, ui_fullscreen and ui_evaluate can change what a user can, so they are destructive', () => {
  for (const tool of [uiTypeText, uiPressKey, uiEvaluate]) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
  // Asking for the same mode twice changes nothing more.
  expect(uiFullscreen.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('ui_evaluate and ui_type_text keep their arguments out of the tool events, and only they do', () => {
  expect(uiTools.filter((tool) => tool.redactArgs === true)).toEqual([uiTypeText, uiEvaluate]);
});

test('ui_open_panel changes the interface, and asking twice changes nothing more', () => {
  expect(uiOpenPanel.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('ui_evaluate is offered by the full profile only', () => {
  const offered = (profile: 'full' | 'core' | 'readonly') =>
    names(selectTools(allTools, { profile, patterns: [] }));

  expect(offered('full')).toContain('ui_evaluate');
  expect(offered('core')).not.toContain('ui_evaluate');
  expect(offered('readonly')).not.toContain('ui_evaluate');
  for (const name of ['ui_type_text', 'ui_press_key', 'ui_open_panel', 'ui_fullscreen']) {
    expect(offered('readonly'), name).not.toContain(name);
  }
});

test('ui_click and ui_scroll can change anything a user can, so they are destructive', () => {
  for (const tool of [uiClick, uiScroll]) {
    expect(tool.annotations, tool.name).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
  const readonly = names(selectTools(allTools, { profile: 'readonly', patterns: [] }));
  expect(readonly).not.toContain('ui_click');
  expect(readonly).not.toContain('ui_scroll');
});

test('ui_hover and ui_find_element only read, so the readonly profile offers them', () => {
  expect(uiHover.annotations).toBe(READ_ONLY);
  expect(uiFindElement.annotations).toBe(READ_ONLY);
  expect(names(selectTools(allTools, { profile: 'readonly', patterns: [] }))).toEqual(
    expect.arrayContaining(['ui_hover', 'ui_find_element']),
  );
});

test('the ui tools are left out of the core profile until the core set is chosen', () => {
  const core = names(selectTools(allTools, { profile: 'core', patterns: [] }));

  for (const tool of uiTools) {
    expect(tool.core, tool.name).toBeUndefined();
    expect(core, tool.name).not.toContain(tool.name);
  }
});

describe('the input schemas', () => {
  const click = z.object(uiClick.inputSchema);
  const hover = z.object(uiHover.inputSchema);
  const scroll = z.object(uiScroll.inputSchema);
  const find = z.object(uiFindElement.inputSchema);
  const type = z.object(uiTypeText.inputSchema);
  const key = z.object(uiPressKey.inputSchema);
  const panel = z.object(uiOpenPanel.inputSchema);
  const fullscreen = z.object(uiFullscreen.inputSchema);
  const evaluate = z.object(uiEvaluate.inputSchema);

  test('ui_type_text and ui_press_key act on the chart by default', () => {
    expect(type.parse({ text: 'AAPL' })).toEqual({ text: 'AAPL', target: 'chart' });
    expect(type.parse({ text: 'x'.repeat(1000), target: 'window' })).toMatchObject({
      target: 'window',
    });
    expect(key.parse({ key: 'Enter' })).toEqual({ key: 'Enter', target: 'chart' });
    expect(key.parse({ key: 'z', modifiers: ['Control', 'Shift'] })).toEqual({
      key: 'z',
      modifiers: ['Control', 'Shift'],
      target: 'chart',
    });
  });

  test('ui_open_panel opens a panel by default, and ui_fullscreen takes enabled', () => {
    for (const name of ['watchlist', 'alerts', 'object_tree', 'data_window', 'pine_editor']) {
      expect(panel.parse({ panel: name })).toEqual({ panel: name, open: true });
    }
    expect(panel.parse({ panel: 'alerts', open: false })).toEqual({ panel: 'alerts', open: false });
    expect(fullscreen.parse({ enabled: false })).toEqual({ enabled: false });
  });

  test('ui_evaluate takes an expression of up to 10000 characters, and nothing else', () => {
    expect(evaluate.parse({ expression: '1 + 1' })).toEqual({ expression: '1 + 1' });
    expect(evaluate.parse({ expression: 'x'.repeat(10_000) })).toMatchObject({});
    expect(Object.keys(uiEvaluate.inputSchema)).toEqual(['expression']);
  });

  test('ui_click and ui_hover take a selector, a text or a point, on the chart by default', () => {
    for (const schema of [click, hover]) {
      expect(schema.parse({ selector: '#a' })).toEqual({ selector: '#a', target: 'chart' });
      expect(schema.parse({ text: 'Apply', target: 'window' })).toEqual({
        text: 'Apply',
        target: 'window',
      });
      expect(schema.parse({ x: 10.5, y: -3 })).toEqual({ x: 10.5, y: -3, target: 'chart' });
    }
  });

  test('ui_scroll takes deltaY, and deltaX defaults to 0', () => {
    expect(scroll.parse({ selector: '#a', deltaY: 120 })).toEqual({
      selector: '#a',
      deltaX: 0,
      deltaY: 120,
      target: 'chart',
    });
    expect(scroll.parse({ x: 1, y: 2, deltaX: -10000, deltaY: 10000 })).toMatchObject({
      deltaX: -10000,
      deltaY: 10000,
    });
  });

  test('ui_find_element lists at most 10 elements by default, and up to 50', () => {
    expect(find.parse({ text: 'Apply' })).toEqual({ text: 'Apply', target: 'chart', limit: 10 });
    expect(find.parse({ selector: 'button', limit: 50 })).toMatchObject({ limit: 50 });
    expect(find.parse({ selector: 'button', limit: 1 })).toMatchObject({ limit: 1 });
  });

  test.each<[string, z.ZodType, Record<string, unknown>]>([
    [
      'ui_click, a target that is neither chart nor window',
      click,
      { selector: '#a', target: 'tab' },
    ],
    ['ui_click, an empty selector', click, { selector: '' }],
    ['ui_click, an empty text', click, { text: '' }],
    ['ui_click, a text over 200 characters', click, { text: 'x'.repeat(201) }],
    ['ui_click, a point given as text', click, { x: '10', y: '20' }],
    ['ui_hover, a selector over 1000 characters', hover, { selector: 'a'.repeat(1001) }],
    ['ui_scroll, no deltaY', scroll, { selector: '#a' }],
    ['ui_scroll, a deltaY over 10000', scroll, { selector: '#a', deltaY: 10001 }],
    ['ui_scroll, a deltaX under -10000', scroll, { selector: '#a', deltaX: -10001, deltaY: 1 }],
    ['ui_find_element, a limit of 0', find, { selector: 'a', limit: 0 }],
    ['ui_find_element, a limit of 51', find, { selector: 'a', limit: 51 }],
    ['ui_find_element, a limit that is not whole', find, { selector: 'a', limit: 2.5 }],
    ['ui_type_text, an empty text', type, { text: '' }],
    ['ui_type_text, a text over 1000 characters', type, { text: 'x'.repeat(1001) }],
    ['ui_press_key, no key', key, {}],
    ['ui_press_key, a modifier it does not know', key, { key: 'a', modifiers: ['Hyper'] }],
    ['ui_open_panel, a panel it does not know', panel, { panel: 'news' }],
    ['ui_fullscreen, no enabled', fullscreen, {}],
    ['ui_evaluate, an empty expression', evaluate, { expression: '' }],
    [
      'ui_evaluate, an expression over 10000 characters',
      evaluate,
      { expression: 'x'.repeat(10_001) },
    ],
  ])('refuses %s', (_case, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('the descriptions', () => {
  test('say plainly that trading controls are never acted on, and why', () => {
    for (const tool of [uiClick, uiHover, uiScroll]) {
      expect(tool.description, tool.name).toMatch(/[Tt]rading controls are never/);
      expect(tool.description, tool.name).toMatch(/buy and sell buttons/);
      expect(tool.description, tool.name).toMatch(/UNSAFE_ACTION_BLOCKED/);
      expect(tool.description, tool.name).toMatch(/places no orders/);
      // What covers a target refuses it too, for the reason given.
      expect(tool.description, tool.name).toMatch(/dialog, a menu, a popup or a frame/);
      expect(tool.description, tool.name).toMatch(/cannot be told/);
      expect(tool.description, tool.name).toMatch(/NOT_AVAILABLE/);
    }
  });

  test('say how a target is given and what comes back', () => {
    for (const tool of [uiClick, uiHover]) {
      for (const word of ['selector', 'text', 'x and y', 'CSS pixels', 'chart', 'window']) {
        expect(tool.description, `${tool.name}: ${word}`).toContain(word);
      }
      expect(tool.description, tool.name).toMatch(/INVALID_INPUT/);
      expect(tool.description, tool.name).toMatch(/Returns target, by/);
    }
    expect(uiScroll.description).toMatch(/deltaY/);
    expect(uiScroll.description).toMatch(/No button is pressed/);
    expect(uiHover.description).toMatch(/without pressing a button/);
  });

  test('ui_click says it refuses containers of trading controls and trading actions by name, as words', () => {
    const { description } = uiClick;

    expect(description).toMatch(
      /holds a trading control, whether it is the target, lies at the point, or covers the center/,
    );
    expect(description).toMatch(/named after a trading action/);
    for (const words of [
      'the word Buy or Sell',
      'modifying an order',
      'flattening a position',
      'Close all, Flatten or Reverse',
      'as words',
    ]) {
      expect(description, words).toContain(words);
    }
    // Every source of a name counts on its own, the text shown under an aria-label included.
    expect(description).toMatch(/value of an input button or the text shown \(each on its own/);
    // A div that only the pointer cursor shows as clickable counts as the control too.
    expect(description).toMatch(/the element around it that the pointer cursor shows as clickable/);
    expect(description).toMatch(/parts apart and run together/);
    // Point clicks on areas that show such words are refused, and the way around it is said.
    expect(description).toMatch(/point click on a panel, a legend or another area/);
    expect(description).toMatch(/click the specific control by selector instead/);
    expect(description).toMatch(/does not report its zoom/);
  });

  test('ui_find_element says it changes nothing and never reads what a field holds', () => {
    const { description } = uiFindElement;

    expect(description).toMatch(/Changes nothing/);
    expect(description).toMatch(/never read/);
    for (const word of [
      'selector',
      'tag',
      'role',
      'name',
      'text',
      'rect',
      'visible',
      'unsafe',
      'holdsUnsafe',
    ]) {
      expect(description, word).toContain(word);
    }
    expect(description).toMatch(/editable region is never read/);
    expect(description).toMatch(/1 to 50, default 10/);
    expect(description).toMatch(/INVALID_INPUT/);
  });
});

describe('the descriptions of the keyboard, panel, fullscreen and evaluate tools', () => {
  test('ui_type_text types into a focused text field only and refuses trading controls', () => {
    const { description } = uiTypeText;

    expect(description).toMatch(/text field that has the focus/);
    expect(description).toMatch(/no key events/);
    expect(description).toMatch(/NOT_AVAILABLE/);
    expect(description).toMatch(/UNSAFE_ACTION_BLOCKED/);
    expect(description).toMatch(/frame or a shadow root/);
  });

  test('ui_press_key lists its keys and says which keys are refused, and why', () => {
    const { description } = uiPressKey;

    for (const word of ['Enter', 'Escape', 'PageDown', 'letter', 'a digit', 'Alt', 'Meta']) {
      expect(description, word).toContain(word);
    }
    expect(description).toMatch(/places no orders/);
    expect(description).toMatch(/UNSAFE_ACTION_BLOCKED/);
    expect(description).toMatch(/default button/);
    // The rule of the names, exactly: the control, the pointer-cursor ancestor, and no text of a
    // focused element that is no control.
    expect(description).toMatch(/closest button, link or element with the role of one/);
    expect(description).toMatch(/up to six levels up, that the pointer cursor shows as clickable/);
    expect(description).toMatch(/text a focused element that is no control shows is not read/);
    // The gap that remains is said plainly.
    expect(description).toMatch(/key chord/);
  });

  test('ui_open_panel names its panels and says how the Pine Editor opens and closes', () => {
    const { description } = uiOpenPanel;

    for (const word of ['watchlist', 'alerts', 'object_tree', 'data_window', 'pine_editor']) {
      expect(description, word).toContain(word);
    }
    expect(description).toMatch(/changed false/);
    expect(description).toMatch(/without discarding its text/);
    expect(description).toMatch(/shows the Pine Editor but has no open editor to close/);
    expect(description).toMatch(/cannot say whether it is shown/);
    expect(description).toMatch(/app_get_ui_state/);
  });

  test("ui_fullscreen says it is TradingView's own mode and what observed is", () => {
    const { description } = uiFullscreen;

    expect(description).toMatch(/TradingView's own fullscreen mode/);
    expect(description).toMatch(/observed/);
    expect(description).toMatch(/null/);
  });

  test('ui_evaluate says it is a power tool, off by default, and that its denylist is best effort', () => {
    const { description } = uiEvaluate;

    expect(description).toMatch(/power tool/);
    expect(description).toMatch(/off by default/);
    expect(description).toMatch(/TV_MCP_ALLOW_EVAL=true/);
    expect(description).toMatch(/--allow-eval/);
    expect(description).toMatch(/best effort/);
    expect(description).toMatch(/chart tab/);
    expect(description).toMatch(/never in the window chrome/);
    expect(description).toMatch(/100 kB/);
    expect(description).toMatch(/UNSAFE_ACTION_BLOCKED/);
    // The objects themselves are withheld, not what the code copies out of them.
    expect(description).toMatch(/those objects themselves/);
    expect(description).toMatch(/what the code reads out of them or copies is not recognised/);
  });
});

test('uiTargetPage acts on the chart tab or on the window chrome', async () => {
  const chart = { target: { id: 'CHART' } } as unknown as PageHandle;
  const chrome = { target: { id: 'CHROME' } } as unknown as PageHandle;
  const connection = {
    chartPage: () => Promise.resolve(chart),
    windowChromePage: () => Promise.resolve(chrome),
  };
  const ctx = { connection } as unknown as Parameters<typeof uiTargetPage>[0];

  await expect(uiTargetPage(ctx, 'chart')).resolves.toBe(chart);
  await expect(uiTargetPage(ctx, 'window')).resolves.toBe(chrome);
});

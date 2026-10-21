import { z } from 'zod';
import type { PageHandle } from '../../../../src/core/connection.js';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { uiTools } from '../../../../src/tools/ui/index.js';
import {
  uiClick,
  uiFindElement,
  uiHover,
  uiScroll,
  uiTargetPage,
} from '../../../../src/tools/ui/pointer.js';

// What the model and the client see of the pointer tools: their names, annotations, input schemas
// and descriptions, and the page each acts on. Their behavior is tested through a server in
// test/integration/tools/ui.test.ts, and the guard behind them in test/unit/core/tv/input.test.ts.

const names = (tools: { name: string }[]) => tools.map(({ name }) => name);

test('uiTools lists the pointer tools of the ui domain', () => {
  expect(uiTools).toEqual([uiClick, uiHover, uiScroll, uiFindElement]);
  expect(names(uiTools)).toEqual(['ui_click', 'ui_hover', 'ui_scroll', 'ui_find_element']);
  for (const tool of uiTools) {
    expect(tool.domain, tool.name).toBe('ui');
  }
});

test('the catalog lists the ui tools after the screenshot tool and before the batch', () => {
  const catalog = names(allTools);
  const first = catalog.indexOf('ui_click');

  expect(first).toBeGreaterThan(catalog.indexOf('screenshot_capture'));
  expect(catalog.slice(first, first + 4)).toEqual(names(uiTools));
  expect(catalog.indexOf('ui_find_element')).toBeLessThan(catalog.indexOf('batch_run'));
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

  test('ui_click says it refuses containers of trading controls and trading actions by name', () => {
    const { description } = uiClick;

    expect(description).toMatch(/holds a trading control, a point where such an element lies/);
    expect(description).toMatch(/named after a trading action/);
    for (const action of ['Buy or Sell', 'Place order', 'Close position', 'Reverse', 'Flatten']) {
      expect(description, action).toContain(action);
    }
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

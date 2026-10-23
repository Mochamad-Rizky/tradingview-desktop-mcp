import { z } from 'zod';
import type { PageHandle } from '../../core/connection.js';
import { TvMcpError } from '../../core/errors.js';
import {
  clickTarget,
  findElements,
  hoverTarget,
  NAME_RULE,
  scrollAt,
  type PointerTarget,
} from '../../core/tv/input.js';
import { UNSAFE_SELECTORS } from '../../core/tv/selectors.js';
import { CHANGES_IDEMPOTENT, DESTRUCTIVE, READ_ONLY } from '../annotations.js';
import { defineTool, type ToolContext } from '../types.js';

// The pointer tools of the low-level interface (design spec 7, domain Low-level UI): a click, a
// hover and a turn of the mouse wheel at an element of TradingView or at a point, and the look-up
// of the elements to aim them at. They are for what no other tool reaches, and they act on the
// user's live, signed-in app, where a click on a trading control could place a real order. So they
// go through the guarded input helpers (core/tv/input.ts) and nothing else: a trading control (the
// buy and sell buttons and the trade button), a point where one lies, and a target that a dialog, a
// menu, a popup or a frame covers are refused before anything is sent, and so is a click on an
// element that holds a trading control or is named after a trading action; the target is looked at
// again once the pointer is on it, and the calls of a page run one at a time.
//
// The window chrome, the page with the tab strip, has Node integration. The tools only read its DOM
// there, through the page functions of the input helpers, ask it for its layout, and send it input
// events; they never evaluate anything else in it.

const TARGETS = ['chart', 'window'] as const;

export type UiTarget = (typeof TARGETS)[number];

// How the target of a call was given, as its result says.
type AimedBy = 'selector' | 'text' | 'point';

const MAX_SELECTOR = 1000;
const MAX_TEXT = 200;
const MAX_DELTA = 10_000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// The refusals that the descriptions of the three tools that move the pointer share, word for word
// but for what the tool does.
function refusals(done: 'clicked' | 'hovered over' | 'scrolled over'): string {
  return (
    `Trading controls are never ${done}, because this server places no orders: the buy and sell ` +
    'buttons and the trade button, anything inside them, and any point where one lies are ' +
    'refused with UNSAFE_ACTION_BLOCKED before anything is sent. So is, with NOT_AVAILABLE, a ' +
    'target that a dialog, a menu, a popup or a frame covers, a point inside an open menu or ' +
    'dialog included (aim at its item by selector or text instead): the event would go to that, ' +
    'and what it is cannot be told.'
  );
}

// The names a click is refused on, as the tools describe them.
export const TRADING_NAMES =
  'the word Buy or Sell; placing, submitting, sending, cancelling or modifying an order; closing, ' +
  'exiting, reversing or flattening a position; Close all, Flatten or Reverse';

// The page a ui tool acts on: the chart tab, or the window chrome, the strip with the tabs.
export function uiTargetPage(
  ctx: Pick<ToolContext, 'connection'>,
  target: UiTarget,
): Promise<PageHandle> {
  return target === 'window' ? ctx.connection.windowChromePage() : ctx.connection.chartPage();
}

export function targetInput() {
  return z
    .enum(TARGETS)
    .default('chart')
    .describe(
      'Which page to act on: chart (default) is the chart tab; window is the window chrome, the ' +
        'strip with the tabs of the app.',
    );
}

function selectorInput() {
  return z
    .string()
    .min(1)
    .max(MAX_SELECTOR)
    .optional()
    .describe(
      'A CSS selector: the first element that matches is the target, at the center of its box. ' +
        'Prefer stable attributes, an id, data-qa-id, data-name or aria-label, as ui_find_element ' +
        'gives them: the class names of TradingView change with every build.',
    );
}

function textInput() {
  return z
    .string()
    .min(1)
    .max(MAX_TEXT)
    .optional()
    .describe(
      'The name of the target: the first visible element whose name equals this is the target, at ' +
        `the center of its box. A name is ${NAME_RULE}.`,
    );
}

function coordinateInput(axis: 'x' | 'y') {
  const [edge, other] = axis === 'x' ? ['left', 'y'] : ['top', 'x'];
  return z
    .number()
    .optional()
    .describe(
      `With ${other}: the point to act at, in CSS pixels from the ${edge} edge of the visible part ` +
        'of the page, as ui_find_element reports rect. Rounded to whole pixels. A point outside ' +
        'the visible part is INVALID_INPUT.',
    );
}

function missingTarget(withText: boolean): TvMcpError {
  return new TvMcpError(
    'INVALID_INPUT',
    withText
      ? 'Give exactly one target: selector, text, or both x and y'
      : 'Give exactly one target: selector, or both x and y',
    {
      hint: withText
        ? 'Aim at an element by selector or by its name (text), or at a point by x and y.'
        : 'Aim at an element by selector, or at a point by x and y.',
    },
  );
}

// The target of a pointer tool: exactly one of a selector, a text, or both x and y. A point outside
// the page is for the page to tell, which the input helpers ask.
function pointerTargetOf(
  input: {
    selector?: string | undefined;
    text?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
  },
  withText: boolean,
): { target: PointerTarget; by: AimedBy } {
  const { selector, text, x, y } = input;
  const given = [selector, text, x ?? y].filter((value) => value !== undefined).length;
  if (given !== 1) {
    throw missingTarget(withText);
  }
  if (selector !== undefined) {
    return { target: { selector }, by: 'selector' };
  }
  if (text !== undefined) {
    if (text.trim() === '') {
      throw new TvMcpError('INVALID_INPUT', 'The text to look for is empty', {
        hint: `Give the name of the element: ${NAME_RULE}.`,
      });
    }
    return { target: { text }, by: 'text' };
  }
  if (x === undefined || y === undefined) {
    throw new TvMcpError('INVALID_INPUT', 'A point needs both x and y', {
      hint: 'Give x and y together, in CSS pixels from the top left of the visible part of the page.',
    });
  }
  return { target: { x, y }, by: 'point' };
}

export const uiClick = defineTool({
  name: 'ui_click',
  domain: 'ui',
  title: 'Click an element',
  description:
    'Clicks an element of TradingView, or a point of it, once with the left mouse button, the way ' +
    'a user would. Use it only where no other tool does the job: a click can change anything a ' +
    "user's click can. Give exactly one target: selector (the first element that matches), text " +
    `(the first visible element whose name equals it; a name is ${NAME_RULE}) or x ` +
    "and y (a point in CSS pixels from the top left of the page's visible part, as " +
    'ui_find_element reports rect). An element is clicked at the center of its box. target chart ' +
    '(default) is the chart tab; window is the window chrome, the strip with the tabs. ' +
    refusals('clicked') +
    ' A click is also refused on an element that holds a trading control, whether it is the ' +
    'target, lies at the point, or covers the center of the target, and on anything named after ' +
    'a trading action, because an order ticket has no selector to tell it by: an aria-label, the ' +
    'value of an input button, the text shown or the title of an element nothing else names (each ' +
    'on its own, so the text shown counts under an aria-label that says something else) that ' +
    `holds ${TRADING_NAMES}, as words, of the ` +
    'target, of what lies at the point, or of the button that holds it or the element around it ' +
    'that the pointer cursor shows as clickable (up to six levels up). The text shown is read ' +
    'with its parts apart and run together, so a word split into elements still counts. A point ' +
    'click lands on the element there and reads all the text it shows: a point click on a panel, ' +
    'a legend or another area whose text shows such a word is refused, so click the specific ' +
    'control by selector instead. The refusal quotes the words that matched. The ' +
    'pointer moves onto the target first, and the button goes down only if the target still ' +
    'looks the same once the pointer is there, so a menu that opens on hover stops the click. ' +
    'Also NOT_AVAILABLE: a page that does not report its zoom, no ' +
    'element matches the selector, the element is hidden or out of view, or the page cannot say ' +
    'what lies there. INVALID_INPUT: a text that no visible element has (ui_find_element lists the ' +
    'names), a point outside the visible part, an invalid selector. Returns target, by (selector, ' +
    'text or point) and point, where the button went down, in CSS pixels.',
  inputSchema: {
    selector: selectorInput(),
    text: textInput(),
    x: coordinateInput('x'),
    y: coordinateInput('y'),
    target: targetInput(),
  },
  // A click or a turn of the wheel can change anything one of the user can, and doing one twice is
  // not doing it once.
  annotations: DESTRUCTIVE,
  async handler({ selector, text, x, y, target }, ctx) {
    const aimed = pointerTargetOf({ selector, text, x, y }, true);
    const page = await uiTargetPage(ctx, target);
    const point = await clickTarget(page, aimed.target);
    return { data: { target, by: aimed.by, point }, via: 'cdp' };
  },
});

export const uiHover = defineTool({
  name: 'ui_hover',
  domain: 'ui',
  title: 'Hover over an element',
  description:
    'Moves the mouse pointer onto an element of TradingView, or to a point of it, without pressing ' +
    'a button, to show what the app shows on hover: a tooltip, the buttons of a legend item or of ' +
    'a pane, a menu that opens on hover. Give exactly one target, as for ui_click: selector, text ' +
    "(the name, as ui_click reads it) or x and y (CSS pixels of the page's " +
    'visible part); target chart (default) or window, the window chrome. ' +
    refusals('hovered over') +
    ' Unlike a click, an element that only holds a trading control, such as the chart pane, can be ' +
    'hovered: the pointer lands on the element itself, and what lies at that point is what counts. ' +
    'The page is looked at again once the pointer is there, and a warning says when a trading ' +
    'control or a menu lies under it then, or the target is gone; a target that moved is followed. ' +
    'It changes nothing by itself, but the app may open a tooltip or a menu. NOT_AVAILABLE and ' +
    'INVALID_INPUT as for ui_click. Returns target, by (selector, text or point) and point, where ' +
    'the pointer is, in CSS pixels.',
  inputSchema: {
    selector: selectorInput(),
    text: textInput(),
    x: coordinateInput('x'),
    y: coordinateInput('y'),
    target: targetInput(),
  },
  // It sends mouse moves, which can open a tooltip or a menu of the app, so it does not only read;
  // hovering again at the same place changes nothing more.
  annotations: CHANGES_IDEMPOTENT,
  async handler({ selector, text, x, y, target }, ctx) {
    const aimed = pointerTargetOf({ selector, text, x, y }, true);
    const page = await uiTargetPage(ctx, target);
    const { point, warning } = await hoverTarget(page, aimed.target);
    return {
      data: { target, by: aimed.by, point },
      via: 'cdp',
      warnings: warning === null ? [] : [warning],
    };
  },
});

export const uiScroll = defineTool({
  name: 'ui_scroll',
  domain: 'ui',
  title: 'Scroll with the mouse wheel',
  description:
    'Turns the mouse wheel once over an element of TradingView (selector, at the center of its ' +
    'box) or a point (x and y, CSS pixels of the visible part of the page), the way a user ' +
    'scrolls: deltaY above 0 scrolls down and below 0 up, deltaX above 0 to the right, in CSS ' +
    'pixels (deltaX defaults to 0). A list or a panel scrolls; over the chart, TradingView may ' +
    'take the wheel to zoom or scroll the time scale instead. Give exactly one of selector, or x ' +
    'and y; target chart (default) or window, the window chrome. ' +
    refusals('scrolled over') +
    ' An element that only holds a trading control, such as the chart pane, can be scrolled. The ' +
    'pointer moves onto the target first, and the wheel turns only if the target still looks the ' +
    'same then. No button is pressed. NOT_AVAILABLE and INVALID_INPUT as for ui_click. Returns ' +
    'target, by (selector or point), point (where the wheel turned, in CSS pixels), deltaX and ' +
    'deltaY.',
  inputSchema: {
    selector: selectorInput(),
    x: coordinateInput('x'),
    y: coordinateInput('y'),
    deltaX: z
      .number()
      .min(-MAX_DELTA)
      .max(MAX_DELTA)
      .default(0)
      .describe(
        'How far to scroll to the right, in CSS pixels, from -10000 to 10000; below 0 scrolls to ' +
          'the left. Default 0.',
      ),
    deltaY: z
      .number()
      .min(-MAX_DELTA)
      .max(MAX_DELTA)
      .describe(
        'How far to scroll down, in CSS pixels, from -10000 to 10000; below 0 scrolls up. A notch ' +
          'of a mouse wheel is about 100.',
      ),
    target: targetInput(),
  },
  // A click or a turn of the wheel can change anything one of the user can, and doing one twice is
  // not doing it once.
  annotations: DESTRUCTIVE,
  async handler({ selector, x, y, deltaX, deltaY, target }, ctx) {
    const aimed = pointerTargetOf({ selector, x, y }, false);
    const page = await uiTargetPage(ctx, target);
    const point = await scrollAt(page, aimed.target, { x: deltaX, y: deltaY });
    return { data: { target, by: aimed.by, point, deltaX, deltaY }, via: 'cdp' };
  },
});

export const uiFindElement = defineTool({
  name: 'ui_find_element',
  domain: 'ui',
  title: 'Find elements',
  description:
    'Lists the visible elements of TradingView that match a CSS selector, have a name (text), or ' +
    'both, to aim ui_click, ui_hover and ui_scroll with. Changes nothing. text matches an element ' +
    `whose name equals it, the rule ui_click uses: a name is ${NAME_RULE}. Each ` +
    'element has selector (one that picks it, by its id, data-qa-id, data-name or aria-label; null ' +
    'when none of those does), tag, role, name, text (at most 200 characters), rect (its box in ' +
    'CSS pixels from the top left of the visible part of the page, the x and y the other tools ' +
    'take), visible (always true: hidden elements are left out), unsafe (true for a trading ' +
    'control or anything inside one, which the other tools refuse) and holdsUnsafe (true for an ' +
    'element that holds one, which ui_click refuses, at a point on it too, while ui_hover and ' +
    'ui_scroll do not). ui_click also refuses an element named after a trading action (an ' +
    'aria-label, input button value, text shown or title of an element nothing else names that ' +
    `holds ${TRADING_NAMES}, as words). What ` +
    'is typed into a field (an input, a text area, a select) or an editable region is never read: ' +
    'such an element comes without text, and its text is no part of the name or the text of the ' +
    'elements around it. In document order, at ' +
    'most limit (1 to 50, default 10); a warning says when more match. target chart (default) or ' +
    'window, the window chrome. INVALID_INPUT without a selector or a text, and for an invalid ' +
    'selector.',
  inputSchema: {
    selector: z
      .string()
      .min(1)
      .max(MAX_SELECTOR)
      .optional()
      .describe(
        'A CSS selector the elements must match. With text, the elements that match it and have ' +
          'that name.',
      ),
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .optional()
      .describe(`The name the elements must have, equal to this. A name is ${NAME_RULE}.`),
    target: targetInput(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe('At most this many elements, from 1 to 50 (default 10).'),
  },
  annotations: READ_ONLY,
  async handler({ selector, text, target, limit }, ctx) {
    if (selector === undefined && text === undefined) {
      throw new TvMcpError('INVALID_INPUT', 'Give a selector, a text, or both', {
        hint: 'Look elements up by a CSS selector such as button or [role="menuitem"], by their name, or by both.',
      });
    }
    if (text?.trim() === '') {
      throw new TvMcpError('INVALID_INPUT', 'The text to look for is empty', {
        hint: `Give the name of the elements. The name of an element is ${NAME_RULE}.`,
      });
    }
    const page = await uiTargetPage(ctx, target);
    const { elements, more } = await page.bridge.evaluate(findElements, [
      { selector: selector ?? null, text: text ?? null },
      limit,
      [...UNSAFE_SELECTORS],
    ]);
    return {
      data: { elements },
      via: 'dom',
      warnings: more
        ? [
            `More elements match than the ${String(limit)} listed. Raise limit (up to 50), or ` +
              'narrow the selector or the text.',
          ]
        : [],
    };
  },
});

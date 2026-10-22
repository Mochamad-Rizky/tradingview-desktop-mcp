import type { PageErrorSentinel } from '../../core/tv/page-bridge.js';
import type { PageLib } from '../../core/tv/page-lib.js';
import { SELECTORS } from '../../core/tv/selectors.js';
import type { TvWindow } from '../../core/tv/tv-window.js';
import type { JsonValue } from '../../utils/json.js';

// The page functions of the panel, fullscreen and evaluate tools of the ui domain. The page bridge
// sends the source text of each one into the page, so each uses nothing of this module, only its
// parameters and the globals of the page. Whatever it needs to know about the interface is handed
// in as an argument.

// Where readPanelControls looks (notes of Plan 3, section 6.1): the buttons of the right toolbar
// that open the panels of the watchlist, the alerts and the object tree, and the tabs of the panel
// of the object tree, which shows the object tree or the data window.
export const PANEL_CONTROLS = {
  buttons: {
    watchlist: SELECTORS.buttons.watchlist,
    alerts: SELECTORS.buttons.alerts,
    object_tree: SELECTORS.buttons.objectTree,
  },
  tabs: {
    object_tree: SELECTORS.widgets.objectTreeTab,
    data_window: SELECTORS.widgets.dataWindowTab,
  },
};

// The state of the buttons of the right toolbar and of the tabs of the panel of the object tree,
// read without changing anything. Of a button: whether the page has it (found), whether it is
// shown (shown: it has a box and is neither display: none nor visibility: hidden, which fullscreen
// mode is not), and whether it says that its panel is shown (pressed, from aria-pressed: null when
// the button does not say). Of a tab: whether it is shown, which it is only while its panel is, and
// whether it is the one selected (aria-selected). It answers NOT_AVAILABLE on a page without a DOM.
export function readPanelControls(
  win: TvWindow,
  controls: {
    buttons: { watchlist: string; alerts: string; object_tree: string };
    tabs: { object_tree: string; data_window: string };
  },
):
  | {
      buttons: {
        watchlist: { found: boolean; shown: boolean; pressed: boolean | null };
        alerts: { found: boolean; shown: boolean; pressed: boolean | null };
        object_tree: { found: boolean; shown: boolean; pressed: boolean | null };
      };
      tabs: {
        object_tree: { shown: boolean; selected: boolean };
        data_window: { shown: boolean; selected: boolean };
      };
    }
  | PageErrorSentinel {
  const doc = win.document;
  if (typeof doc.querySelector !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The page has no DOM to read the right toolbar from',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }
  const find = (selector: string): Element | null => doc.querySelector?.(selector) ?? null;
  const isShown = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    if (!element.isConnected || box.width <= 0 || box.height <= 0) {
      return false;
    }
    const style = win.getComputedStyle?.(element);
    return style === undefined || (style.display !== 'none' && style.visibility !== 'hidden');
  };
  const button = (selector: string) => {
    const element = find(selector);
    const pressed = element?.getAttribute('aria-pressed') ?? null;
    return {
      found: element !== null,
      shown: element !== null && isShown(element),
      pressed: pressed === 'true' ? true : pressed === 'false' ? false : null,
    };
  };
  const tab = (selector: string) => {
    const element = find(selector);
    return {
      shown: element !== null && isShown(element),
      selected: element?.getAttribute('aria-selected') === 'true',
    };
  };
  return {
    buttons: {
      watchlist: button(controls.buttons.watchlist),
      alerts: button(controls.buttons.alerts),
      object_tree: button(controls.buttons.object_tree),
    },
    tabs: {
      object_tree: tab(controls.tabs.object_tree),
      data_window: tab(controls.tabs.data_window),
    },
  };
}

// Whether the Pine Editor is shown, as ui_open_panel counts it, and where TradingView registers it
// (placement: "dialog" for the side panel, "bottom", or null for none). Its button in the right
// toolbar says it with aria-pressed, which app_get_ui_state reads too, and its word goes first.
// Where the button does not say, an editor in the side panel is shown while TradingView registers
// it, as the panel leaves the registry when it closes, and an editor at the bottom while the bottom
// bar shows it: closing the bar hides that editor and keeps it registered. What cannot be read
// counts as not shown. Changes nothing.
export function readPineEditorShown(
  win: TvWindow,
  lib: PageLib,
  buttonSelector: string,
): { shown: boolean; placement: 'dialog' | 'bottom' | null } {
  const button =
    typeof win.document.querySelector === 'function'
      ? win.document.querySelector(buttonSelector)
      : null;
  const pressed = button?.getAttribute('aria-pressed') ?? null;
  let placement: 'dialog' | 'bottom' | null = null;
  const getOpenPineEditor = lib.findExport('getOpenPineEditor');
  if (typeof getOpenPineEditor === 'function') {
    for (const candidate of ['dialog', 'bottom'] as const) {
      let found: unknown;
      try {
        found = (getOpenPineEditor as (at: string) => unknown)(candidate);
      } catch {
        found = null;
      }
      if (found !== null && found !== undefined) {
        placement = candidate;
        break;
      }
    }
  }
  if (pressed === 'true' || pressed === 'false') {
    return { shown: pressed === 'true', placement };
  }
  if (placement === 'bottom') {
    let visible: unknown;
    try {
      visible = win.TradingView?.bottomWidgetBar?.isVisible?.().value();
    } catch {
      visible = false;
    }
    return { shown: visible === true, placement };
  }
  return { shown: placement === 'dialog', placement };
}

// Enters TradingView's own fullscreen mode of the charts (`enabled`), or leaves it, the way its
// fullscreen button does: TradingViewApi.startFullscreen() and exitFullscreen(). The mode lives
// inside the page, so the window does not change (notes of Plan 3, section 6.2). A mode the page
// reports as already the one asked for is left alone, and changed says whether a call was made; a
// mode the page cannot report is asked for all the same. CAPABILITY_UNAVAILABLE without the call,
// before anything is called, and NOT_AVAILABLE with the reason when the call throws.
export function setFullscreen(
  win: TvWindow,
  enabled: boolean,
): { changed: boolean } | PageErrorSentinel {
  const api = win.TradingViewApi;
  const name = enabled ? 'startFullscreen' : 'exitFullscreen';
  const callable = enabled
    ? typeof api?.startFullscreen === 'function'
    : typeof api?.exitFullscreen === 'function';
  if (api === undefined || !callable) {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `This page has no TradingViewApi.${name} to ${enabled ? 'enter' : 'leave'} the fullscreen mode of TradingView with`,
        hint: 'Check app_health: the app may still be loading, or the tab does not show a chart.',
      },
    };
  }
  let mode: unknown;
  try {
    mode = api._chartWidgetCollection?.fullscreen?.().value();
  } catch {
    mode = null;
  }
  if (mode === enabled) {
    return { changed: false };
  }
  try {
    if (enabled) {
      api.startFullscreen?.();
    } else {
      api.exitFullscreen?.();
    }
  } catch (error) {
    const message: unknown = (error as { message?: unknown } | null | undefined)?.message;
    const reason = typeof message === 'string' ? message : String(error);
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: `TradingView did not ${enabled ? 'enter' : 'leave'} its fullscreen mode: ${reason}`,
        hint: 'Try again in a moment, or use the fullscreen button of TradingView.',
        details: { reason },
      },
    };
  }
  return { changed: true };
}

// Whether TradingView's own fullscreen mode is on, as the collection of the charts reports it (a
// watched value of a boolean); null when the page cannot say. Changes nothing.
export function readFullscreen(win: TvWindow): { on: boolean | null } {
  try {
    const mode: unknown = win.TradingViewApi?._chartWidgetCollection?.fullscreen?.().value();
    return { on: typeof mode === 'boolean' ? mode : null };
  } catch {
    return { on: null };
  }
}

// Runs `expression` in the global scope of the page and answers its value as JSON, for
// ui_evaluate. The expression goes to the eval of the page through a reference, which makes it an
// indirect eval: it runs as the console of the browser runs code, statements included, and its
// value is that of the last statement. A promise it gives is awaited, as Runtime.evaluate awaits
// one, and an object that merely has a then is a value like any other. What it throws, or the
// promise rejects with, is PAGE_EVALUATION_FAILED with the name and the message of the error, or
// the value thrown, in at most 500 characters and never with a stack. A page without eval is
// CAPABILITY_UNAVAILABLE.
//
// The value is written out as JSON would write it, except that nothing is dropped and nothing
// throws:
// - undefined, NaN and the infinities are null, -0 is 0, a bigint is its digits and a symbol its
//   description, as text;
// - a function, a DOM node and anything else that cannot be written out (a promise, a weak map) is
//   its type, as Object.prototype.toString names it, such as [object Function] or
//   [object HTMLButtonElement], and a window is [object Window];
// - a date is its ISO time (null when it is invalid), a regular expression its source, an error
//   its name and message, a map the list of its pairs, a set and a typed array the list of their
//   values, and any other object its own enumerable keys;
// - an object that holds itself is [circular] where it comes back, a key whose getter throws is
//   [unreadable], and the objects that `withheld` names among the globals of the page, the user
//   object, the desktop bridge and the storage of the page, are [withheld] wherever they come up,
//   whatever name the expression found them by. They are read before the expression runs, only to
//   be told apart, so that it cannot hide them by replacing a global.
// The JSON of the value takes up at most `maxBytes` in UTF-8 (100000 when it is no positive number):
// a string is cut to what fits, without cutting a character in two, a list or an object stops at
// the last entry that fits, and what lies deeper than 32 levels is its type. truncated says whether
// anything was cut or left out.
export async function evaluateExpression(
  win: TvWindow,
  expression: string,
  maxBytes: number,
  withheld: string[],
): Promise<{ value: JsonValue; truncated: boolean } | PageErrorSentinel> {
  const run = win.eval;
  if (typeof run !== 'function') {
    return {
      __tvmcpError: {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This page has no eval to run an expression with',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }
  const globals = win as unknown as Record<string, unknown>;
  const held = new Set<unknown>();
  for (const name of withheld) {
    try {
      const global = globals[name];
      if ((typeof global === 'object' && global !== null) || typeof global === 'function') {
        held.add(global);
      }
    } catch {
      // A global that cannot be read holds nothing to hold back.
    }
  }
  const typeName = (value: unknown): string => {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return `[object ${typeof value}]`;
    }
  };
  // The name and the message of an error, or the value thrown as text, in at most 500 characters.
  const described = (thrown: unknown): string => {
    let text: string;
    try {
      const { name, message } = (thrown ?? {}) as { name?: unknown; message?: unknown };
      text =
        typeof thrown === 'object' && thrown !== null && typeof message === 'string'
          ? `${typeof name === 'string' && name !== '' ? name : 'Error'}: ${message}`
          : String(thrown);
    } catch {
      text = 'a value that cannot be shown';
    }
    if (text.length <= 500) {
      return text;
    }
    const last = text.charCodeAt(499);
    return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? 499 : 500)}…`;
  };

  let result: unknown;
  try {
    result = run(expression);
    if (typeName(result) === '[object Promise]') {
      result = await result;
    }
  } catch (thrown) {
    return {
      __tvmcpError: {
        code: 'PAGE_EVALUATION_FAILED',
        message: `The expression threw ${described(thrown)}`,
        hint: 'The expression itself failed in the chart tab: check it, one part at a time if need be.',
      },
    };
  }

  let left =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 100000;
  let truncated = false;
  // How many UTF-16 units of `text` fit in `room` bytes of JSON, and the bytes they take: a quote
  // and a backslash take two, a control character the two or the six of its escape, a lone half of
  // a pair the six of its escape, and any other character its bytes in UTF-8. A pair is never cut.
  const fit = (text: string, room: number): { units: number; bytes: number } => {
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      let units = 1;
      let size = 3;
      if (code === 0x22 || code === 0x5c) {
        size = 2;
      } else if (code < 0x20) {
        size = [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      } else if (code < 0x80) {
        size = 1;
      } else if (code < 0x800) {
        size = 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          size = 4;
          units = 2;
        } else {
          size = 6;
        }
      }
      if (bytes + size > room) {
        break;
      }
      bytes += size;
      index += units;
    }
    return { units: index, bytes };
  };
  // Nothing more fits: whatever comes after is left out.
  const full = (): void => {
    truncated = true;
    left = 0;
  };
  // A token of JSON that takes `size` bytes, if it fits.
  const token = <T extends JsonValue>(json: T, size: number): T | undefined => {
    if (size > left) {
      full();
      return undefined;
    }
    left -= size;
    return json;
  };
  // A string, cut to what fits.
  const text = (value: string): string | undefined => {
    if (left < 2) {
      full();
      return undefined;
    }
    const { units, bytes } = fit(value, left - 2);
    left -= bytes + 2;
    if (units < value.length) {
      full();
    }
    return value.slice(0, units);
  };
  const isWindow = (object: object): boolean => {
    try {
      return object === (win as object) || (object as { window?: unknown }).window === object;
    } catch {
      return false;
    }
  };
  const isNode = (object: object): boolean => {
    try {
      const { nodeType, nodeName } = object as { nodeType?: unknown; nodeName?: unknown };
      return typeof nodeType === 'number' && typeof nodeName === 'string';
    } catch {
      return false;
    }
  };
  // What is never walked: there is nothing in it to write out.
  const opaque = [
    '[object Promise]',
    '[object WeakMap]',
    '[object WeakSet]',
    '[object WeakRef]',
    '[object ArrayBuffer]',
    '[object SharedArrayBuffer]',
    '[object DataView]',
    '[object Generator]',
    '[object AsyncGenerator]',
  ];
  // The objects the value is being written out inside of, to tell a cycle from a shared object.
  const inside = new Set<object>();

  const render = (value: unknown, depth: number): JsonValue | undefined => {
    switch (typeof value) {
      case 'undefined':
        return token(null, 4);
      case 'boolean':
        return token(value, value ? 4 : 5);
      case 'number': {
        if (!Number.isFinite(value)) {
          return token(null, 4);
        }
        const number = value === 0 ? 0 : value;
        return token(number, String(number).length);
      }
      case 'bigint':
      case 'symbol':
        return text(String(value));
      case 'string':
        return text(value);
      case 'function':
        return text(typeName(value));
      default:
        break;
    }
    if (value === null) {
      return token(null, 4);
    }
    const object = value as object;
    if (held.has(object)) {
      return text('[withheld]');
    }
    if (isWindow(object)) {
      return text('[object Window]');
    }
    if (isNode(object)) {
      return text(typeName(object));
    }
    if (inside.has(object)) {
      return text('[circular]');
    }
    // Whatever the object does while it is written out, such as a type it forges, a getter that
    // throws or a proxy that was revoked, makes that object unreadable and nothing more: the
    // renderer itself never throws.
    try {
      return walk(object, depth);
    } catch {
      return text('[unreadable]');
    }
  };

  // Writes out an object that is not withheld, not a window, not a node and not one the value is
  // already inside of: by its type, or else its entries or its own enumerable keys.
  const walk = (object: object, depth: number): JsonValue | undefined => {
    const tag = typeName(object);
    if (tag === '[object Date]') {
      const time = Date.prototype.getTime.call(object as Date);
      return Number.isNaN(time) ? token(null, 4) : text(new Date(time).toISOString());
    }
    if (tag === '[object RegExp]') {
      return text(RegExp.prototype.toString.call(object));
    }
    if (tag === '[object Error]') {
      return text(described(object));
    }
    if (opaque.includes(tag)) {
      return text(tag);
    }
    if (depth >= 32) {
      truncated = true;
      return text(tag);
    }

    let entries: Iterable<unknown> | null = null;
    if (Array.isArray(object)) {
      entries = object as unknown[];
    } else if (tag === '[object Map]') {
      entries = (object as Map<unknown, unknown>).entries();
    } else if (tag === '[object Set]') {
      entries = (object as Set<unknown>).values();
    } else if (ArrayBuffer.isView(object)) {
      entries = Array.from(object as unknown as ArrayLike<unknown>);
    }
    if (left < 2) {
      full();
      return undefined;
    }
    inside.add(object);
    try {
      if (entries !== null) {
        left -= 2;
        const list: JsonValue[] = [];
        for (const entry of entries) {
          if (list.length > 0) {
            if (left < 1) {
              full();
              break;
            }
            left -= 1;
          }
          const item = render(entry, depth + 1);
          if (item === undefined) {
            break;
          }
          list.push(item);
        }
        return list;
      }
      const keys = Object.keys(object);
      left -= 2;
      const written: Record<string, JsonValue> = {};
      let count = 0;
      for (const key of keys) {
        const keySize = fit(key, Infinity).bytes + 3 + (count > 0 ? 1 : 0);
        if (keySize > left) {
          full();
          break;
        }
        left -= keySize;
        let read: unknown;
        let readable = true;
        try {
          read = (object as Record<string, unknown>)[key];
        } catch {
          readable = false;
        }
        const item = readable ? render(read, depth + 1) : text('[unreadable]');
        if (item === undefined) {
          break;
        }
        // A key named __proto__ stays a key.
        Object.defineProperty(written, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        count += 1;
      }
      return written;
    } finally {
      inside.delete(object);
    }
  };

  return { value: render(result, 0) ?? null, truncated };
}

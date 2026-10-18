import type { CdpSession } from '../cdp/types.js';
import { TvMcpError } from '../errors.js';
import type { PageBridge, PageErrorSentinel } from './page-bridge.js';
import { UNSAFE_SELECTORS } from './selectors.js';
import type { TvWindow } from './tv-window.js';

// Real input for the places the chart API does not reach: a click, text and key presses sent to
// the page over CDP, so the page sees them as it sees a user.
//
// Only a click is guarded. It is refused when its target, or whatever would take the click,
// belongs to a broker trading control (UNSAFE_SELECTORS). Text and keys go to whatever has the
// focus and are not checked, so a caller that has focused a trading control can still press Enter
// on it. The tools built on these helpers have to account for that.

// A page the helpers can act on: the debugging session of a chart tab, to send input events to,
// and the bridge that runs page functions in it. Only these two members are used, so any handle
// to a page that has them will do.
export interface InputPage {
  readonly session: CdpSession;
  readonly bridge: PageBridge;
}

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

// What a click needs to know about the first element that matches `selector`:
// - found: whether there is one.
// - visible: whether it is connected, has a box with a size, and is not display: none or
//   visibility: hidden. A page without getComputedStyle is judged by its box alone.
// - unsafe: whether a click on it could reach a trading control. That is so when it matches one of
//   `unsafeSelectors`, holds an element that does, sits inside one that does, or, when it is
//   visible, has such an element at the point a click on it would land on, for instance an order
//   ticket floating over it.
// - rect: its box in viewport pixels, as the page reports it.
// It answers NOT_AVAILABLE on a page without a DOM, and INVALID_INPUT for a selector that is not
// valid CSS.
//
// The caller passes the selectors to refuse, because a page function cannot import them. An empty
// list is refused: it would let every element pass as safe.
export function describeElement(
  win: TvWindow,
  selector: string,
  unsafeSelectors: string[],
):
  | {
      found: boolean;
      visible: boolean;
      unsafe: boolean;
      rect?: { x: number; y: number; width: number; height: number };
    }
  | PageErrorSentinel {
  const doc = win.document;
  if (typeof doc.querySelector !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The page has no DOM to look elements up in',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }
  if (unsafeSelectors.length === 0) {
    throw new Error('describeElement needs the selectors to treat as unsafe');
  }
  let element: Element | null;
  try {
    element = doc.querySelector(selector);
  } catch {
    // querySelector throws only for a selector it cannot parse.
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The selector is not valid CSS: ${selector}`,
        hint: 'Use a CSS selector such as #id or [data-name="..."].',
        details: { selector },
      },
    };
  }
  if (element === null) {
    return { found: false, visible: false, unsafe: false };
  }

  const box = element.getBoundingClientRect();
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  let visible = element.isConnected && rect.width > 0 && rect.height > 0;
  if (visible && typeof win.getComputedStyle === 'function') {
    const style = win.getComputedStyle(element);
    visible = style.display !== 'none' && style.visibility !== 'hidden';
  }

  const unsafeList = unsafeSelectors.join(', ');
  // closest starts at the element itself, so it also covers an element that matches.
  let unsafe = element.closest(unsafeList) !== null || element.querySelector(unsafeList) !== null;
  if (!unsafe && visible && typeof doc.elementFromPoint === 'function') {
    // The same point clickElement uses. Only what the click would hit is judged, not what that
    // holds: a large container that happens to hold a trading control somewhere is no reason.
    const hit = doc.elementFromPoint(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2),
    );
    unsafe = hit !== null && hit.closest(unsafeList) !== null;
  }
  return { found: true, visible, unsafe, rect };
}

// Clicks the center of the first element that matches `selector`. The element is looked up anew on
// every call and nothing is cached, because the page moves between calls. The lookup comes first
// and nothing is sent to the page before it says the target is safe, so a refused click does not
// even move the mouse.
//
// A click is a lookup and then three events, so the page can change in between. That race is
// inherent in clicking by coordinates, and the lookup narrows it as far as it can.
export async function clickElement(page: InputPage, selector: string): Promise<void> {
  const element = await page.bridge.evaluate(describeElement, [selector, [...UNSAFE_SELECTORS]]);
  if (element.unsafe) {
    throw new TvMcpError(
      'UNSAFE_ACTION_BLOCKED',
      `Refusing to click \`${selector}\`: it is part of a broker trading control, holds one, or lies over one`,
      {
        hint: 'Trading controls are off limits to this server. Place orders in the TradingView window yourself.',
        details: { selector },
      },
    );
  }
  const { rect } = element;
  if (!element.found || !element.visible || rect === undefined) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      element.found
        ? `The element \`${selector}\` is not visible`
        : `No element matches \`${selector}\``,
      {
        hint: 'Open the panel or dialog that holds the element first, or check the selector.',
        details: { selector, found: element.found, visible: element.visible },
      },
    );
  }

  // Whole pixels, and the point describeElement judged. The mouse arrives first so that the page
  // sees the pointer over the element before the button goes down, which menus rely on.
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  const { session } = page;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

// Inserts text where the focus is, as an emoji picker or an input method would: no key events, so
// a shortcut of the page does not see the letters. Nothing is sent for empty text.
export async function typeText(page: InputPage, text: string): Promise<void> {
  if (text === '') {
    return;
  }
  await page.session.send('Input.insertText', { text });
}

// The bits of the modifiers field of an input event.
const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;
// A key held with one of these is a shortcut, not typing: Chrome produces no character for it.
const SHORTCUT_MODIFIERS = ALT | CONTROL | META;

// A Map, not an object lookup: a name every object inherits, such as "constructor", must not pass.
const MODIFIER_BITS: ReadonlyMap<string, number> = new Map<KeyModifier, number>([
  ['Alt', ALT],
  ['Control', CONTROL],
  ['Meta', META],
  ['Shift', SHIFT],
]);

// The keys that have a name, by their KeyboardEvent.key, which is also their code. Windows virtual
// key codes are what Chrome reads to tell which key it is. Only Enter carries a character, a
// carriage return. Chrome fires the keypress of Enter, and so submits a form, only when the key
// event has that text.
const NAMED_KEYS: ReadonlyMap<string, { keyCode: number; text?: string }> = new Map([
  ['Enter', { keyCode: 13, text: '\r' }],
  ['Escape', { keyCode: 27 }],
  ['Tab', { keyCode: 9 }],
  ['Backspace', { keyCode: 8 }],
  ['Delete', { keyCode: 46 }],
  ['ArrowUp', { keyCode: 38 }],
  ['ArrowDown', { keyCode: 40 }],
  ['ArrowLeft', { keyCode: 37 }],
  ['ArrowRight', { keyCode: 39 }],
  ['Home', { keyCode: 36 }],
  ['End', { keyCode: 35 }],
  ['PageUp', { keyCode: 33 }],
  ['PageDown', { keyCode: 34 }],
]);

const SUPPORTED_KEYS = `${[...NAMED_KEYS.keys()].join(', ')}, a single letter (a-z, A-Z) or a digit (0-9)`;

interface KeyDescription {
  key: string;
  code: string;
  keyCode: number;
  // The character the key types, if it types one.
  text: string | undefined;
}

// Letters and digits follow the US layout, the one the physical key codes are named after. Shift
// only changes the case of a letter. A shifted digit would be a symbol that depends on the
// layout, so a digit stays a digit.
function describeKey(key: string, shifted: boolean): KeyDescription | undefined {
  const named = NAMED_KEYS.get(key);
  if (named !== undefined) {
    return { key, code: key, keyCode: named.keyCode, text: named.text };
  }
  if (/^[A-Za-z]$/.test(key)) {
    const upper = key.toUpperCase();
    const shown = shifted ? upper : key;
    return { key: shown, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: shown };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  }
  return undefined;
}

// Presses and releases a key. The modifiers are set on both events as a bit field and are not
// pressed as keys of their own, so a page sees event.shiftKey and the like, but not a keydown of
// the Shift key itself.
//
// A key that types something is sent as keyDown with its text, which also gives the page the
// keypress and the default action, such as submitting a form on Enter. A key that types nothing is
// sent as rawKeyDown, which is what Chrome expects for it. A key held with Alt, Control or Meta
// types nothing, so Control and A reaches the shortcuts of the page without typing an "a". The
// editing shortcuts of the browser itself, such as select all, do not run for events sent this
// way.
export async function pressKey(
  page: InputPage,
  key: string,
  modifiers: readonly KeyModifier[] = [],
): Promise<void> {
  let mask = 0;
  for (const modifier of modifiers) {
    const bit = MODIFIER_BITS.get(modifier);
    if (bit === undefined) {
      throw new TvMcpError('INVALID_INPUT', `Unsupported modifier \`${modifier}\``, {
        hint: 'Use Alt, Control, Meta or Shift.',
        details: { modifier },
      });
    }
    mask |= bit;
  }
  const description = describeKey(key, (mask & SHIFT) !== 0);
  if (description === undefined) {
    throw new TvMcpError('INVALID_INPUT', `Unsupported key \`${key}\``, {
      hint: `Use one of: ${SUPPORTED_KEYS}.`,
      details: { key },
    });
  }

  const event = {
    modifiers: mask,
    key: description.key,
    code: description.code,
    windowsVirtualKeyCode: description.keyCode,
  };
  const text = (mask & SHORTCUT_MODIFIERS) === 0 ? description.text : undefined;
  await page.session.send(
    'Input.dispatchKeyEvent',
    text === undefined ? { type: 'rawKeyDown', ...event } : { type: 'keyDown', ...event, text },
  );
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

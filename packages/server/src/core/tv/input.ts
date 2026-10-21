import type { CdpSession } from '../cdp/types.js';
import { TvMcpError } from '../errors.js';
import type { PageBridge, PageErrorSentinel } from './page-bridge.js';
import { SELECTORS, UNSAFE_SELECTORS } from './selectors.js';
import type { TvWindow } from './tv-window.js';
import { readViewport } from './viewport.js';

// Real input for the places the chart API does not reach: a click, text and key presses sent to
// the page over CDP, so the page sees them as it sees a user.
//
// A click is refused when its target, or whatever would take the click, belongs to a broker
// trading control (UNSAFE_SELECTORS). Key presses land on the element that has the focus, and
// Enter on a focused button clicks it, so they are refused while that element is a trading
// control or sits inside one. Text is typed only into a focused text field that is no trading
// control, because the caret can be somewhere else than the focus (see typeText). A page that
// cannot say what has the focus is refused too.
//
// The calls of one page run one at a time, because each rests on a lookup that another call
// would otherwise change.
//
// A page judges a click in its CSS pixels, and a mouse event goes out in the device-independent
// pixels of the window, which are the CSS pixels times the page zoom of the app. So the zoom is
// read with every look at a target, and a page that does not report it is refused.
//
// That leaves one gap. TradingView may bind trading actions to hotkeys that work wherever the
// focus is. The notes record none, so a key chord can still reach one, and the check of the
// focused element cannot see it.

// A page the helpers can act on: the debugging session of a chart tab, to send input events to,
// and the bridge that runs page functions in it. Only these two members are used, so any handle
// to a page that has them will do.
export interface InputPage {
  readonly session: CdpSession;
  readonly bridge: PageBridge;
}

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

// Every call is a lookup of the page followed by events that rest on it, and two calls that
// overlap can send an event on a lookup the other call has made stale: Tab moves the focus to a
// trade button between the lookup that cleared an Enter and the Enter, and nothing ever looked at
// the button. So the calls of one page queue. A call holds its turn from its first lookup to the
// answer to its last event, and gives it up when it ends, however it ends. The queue belongs to
// the session, so it goes away with the page.
//
// A turn is not re-entrant: an action that called clickElement, pressKey or typeText of the same
// page would queue behind itself and never end. So no helper calls another one while it holds a
// turn, and a caller that needs several runs them one after the other.
const queues = new WeakMap<CdpSession, Promise<void>>();

function exclusively<T>(page: InputPage, action: () => Promise<T>): Promise<T> {
  const turn = (queues.get(page.session) ?? Promise.resolve()).then(action);
  // The next call waits for this one to end, and does not care how it ended.
  queues.set(
    page.session,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
}

// What a click needs to know about the first element that matches `selector`:
// - found: whether there is one.
// - visible: whether it is connected, has a box with a size, and is not display: none or
//   visibility: hidden. A page without getComputedStyle is judged by its box alone.
// - unsafe: whether a click on it could reach a trading control. That is so when it matches one of
//   `unsafeSelectors`, holds an element that does, sits inside one that does, or, when it is
//   visible, has such an element at the point a click on it would land on, for instance an order
//   ticket floating over it.
// - coverage: what lies at that point, which is judged for an element that is visible and not
//   unsafe:
//   - clear: the element, something inside it, or a layer stacked over it that is nothing special.
//     The chart draws several canvases on top of each other, and a click on the one beneath
//     reaches the page through the one on top, so a layer alone is no reason to refuse.
//   - obscured: something else lies over the point, and it is a layer of `overlaySelectors` (a
//     dialog, a menu or a popup, but not the portal itself) or a frame (iframe, frame, object or
//     embed). The click would go to that, and what it is cannot be told: an order ticket has no
//     selector, and a frame cannot be looked into. obscuredBy says what it is.
//   - center-outside-viewport: no element is hit there, because the point is not on the page.
//   - hit-test-unavailable: the page cannot say what is there.
//   - not-checked: there is no element, or it is not visible, or it is unsafe.
// - obscuredBy: the covering element in a few words, its tag followed by its id, data-qa-id and
//   data-name when it has them. Empty unless the coverage is obscured.
// - rect: its box in viewport pixels, as the page reports it.
// It answers NOT_AVAILABLE on a page without a DOM, and INVALID_INPUT for a selector that is not
// valid CSS.
//
// The caller passes the selectors to refuse and the layers that cover a page, because a page
// function cannot import them. An empty list of either is refused: with none, every element would
// pass.
export function describeElement(
  win: TvWindow,
  selector: string,
  unsafeSelectors: string[],
  overlaySelectors: string[],
):
  | {
      found: boolean;
      visible: boolean;
      unsafe: boolean;
      coverage:
        'not-checked' | 'clear' | 'obscured' | 'center-outside-viewport' | 'hit-test-unavailable';
      obscuredBy: string;
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
  if (overlaySelectors.length === 0) {
    throw new Error('describeElement needs the selectors of the layers that cover a page');
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
    return { found: false, visible: false, unsafe: false, coverage: 'not-checked', obscuredBy: '' };
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
  let coverage:
    'not-checked' | 'clear' | 'obscured' | 'center-outside-viewport' | 'hit-test-unavailable' =
    'not-checked';
  let obscuredBy = '';
  if (!unsafe && visible) {
    if (typeof doc.elementFromPoint !== 'function') {
      coverage = 'hit-test-unavailable';
    } else {
      // The same point clickElement uses.
      const hit = doc.elementFromPoint(
        Math.round(rect.x + rect.width / 2),
        Math.round(rect.y + rect.height / 2),
      );
      if (hit === null) {
        coverage = 'center-outside-viewport';
      } else if (hit.closest(unsafeList) !== null) {
        // Only what the click would hit is judged, not what that holds: a large container that
        // happens to hold a trading control somewhere is no reason.
        unsafe = true;
      } else {
        coverage = 'clear';
        // The portal that holds the dialogs is not a layer of itself, so hitting it is not being
        // covered, and neither is hitting the element or something inside it.
        const layer = hit.closest(overlaySelectors.join(', '));
        const inLayer = layer !== null && layer !== hit;
        const inFrame = ['iframe', 'frame', 'object', 'embed'].includes(hit.localName);
        if (!element.contains(hit) && (inLayer || inFrame)) {
          coverage = 'obscured';
          obscuredBy = hit.localName;
          if (hit.id !== '') {
            obscuredBy += `#${hit.id}`;
          }
          const qaId = hit.getAttribute('data-qa-id');
          if (qaId !== null) {
            obscuredBy += `[data-qa-id="${qaId}"]`;
          }
          const name = hit.getAttribute('data-name');
          if (name !== null) {
            obscuredBy += `[data-name="${name}"]`;
          }
          obscuredBy = obscuredBy.slice(0, 120);
        }
      }
    }
  }
  return { found: true, visible, unsafe, coverage, obscuredBy, rect };
}

// What a key press or a text needs to know about the element that has the focus. A key lands on
// it, and text lands at the caret, which is known to be in the focused element only when that is
// a text field:
// - unsafe: whether the focused element matches one of `unsafeSelectors` or sits inside one that
//   does. Unlike for a click, what it holds does not count. Key events go to the focused element
//   and not to its descendants, and the pane of the chart, where the focus usually is, always
//   holds the buy and sell buttons shown on it, so counting them would refuse every key aimed at
//   the chart. A container that activates a button in it by itself, as a toolbar can through
//   aria-activedescendant, is therefore not caught. The body and the html element are safe, and
//   so is a page where no element has the focus.
// - editable: whether the focused element is a text field: an input of a type that takes text
//   (text, search, email, url, tel, password or number, which includes a missing or an unknown
//   type, as a page reports those as text), a textarea, or a content-editable element.
// - opaque: whether the focus is somewhere the page cannot look into. In a frame (iframe, frame,
//   object or embed), or in the shadow tree of an element whose shadow root holds the focus,
//   activeElement names the frame or the host, and what really has the focus is out of sight, so a
//   trading control in there would not be seen. A closed shadow root cannot be told from none.
// - focused: the element in a few words for the error that refuses it, its tag followed by its id,
//   data-qa-id and data-name when it has them. Empty when no element has the focus.
// A page that cannot say what has the focus answers NOT_AVAILABLE, so that nothing is sent to a
// page that cannot be checked. An empty list of selectors is refused, as in describeElement.
export function describeFocusedElement(
  win: TvWindow,
  unsafeSelectors: string[],
): { unsafe: boolean; editable: boolean; opaque: boolean; focused: string } | PageErrorSentinel {
  // A page always has a document, but a fake of one or a frame that is still loading may not.
  const doc = win.document as TvWindow['document'] | undefined;
  const active = doc?.activeElement;
  if (active === undefined) {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The page cannot say which element has the focus',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }
  if (unsafeSelectors.length === 0) {
    throw new Error('describeFocusedElement needs the selectors to treat as unsafe');
  }
  if (active === null) {
    return { unsafe: false, editable: false, opaque: false, focused: '' };
  }

  let focused = active.localName;
  if (active.id !== '') {
    focused += `#${active.id}`;
  }
  const qaId = active.getAttribute('data-qa-id');
  if (qaId !== null) {
    focused += `[data-qa-id="${qaId}"]`;
  }
  const name = active.getAttribute('data-name');
  if (name !== null) {
    focused += `[data-name="${name}"]`;
  }
  focused = focused.slice(0, 120);

  // Only an input has a type that says whether it takes text, but other elements report one too (a
  // link reports its type attribute), so the tag is checked first.
  const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const editable =
    (active.localName === 'input' &&
      'type' in active &&
      typeof active.type === 'string' &&
      textTypes.includes(active.type)) ||
    active.localName === 'textarea' ||
    ('isContentEditable' in active && active.isContentEditable === true);

  const opaque =
    ['iframe', 'frame', 'object', 'embed'].includes(active.localName) ||
    (active.shadowRoot?.activeElement ?? null) !== null;

  const unsafeList = unsafeSelectors.join(', ');
  // closest starts at the element itself, so it also covers an element that matches. The body and
  // the html element match nothing and sit inside nothing, so they come out safe.
  return { unsafe: active.closest(unsafeList) !== null, editable, opaque, focused };
}

// What describeElement says about an element, without the way it can fail.
type ElementDescription = Exclude<ReturnType<typeof describeElement>, PageErrorSentinel>;

function lookUp(page: InputPage, selector: string): Promise<ElementDescription> {
  return page.bridge.evaluate(describeElement, [
    selector,
    [...UNSAFE_SELECTORS],
    [SELECTORS.regions.overlapManagerRoot],
  ]);
}

// The box of an element a click may go to, or the reason it may not. The unsafe verdict comes
// first, so a trading control is reported as one even when it is also hidden or covered.
function clickableRect(
  selector: string,
  element: ElementDescription,
): NonNullable<ElementDescription['rect']> {
  if (element.unsafe) {
    throw new TvMcpError(
      'UNSAFE_ACTION_BLOCKED',
      `Refusing to click \`${selector}\`: it is part of a broker trading control, holds one, or has one over it`,
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
  if (element.coverage === 'obscured') {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      `The element \`${selector}\` is covered by \`${element.obscuredBy}\``,
      {
        hint: 'Close the dialog or menu that covers it first.',
        details: { selector, obscuredBy: element.obscuredBy },
      },
    );
  }
  if (element.coverage !== 'clear') {
    // The point of the click is off the page or the page cannot say what is there. Anything else
    // that is not clear is refused the same way, so that an answer nobody expected cannot pass.
    const offPage = element.coverage === 'center-outside-viewport';
    throw new TvMcpError(
      'NOT_AVAILABLE',
      offPage
        ? `The center of \`${selector}\` is outside the visible part of the page`
        : `The page cannot say what lies over \`${selector}\``,
      {
        hint: offPage
          ? 'Bring the element into view first.'
          : 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
        details: { selector, reason: offPage ? 'center-outside-viewport' : 'hit-test-unavailable' },
      },
    );
  }
  return rect;
}

// Whole pixels, which is also the point describeElement judged.
function centerOf(rect: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

// A point of the page, in the CSS pixels the page judges it in, in the device-independent pixels
// (DIPs) of the window that a mouse event is sent in: the page zoom of the app (0.2 to 5, 1 at
// 100%) is how many DIPs a CSS pixel takes. At any other zoom than 1, a point sent as the page
// reports it would land somewhere the page has not looked at.
function inDips(point: { x: number; y: number }, zoom: number): { x: number; y: number } {
  return { x: point.x * zoom, y: point.y * zoom };
}

// One look at the target of a click: what the page says about it, which refuses the click or gives
// the point it judged, and the zoom of the page, which turns that point into DIPs. The zoom is read
// anew with every look, after the page has cleared the target, because a change of zoom moves
// everything on the page as much as a change of its layout does. A page that does not report its
// viewport, and so its zoom, is refused (readViewport).
async function lookFor(page: InputPage, selector: string): Promise<{ x: number; y: number }> {
  const point = centerOf(clickableRect(selector, await lookUp(page, selector)));
  const { zoom } = await readViewport(page.session);
  return inDips(point, zoom);
}

// Clicks the center of the first element that matches `selector`. The element is looked up anew on
// every call and nothing is cached, because the page moves between calls. The lookup comes first
// and nothing is sent to the page before it says the target is safe, so a refused click does not
// even move the mouse.
//
// The mouse arrives before the button goes down, so that the page sees the pointer over the
// element, which menus rely on. Arriving can change the page: a hover opens a flyout, often right
// under the pointer, and that can cover the target or put a trading control where the click would
// land. So the target is looked up a second time once the pointer is there, and the button goes
// down only if that lookup is as clean as the first. When it is not, only the move has been sent.
// The button then goes down where the second lookup found the target, which is the point it
// judged. What changes after the second lookup is the race that remains, and it is inherent in
// clicking by coordinates.
//
// The page judges in CSS pixels and the events are sent in DIPs, each at the zoom its own look read
// (lookFor).
export async function clickElement(page: InputPage, selector: string): Promise<void> {
  await exclusively(page, async () => {
    const { session } = page;
    const arrival = await lookFor(page, selector);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...arrival });

    const { x, y } = await lookFor(page, selector);
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
  });
}

// A key lands on whatever has the focus, and Enter on a focused button clicks it. Text lands at
// the caret, which is known to be in the focused element only when that is a text field. So the
// focus is looked at first, and a trading control that has it refuses the input before anything
// is sent. A page that cannot say what has the focus is refused as well, and so is a focus in a
// frame or a shadow root: this fails closed. What the page said about the element is handed back,
// for the caller that needs more than the verdict.
async function assertFocusIsSafe(
  page: InputPage,
  action: 'pressKey' | 'typeText',
): Promise<{ focused: string; editable: boolean }> {
  const { unsafe, editable, opaque, focused } = await page.bridge.evaluate(describeFocusedElement, [
    [...UNSAFE_SELECTORS],
  ]);
  if (unsafe) {
    throw new TvMcpError(
      'UNSAFE_ACTION_BLOCKED',
      `Refusing to ${action === 'pressKey' ? 'press a key' : 'type text'}: the focus is on \`${focused}\`, which is part of a broker trading control`,
      {
        hint: 'Trading controls are off limits to this server. Move the focus to another element first, or use the TradingView window yourself.',
        details: { action, focused },
      },
    );
  }
  if (opaque) {
    throw new TvMcpError(
      'NOT_AVAILABLE',
      `Cannot ${action === 'pressKey' ? 'press a key' : 'type text'}: the focus is inside \`${focused}\`, which this server cannot look into`,
      {
        hint: 'Move the focus to an element of the page itself first.',
        details: { action, focused },
      },
    );
  }
  return { focused, editable };
}

// Inserts text at the caret, as an emoji picker or an input method would: no key events, so a
// shortcut of the page does not see the letters.
//
// The caret is not where the focus is. A field keeps the caret when the focus moves on to a button
// or a container, and Chrome then still types into that field and gives it the focus back (seen
// in Chrome 155, also after a real click on a button). So the focused element says nothing about
// where the text would go, unless it is a text field itself: the caret is then in it. That is the
// only place text is sent to, and only when it is no trading control. A focused button, a
// container, the body or no element at all is NOT_AVAILABLE. Empty text is a no-op that does not
// even look at the page.
export async function typeText(page: InputPage, text: string): Promise<void> {
  if (text === '') {
    return;
  }
  await exclusively(page, async () => {
    const { focused, editable } = await assertFocusIsSafe(page, 'typeText');
    if (!editable) {
      throw new TvMcpError(
        'NOT_AVAILABLE',
        focused === ''
          ? 'Cannot type text: no element has the focus'
          : `Cannot type text: the focus is on \`${focused}\`, which is not a text field`,
        {
          hint: 'Focus a text field first, for example click the symbol search box.',
          details: { action: 'typeText', focused },
        },
      );
    }
    await page.session.send('Input.insertText', { text });
  });
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
//
// The key and the modifiers are checked first, so a request that cannot be sent never costs a
// lookup, or a wait for the call in progress. Then the focus is looked at, and the key is refused
// while a trading control has it.
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
  await exclusively(page, async () => {
    await assertFocusIsSafe(page, 'pressKey');
    await page.session.send(
      'Input.dispatchKeyEvent',
      text === undefined ? { type: 'rawKeyDown', ...event } : { type: 'keyDown', ...event, text },
    );
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  });
}

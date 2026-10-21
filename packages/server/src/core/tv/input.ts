import type { JsonObject } from '../../utils/json.js';
import type { CdpSession } from '../cdp/types.js';
import { isTvMcpError, TvMcpError } from '../errors.js';
import type { PageBridge, PageErrorSentinel } from './page-bridge.js';
import { SELECTORS, TRADING_ACTION_NAMES, UNSAFE_SELECTORS } from './selectors.js';
import type { BoxElementLike, TvWindow } from './tv-window.js';
import { readViewport } from './viewport.js';

// Real input for the places the chart API does not reach: a click, a hover, a turn of the mouse
// wheel, text and key presses sent to the page over CDP, so the page sees them as it sees a user.
//
// The pointer goes to an element, the first one that matches a selector or the first visible one
// with a name, or to a point of the page. It is refused when the target, or whatever would take the
// event, belongs to a broker trading control (UNSAFE_SELECTORS), and when a dialog, a menu, a popup
// or a frame lies where it would land, because what that is cannot be told. A click is refused as
// well on what holds a trading control, and on what is named after a trading action
// (TRADING_ACTION_NAMES), since an order ticket has no stable selector yet. Key presses land on the
// element that has the focus, and Enter on a focused button clicks it, so they are refused while
// that element is a trading control or sits inside one. Text is typed only into a focused text
// field that is no trading control, because the caret can be somewhere else than the focus (see
// typeText). A page that cannot say what has the focus, or what lies at a point, is refused too.
//
// The calls of one page run one at a time, because each rests on a lookup that another call
// would otherwise change.
//
// A page judges a point in its CSS pixels, and a mouse event goes out in the device-independent
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

// A point of a page in CSS pixels, from the top left of its viewport, the way getBoundingClientRect
// reports the box of an element. A type alias, not an interface: a target of the pointer goes to the
// page as JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type Point = { x: number; y: number };

// Where the pointer goes: the first element that matches a CSS selector, the first visible element
// with a name (describeElement says what the name of an element is), or a point.
export type PointerTarget = { selector: string } | { text: string } | Point;

// What the pointer does at its target: a click presses the left button there, a hover only moves
// the pointer there, and a scroll turns the wheel there.
export type PointerAction = 'click' | 'hover' | 'scroll';

// What the name of an element is, in the words of the hints and of the descriptions of the tools
// that look an element up by its name. describeElement says it in full.
export const NAME_RULE =
  'its aria-label, or else the value of an input button, or else the text it shows, with a space ' +
  'between the texts of different elements and white space collapsed (a label made of Sell and 100 ' +
  'in two spans is "Sell 100"), compared whole and ignoring case';

// Every call is a lookup of the page followed by events that rest on it, and two calls that
// overlap can send an event on a lookup the other call has made stale: Tab moves the focus to a
// trade button between the lookup that cleared an Enter and the Enter, and nothing ever looked at
// the button. So the calls of one page queue. A call holds its turn from its first lookup to the
// answer to its last event, and gives it up when it ends, however it ends. The queue belongs to
// the session, so it goes away with the page.
//
// A turn is not re-entrant: an action that called a helper of this module for the same page would
// queue behind itself and never end. So no helper calls another one while it holds a turn, and a
// caller that needs several runs them one after the other.
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

// What an action of the pointer needs to know about its target: the first element that matches a
// selector (a string is one), the first visible element with a name, or a point. Of an element:
// - found: whether there is one. One looked for by its name is found only when it is visible. Its
//   name is its aria-label, or else, for an input of type submit, button or reset, its value, or
//   else the text it shows, compared whole and ignoring case. The text it shows is that of its text
//   nodes, with a space between the pieces of different elements, as they stand apart on the
//   screen, and every run of white space one space: a label made of "Sell" and "100" in two spans
//   is named "Sell 100". The text inside a field (an input, a textarea or a select) or an editable
//   element is left out: what is in those was typed or chosen by the user, and a textarea keeps its
//   text as a text node. An element that is editable, or sits inside a field, shows no text. The
//   value of an input of any other type is never read. Several elements with the name go by
//   document order, so a wrapper whose whole text is the name comes before the element inside it.
// - visible: whether it is connected, has a box with a size, and is not display: none or
//   visibility: hidden. A page without getComputedStyle is judged by its box alone.
// - unsafe: whether the pointer at it could reach a trading control. That is so when it matches one
//   of `unsafeSelectors`, sits inside one that does, holds an element that does, or, when it is
//   visible, has such an element at the point the pointer would land on, for instance an order
//   ticket floating over it. What it holds counts for a click only, and so does what an element at
//   that point holds when it is not the element itself or inside it: a hover or a scroll over a
//   container lands on the container, and the pane of the chart, where they are aimed at most,
//   always holds the buy and sell buttons shown on it.
// - coverage: what lies at that point, which is judged for an element that is visible and not
//   unsafe:
//   - clear: the element, something inside it, or a layer stacked over it that is nothing special.
//     The chart draws several canvases on top of each other, and a click on the one beneath
//     reaches the page through the one on top, so a layer alone is no reason to refuse.
//   - obscured: something else lies over the point, and it is a layer of `overlaySelectors` (a
//     dialog, a menu or a popup, but not the portal itself) or a frame (iframe, frame, object or
//     embed). The event would go to that, and what it is cannot be told: an order ticket has no
//     selector, and a frame cannot be looked into. obscuredBy says what it is.
//   - center-outside-viewport: no element is hit there, because the point is not on the page.
//   - hit-test-unavailable: the page cannot say what is there.
//   - not-checked: there is no element, or it is not visible, or it is unsafe.
// - obscuredBy: the covering element in a few words, its tag followed by its id, data-qa-id and
//   data-name when it has them. Empty unless the coverage is obscured.
// - rect: its box in viewport pixels, as the page reports it.
// - tradingAction: for a click, a trading action, which `tradingNames` matches ignoring case, that
//   the click would reach, quoted with the words around it. Each of the aria-label, the value of an
//   input button and the text shown is matched on its own, so that the text a user reads counts even
//   under an aria-label that says something else, and the text shown is read both with a space
//   between the pieces of different elements and with the pieces run together, so that neither a
//   label split into elements nor a word split by an element inside it gets past. That goes for the
//   element, for the element at the point, for the control that one belongs to (its closest
//   button, link or element with the role of one), and for the element around it that the page
//   makes clickable, which only the pointer cursor shows (the outermost of the elements, up to six
//   levels up, that show it), as a click on it activates those. Left out when there is none.
// A point is the target itself: it is found and visible, has no rect, and is judged the way the
// point of an element is, except that a layer or a frame anywhere at it covers it, since it lies on
// no element the caller named, and that for a click the element at the point is its target, so
// what that element holds counts.
// It answers NOT_AVAILABLE on a page without a DOM, and INVALID_INPUT for a selector that is not
// valid CSS.
//
// The caller passes the selectors to refuse, the layers that cover a page and the names of trading
// actions, because a page function cannot import them. An empty list of selectors is refused: with
// none, every element would pass.
//
// It runs in the window chrome too, whose renderer has Node integration. It only reads the DOM, and
// must never reach for anything of Node there: no require, no process, nothing but the document.
export function describeElement(
  win: TvWindow,
  target: string | PointerTarget,
  unsafeSelectors: string[],
  overlaySelectors: string[],
  tradingNames: string,
  action: PointerAction,
):
  | {
      found: boolean;
      visible: boolean;
      unsafe: boolean;
      coverage:
        'not-checked' | 'clear' | 'obscured' | 'center-outside-viewport' | 'hit-test-unavailable';
      obscuredBy: string;
      rect?: { x: number; y: number; width: number; height: number };
      tradingAction?: string;
    }
  | PageErrorSentinel {
  type Coverage =
    'not-checked' | 'clear' | 'obscured' | 'center-outside-viewport' | 'hit-test-unavailable';
  const doc = win.document;
  const noDom: PageErrorSentinel = {
    __tvmcpError: {
      code: 'NOT_AVAILABLE',
      message: 'The page has no DOM to look elements up in',
      hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
    },
  };
  if (typeof doc.querySelector !== 'function') {
    return noDom;
  }
  if (unsafeSelectors.length === 0) {
    throw new Error('describeElement needs the selectors to treat as unsafe');
  }
  if (overlaySelectors.length === 0) {
    throw new Error('describeElement needs the selectors of the layers that cover a page');
  }
  const wanted = typeof target === 'string' ? { selector: target } : target;
  const click = action === 'click';
  const unsafeList = unsafeSelectors.join(', ');
  const trading = new RegExp(tradingNames, 'i');

  // A field, whose content the user typed or chose.
  const field = (node: Element): boolean =>
    ['input', 'textarea', 'select'].includes(node.localName);
  // What the user typed or chose: a field, or an element that is editable. isContentEditable is the
  // page's own answer: an element of an editable region is editable, and one inside a
  // contenteditable="false" block of it is not.
  const typedIn = (node: Element): boolean =>
    field(node) || ('isContentEditable' in node && node.isContentEditable === true);
  // White space as a user reads it: every run of it one space, none at the ends.
  const collapsed = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim();
  // The text an element shows, read two ways. spaced has a space between the pieces of different
  // elements, as they stand apart on the screen, so that a label split into "Sell" and "100" reads
  // "Sell 100": that is how a name reads. joined runs the pieces together, as a word that an element
  // splits inside ("S" in a u, then "ell 100") is still one word on the screen: the trading check
  // reads both. Nothing that was typed: an element that is typed into, or sits inside a field, shows
  // nothing, and the fields and editable regions inside an element are left out.
  const texts = (element: Element): { spaced: string; joined: string } => {
    if (typedIn(element)) {
      return { spaced: '', joined: '' };
    }
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      if (field(node)) {
        return { spaced: '', joined: '' };
      }
    }
    let spaced = '';
    let joined = '';
    const collect = (node: Element): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          spaced += (child as CharacterData).data;
          joined += (child as CharacterData).data;
        } else if (child.nodeType === 1 && !typedIn(child as Element)) {
          spaced += ' ';
          collect(child as Element);
          spaced += ' ';
        }
      }
    };
    collect(element);
    return { spaced: collapsed(spaced), joined: collapsed(joined) };
  };
  const readable = (element: Element): string => texts(element).spaced;
  // The label of a button made of an input of type submit, button or reset: its value, which the
  // page sets and the user does not type, and which is its value attribute. The value of an input of
  // any other type is never read.
  const buttonValue = (element: Element): string =>
    element.localName === 'input' &&
    ['submit', 'button', 'reset'].includes((element.getAttribute('type') ?? '').toLowerCase())
      ? collapsed(element.getAttribute('value'))
      : '';
  // The name of an element: its aria-label, or else the label of an input button, or else the text
  // it shows.
  const nameOf = (element: Element): string => {
    const label = collapsed(element.getAttribute('aria-label'));
    if (label !== '') {
      return label;
    }
    const value = buttonValue(element);
    return value !== '' ? value : readable(element);
  };
  // The control an element belongs to: itself or its closest ancestor that a click activates.
  const controlOf = (element: Element): Element | null => {
    const roles = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (
        ['button', 'a', 'label', 'summary'].includes(node.localName) ||
        [...roles, 'tab', 'switch', 'checkbox', 'radio'].includes(node.getAttribute('role') ?? '')
      ) {
        return node;
      }
    }
    return null;
  };
  // The element a handler of the page makes clickable around an element, which nothing but the
  // pointer cursor it shows tells: a div without a role is clickable that way. The cursor is
  // inherited, so what lies inside such an element shows the pointer too, and the clickable one is
  // where the run of elements that show it ends: from the element, or the first ancestor that shows
  // it, up to the last one that does, six levels above the element at most. A page that cannot say
  // which cursor an element shows (no getComputedStyle, or one that throws) has none of these.
  const clickableOf = (element: Element): Element | null => {
    if (typeof win.getComputedStyle !== 'function') {
      return null;
    }
    try {
      let clickable: Element | null = null;
      let node: Element | null = element;
      for (let level = 0; node !== null && level <= 6; level += 1) {
        if (win.getComputedStyle(node).cursor === 'pointer') {
          clickable = node;
        } else if (clickable !== null) {
          break;
        }
        node = node.parentElement;
      }
      return clickable;
    } catch {
      return null;
    }
  };
  // The words around the trading action the pattern finds in a name, twenty characters on each
  // side at most, to show why a click was refused.
  const around = (name: string): string | undefined => {
    const match = trading.exec(name);
    if (match === null) {
      return undefined;
    }
    const start = Math.max(0, match.index - 20);
    const end = Math.min(name.length, match.index + match[0].length + 20);
    return `${start > 0 ? '…' : ''}${name.slice(start, end)}${end < name.length ? '…' : ''}`;
  };
  // The trading action that a click on `element` would reach, if any, quoted with the words around
  // it: the aria-label, the label of an input button and the text shown, read both ways, each on
  // its own, of the element, of its control and of the clickable element around it. The text shown
  // counts even when an aria-label says something else, as the user reads that text and not the
  // label.
  const tradingNameAt = (element: Element): string | undefined => {
    const reached = [element];
    for (const around of [controlOf(element), clickableOf(element)]) {
      if (around !== null && !reached.includes(around)) {
        reached.push(around);
      }
    }
    for (const named of reached) {
      const { spaced, joined } = texts(named);
      for (const name of [
        collapsed(named.getAttribute('aria-label')),
        buttonValue(named),
        spaced,
        joined,
      ]) {
        const quoted = around(name);
        if (quoted !== undefined) {
          return quoted;
        }
      }
    }
    return undefined;
  };

  // What lies at the point (x, y) of `element`, or of no element for a point that is the target.
  const judge = (
    x: number,
    y: number,
    element: Element | null,
  ): { unsafe: boolean; coverage: Coverage; obscuredBy: string; tradingAction?: string } => {
    if (typeof doc.elementFromPoint !== 'function') {
      return { unsafe: false, coverage: 'hit-test-unavailable', obscuredBy: '' };
    }
    const hit = doc.elementFromPoint(x, y);
    if (hit === null) {
      return { unsafe: false, coverage: 'center-outside-viewport', obscuredBy: '' };
    }
    // What the pointer would hit is judged, and for a click also what that holds, unless it is the
    // target or inside it, whose holding was judged already: a click on an element that holds a
    // trading control is refused, whether the element is the target, lies at the point of a target
    // that is a point, or lies over the center of a target named by a selector or a text. A hover
    // or a scroll lands on the element it hits, so what that holds is no reason for them.
    if (
      hit.closest(unsafeList) !== null ||
      (click && !element?.contains(hit) && hit.querySelector(unsafeList) !== null)
    ) {
      return { unsafe: true, coverage: 'not-checked', obscuredBy: '' };
    }
    const tradingAction = click ? tradingNameAt(hit) : undefined;
    const named = tradingAction === undefined ? {} : { tradingAction };
    // The portal that holds the dialogs is not a layer of itself, so hitting it is not being
    // covered, and neither is hitting the element or something inside it.
    const layer = hit.closest(overlaySelectors.join(', '));
    const inLayer = layer !== null && layer !== hit;
    const inFrame = ['iframe', 'frame', 'object', 'embed'].includes(hit.localName);
    if (!element?.contains(hit) && (inLayer || inFrame)) {
      let obscuredBy = hit.localName;
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
      return {
        unsafe: false,
        coverage: 'obscured',
        obscuredBy: obscuredBy.slice(0, 120),
        ...named,
      };
    }
    return { unsafe: false, coverage: 'clear', obscuredBy: '', ...named };
  };

  if ('x' in wanted) {
    return { found: true, visible: true, ...judge(wanted.x, wanted.y, null) };
  }

  const shown = (element: Element, box = element.getBoundingClientRect()): boolean => {
    if (!(element.isConnected && box.width > 0 && box.height > 0)) {
      return false;
    }
    if (typeof win.getComputedStyle !== 'function') {
      return true;
    }
    const style = win.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };

  let element: Element | null = null;
  if ('text' in wanted) {
    if (typeof doc.querySelectorAll !== 'function') {
      return noDom;
    }
    const name = collapsed(wanted.text).toLowerCase();
    for (const listed of Array.from(doc.querySelectorAll('*'))) {
      // A real page lists elements, of which the type of the window records only the box.
      const candidate = listed as Element;
      if (nameOf(candidate).toLowerCase() === name && shown(candidate)) {
        element = candidate;
        break;
      }
    }
  } else {
    try {
      element = doc.querySelector(wanted.selector);
    } catch {
      // querySelector throws only for a selector it cannot parse.
      return {
        __tvmcpError: {
          code: 'INVALID_INPUT',
          message: `The selector is not valid CSS: ${wanted.selector}`,
          hint: 'Use a CSS selector such as #id or [data-name="..."].',
          details: { selector: wanted.selector },
        },
      };
    }
  }
  if (element === null) {
    return { found: false, visible: false, unsafe: false, coverage: 'not-checked', obscuredBy: '' };
  }

  const box = element.getBoundingClientRect();
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  const visible = shown(element, box);
  // closest starts at the element itself, so it also covers an element that matches.
  let unsafe =
    element.closest(unsafeList) !== null || (click && element.querySelector(unsafeList) !== null);
  let coverage: Coverage = 'not-checked';
  let obscuredBy = '';
  let tradingAction = click && !unsafe ? tradingNameAt(element) : undefined;
  if (!unsafe && visible) {
    // The same point the pointer is sent to.
    const judged = judge(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2),
      element,
    );
    ({ unsafe, coverage, obscuredBy } = judged);
    tradingAction ??= judged.tradingAction;
  }
  return {
    found: true,
    visible,
    unsafe,
    coverage,
    obscuredBy,
    rect,
    ...(tradingAction === undefined ? {} : { tradingAction }),
  };
}

// An element as findElements lists it. A type alias, not an interface: it comes back from the page
// as JSON, which a type must satisfy JsonValue for.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type FoundElement = {
  selector: string | null;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  unsafe: boolean;
  holdsUnsafe: boolean;
};

// The visible elements of the page that match `query`, for a caller to aim the pointer with: those
// that match its selector, every element for null, and of those the ones named its text, any for
// null, named as describeElement names them. In document order, at most `limit`, and `more` says
// whether more match. Each comes with:
// - selector: one that picks it, which is to say whose first match it is, so that the pointer sent
//   by it goes to it: by its id, data-qa-id, data-name or aria-label, in that order, the order of
//   SELECTORS. null when none of these picks it.
// - tag: its tag in lower case. role: its role attribute, null without one.
// - name: its name, and text: the text it shows, both cut at 200 characters, as describeElement
//   reads them: a space between the pieces of different elements, white space collapsed, and the
//   text inside a field or an editable element left out, of the element itself and of every element
//   around it, never read. The value of an input is read only for an input button, as its label.
// - rect: its box in CSS pixels of the viewport, as the page reports it, which is what a point of
//   the pointer is in.
// - visible: true, as only visible elements are listed (visible as describeElement means it).
// - unsafe: whether it is a trading control or sits inside one, which the pointer is refused at.
// - holdsUnsafe: whether it holds one, which refuses a click on it, though not a hover or a scroll.
//   What lies over the element is not looked at, nor is its name compared with trading actions.
// It answers NOT_AVAILABLE on a page without a DOM, and INVALID_INPUT for a selector that is not
// valid CSS. A page function cannot share code with another, so the name and the visibility are
// worked out here the way describeElement works them out, and tests keep the two in step.
//
// It runs in the window chrome too, whose renderer has Node integration. It only reads the DOM, and
// must never reach for anything of Node there: no require, no process, nothing but the document.
export function findElements(
  win: TvWindow,
  query: { selector: string | null; text: string | null },
  limit: number,
  unsafeSelectors: string[],
): { elements: FoundElement[]; more: boolean } | PageErrorSentinel {
  const doc = win.document;
  if (typeof doc.querySelectorAll !== 'function' || typeof doc.querySelector !== 'function') {
    return {
      __tvmcpError: {
        code: 'NOT_AVAILABLE',
        message: 'The page has no DOM to look elements up in',
        hint: 'Make sure the target is a loaded TradingView page, not a blank or helper page.',
      },
    };
  }
  if (unsafeSelectors.length === 0) {
    throw new Error('findElements needs the selectors to treat as unsafe');
  }
  const selector = query.selector ?? '*';
  let candidates: ArrayLike<BoxElementLike>;
  try {
    candidates = doc.querySelectorAll(selector);
  } catch {
    // querySelectorAll throws only for a selector it cannot parse.
    return {
      __tvmcpError: {
        code: 'INVALID_INPUT',
        message: `The selector is not valid CSS: ${selector}`,
        hint: 'Use a CSS selector such as #id or [data-name="..."].',
        details: { selector },
      },
    };
  }

  // A field, whose content the user typed or chose.
  const field = (node: Element): boolean =>
    ['input', 'textarea', 'select'].includes(node.localName);
  // What the user typed or chose: a field, or an element that is editable. isContentEditable is the
  // page's own answer: an element of an editable region is editable, and one inside a
  // contenteditable="false" block of it is not.
  const typedIn = (node: Element): boolean =>
    field(node) || ('isContentEditable' in node && node.isContentEditable === true);
  // White space as a user reads it: every run of it one space, none at the ends.
  const collapsed = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim();
  // The text an element shows: its text nodes, with a space between the pieces of different
  // elements, as they stand apart on the screen, so that a label split into "Sell" and "100" reads
  // "Sell 100". Nothing that was typed: an element that is typed into, or sits inside a field,
  // shows nothing, and the fields and editable regions inside an element are left out.
  const readable = (element: Element): string => {
    if (typedIn(element)) {
      return '';
    }
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      if (field(node)) {
        return '';
      }
    }
    let text = '';
    const collect = (node: Element): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          text += (child as CharacterData).data;
        } else if (child.nodeType === 1 && !typedIn(child as Element)) {
          text += ' ';
          collect(child as Element);
          text += ' ';
        }
      }
    };
    collect(element);
    return collapsed(text);
  };
  // The label of a button made of an input of type submit, button or reset: its value, which the
  // page sets and the user does not type, and which is its value attribute. The value of an input of
  // any other type is never read.
  const buttonValue = (element: Element): string =>
    element.localName === 'input' &&
    ['submit', 'button', 'reset'].includes((element.getAttribute('type') ?? '').toLowerCase())
      ? collapsed(element.getAttribute('value'))
      : '';
  // The name of an element: its aria-label, or else the label of an input button, or else the text
  // it shows.
  const nameOf = (element: Element): string => {
    const label = collapsed(element.getAttribute('aria-label'));
    if (label !== '') {
      return label;
    }
    const value = buttonValue(element);
    return value !== '' ? value : readable(element);
  };
  const shown = (element: Element, box = element.getBoundingClientRect()): boolean => {
    if (!(element.isConnected && box.width > 0 && box.height > 0)) {
      return false;
    }
    if (typeof win.getComputedStyle !== 'function') {
      return true;
    }
    const style = win.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  // At most 200 characters, without cutting a character made of two halves in two.
  const cut = (value: string): string => {
    if (value.length <= 200) {
      return value;
    }
    const last = value.charCodeAt(199);
    return value.slice(0, last >= 0xd800 && last <= 0xdbff ? 199 : 200);
  };
  // A value in double quotes for an attribute selector, with what would end it or break it escaped.
  const quoted = (value: string): string => {
    let escaped = '';
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (character === '"' || character === '\\') {
        escaped += `\\${character}`;
      } else if (code < 0x20 || code === 0x7f) {
        escaped += `\\${code.toString(16)} `;
      } else {
        escaped += character;
      }
    }
    return `"${escaped}"`;
  };
  const selectorOf = (element: Element): string | null => {
    const tries: string[] = [];
    if (element.id !== '') {
      // An id that is no CSS identifier, such as one that starts with a digit, goes in quotes.
      tries.push(
        /^[A-Za-z_][\w-]*$/.test(element.id) ? `#${element.id}` : `[id=${quoted(element.id)}]`,
      );
    }
    for (const attribute of ['data-qa-id', 'data-name', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value !== null && value !== '') {
        tries.push(`[${attribute}=${quoted(value)}]`);
      }
    }
    for (const candidate of tries) {
      try {
        if (doc.querySelector?.(candidate) === element) {
          return candidate;
        }
      } catch {
        // A value that no selector of this form can carry: the next one may do.
      }
    }
    return null;
  };

  const wanted = query.text === null ? null : collapsed(query.text).toLowerCase();
  const unsafeList = unsafeSelectors.join(', ');
  const elements: FoundElement[] = [];
  let more = false;
  for (const listed of Array.from(candidates)) {
    // A real page lists elements, of which the type of the window records only the box.
    const element = listed as Element;
    const name = nameOf(element);
    const box = element.getBoundingClientRect();
    if ((wanted !== null && name.toLowerCase() !== wanted) || !shown(element, box)) {
      continue;
    }
    if (elements.length >= limit) {
      more = true;
      break;
    }
    elements.push({
      selector: selectorOf(element),
      tag: element.localName,
      role: element.getAttribute('role'),
      name: cut(name),
      text: cut(readable(element)),
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      visible: true,
      unsafe: element.closest(unsafeList) !== null,
      holdsUnsafe: element.querySelector(unsafeList) !== null,
    });
  }
  return { elements, more };
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

// What describeElement says about a target, without the way it can fail.
type TargetDescription = Exclude<ReturnType<typeof describeElement>, PageErrorSentinel>;

const TRADING_HINT =
  'Trading controls are off limits to this server. Place orders in the TradingView window yourself.';
const TRADING_ACTION_HINT =
  'Trading actions are never clicked: this server places no orders. Place orders in the ' +
  'TradingView window yourself.';
const LOADED_PAGE_HINT =
  'Make sure the target is a loaded TradingView page, not a blank or helper page.';
const POINT_HINT =
  'Give x and y in CSS pixels from the top left of the visible part of the page, as ' +
  'ui_find_element reports the rect of an element.';

// How a refusal names the action, at an element and at a point.
const VERB: Record<PointerAction, string> = {
  click: 'click',
  hover: 'hover over',
  scroll: 'scroll over',
};
const VERB_AT: Record<PointerAction, string> = {
  click: 'click at',
  hover: 'hover at',
  scroll: 'scroll at',
};

// What the page says about the target of `action`.
function lookAt(
  page: InputPage,
  target: PointerTarget,
  action: PointerAction,
): Promise<TargetDescription> {
  return page.bridge.evaluate(describeElement, [
    target,
    [...UNSAFE_SELECTORS],
    [SELECTORS.regions.overlapManagerRoot],
    TRADING_ACTION_NAMES,
    action,
  ]);
}

// A click the page says would reach a trading action by its name.
function tradingActionRefused(what: string, name: string, details: JsonObject): TvMcpError {
  return new TvMcpError(
    'UNSAFE_ACTION_BLOCKED',
    `Refusing to click ${what}: the click would reach ${JSON.stringify(name)}, a trading action`,
    { hint: TRADING_ACTION_HINT, details: { ...details, name } },
  );
}

// Whole pixels, which is also the point describeElement judged.
function centerOf(rect: { x: number; y: number; width: number; height: number }): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function outsideTheViewport(point: Point): TvMcpError {
  return new TvMcpError(
    'INVALID_INPUT',
    `The point (${String(point.x)}, ${String(point.y)}) is outside the visible part of the page`,
    { hint: POINT_HINT, details: { x: point.x, y: point.y } },
  );
}

// The point to send the pointer to for an element, the center of its box, or the reason it may not
// go there. The unsafe verdicts come first, so a trading control, and for a click an element named
// after a trading action, is reported as one even when it is also hidden or covered. An element
// named by a text that no visible element has is the caller's mistake, INVALID_INPUT, where an
// element a selector names is NOT_AVAILABLE until it is shown.
function aimAtElement(
  target: { selector: string } | { text: string },
  action: PointerAction,
  look: TargetDescription,
): Point | TvMcpError {
  const byText = 'text' in target;
  const what = byText
    ? `the element named ${JSON.stringify(target.text)}`
    : `\`${target.selector}\``;
  const subject = byText
    ? `The element named ${JSON.stringify(target.text)}`
    : `The element ${what}`;
  const named: JsonObject = byText ? { text: target.text } : { selector: target.selector };
  if (look.unsafe) {
    return new TvMcpError(
      'UNSAFE_ACTION_BLOCKED',
      `Refusing to ${VERB[action]} ${what}: ${
        action === 'click'
          ? 'it is part of a broker trading control, holds one, or has one over it'
          : 'it is part of a broker trading control or has one over it'
      }`,
      { hint: TRADING_HINT, details: named },
    );
  }
  if (look.tradingAction !== undefined) {
    return tradingActionRefused(what, look.tradingAction, named);
  }
  const { rect } = look;
  if (!look.found || !look.visible || rect === undefined) {
    if (byText) {
      return new TvMcpError(
        'INVALID_INPUT',
        `No visible element is named ${JSON.stringify(target.text)}`,
        {
          hint:
            `The name of an element is ${NAME_RULE}. List the elements with ui_find_element, by ` +
            'a selector such as button or [role="menuitem"], to see their names, or give a ' +
            'selector instead.',
          details: named,
        },
      );
    }
    return new TvMcpError(
      'NOT_AVAILABLE',
      look.found ? `${subject} is not visible` : `No element matches ${what}`,
      {
        hint: 'Open the panel or dialog that holds the element first, or check the selector.',
        details: { ...named, found: look.found, visible: look.visible },
      },
    );
  }
  if (look.coverage === 'obscured') {
    return new TvMcpError('NOT_AVAILABLE', `${subject} is covered by \`${look.obscuredBy}\``, {
      hint: 'Close the dialog or menu that covers it first.',
      details: { ...named, obscuredBy: look.obscuredBy },
    });
  }
  if (look.coverage !== 'clear') {
    // The point is off the page or the page cannot say what is there. Anything else that is not
    // clear is refused the same way, so that an answer nobody expected cannot pass.
    const offPage = look.coverage === 'center-outside-viewport';
    return new TvMcpError(
      'NOT_AVAILABLE',
      offPage
        ? `The center of ${what} is outside the visible part of the page`
        : `The page cannot say what lies over ${what}`,
      {
        hint: offPage ? 'Bring the element into view first.' : LOADED_PAGE_HINT,
        details: { ...named, reason: offPage ? 'center-outside-viewport' : 'hit-test-unavailable' },
      },
    );
  }
  return centerOf(rect);
}

// A point goes where it is, or the reason it may not. For a click the element at the point is the
// target, so one that holds a trading control is refused as well, and so is one whose name, or that
// of its control, is a trading action. A point outside the viewport is the caller's mistake,
// INVALID_INPUT, unlike the center of an element that is out of view.
function aimAtPoint(
  point: Point,
  action: PointerAction,
  look: TargetDescription,
): Point | TvMcpError {
  const at = `(${String(point.x)}, ${String(point.y)})`;
  const where = { x: point.x, y: point.y };
  if (look.unsafe) {
    return new TvMcpError(
      'UNSAFE_ACTION_BLOCKED',
      `Refusing to ${VERB_AT[action]} ${at}: ${
        action === 'click'
          ? 'what lies there is part of a broker trading control or holds one'
          : 'a broker trading control lies there'
      }`,
      { hint: TRADING_HINT, details: where },
    );
  }
  if (look.tradingAction !== undefined) {
    return tradingActionRefused(`at ${at}`, look.tradingAction, where);
  }
  if (look.coverage === 'clear') {
    return point;
  }
  if (look.coverage === 'obscured') {
    return new TvMcpError('NOT_AVAILABLE', `The point ${at} is covered by \`${look.obscuredBy}\``, {
      hint:
        'Close the dialog or menu that covers it first. To act on an item of an open menu or ' +
        'dialog, give its selector or text instead of a point.',
      details: { ...where, obscuredBy: look.obscuredBy },
    });
  }
  if (look.coverage === 'center-outside-viewport') {
    return outsideTheViewport(point);
  }
  return new TvMcpError('NOT_AVAILABLE', `The page cannot say what lies at ${at}`, {
    hint: LOADED_PAGE_HINT,
    details: { ...where, reason: 'hit-test-unavailable' },
  });
}

function aimAt(
  target: PointerTarget,
  action: PointerAction,
  look: TargetDescription,
): Point | TvMcpError {
  return 'x' in target ? aimAtPoint(target, action, look) : aimAtElement(target, action, look);
}

// Where the pointer goes: the point in the CSS pixels the page judged it in, and the same point in
// the device-independent pixels (DIPs) of the window that a mouse event is sent in. The page zoom of
// the app (0.2 to 5, 1 at 100%) is how many DIPs a CSS pixel takes: at any other zoom than 1, a
// point sent as the page reports it would land somewhere the page has not looked.
interface Aim {
  point: Point;
  dips: Point;
}

function aimed(point: Point, zoom: number): Aim {
  return { point, dips: { x: point.x * zoom, y: point.y * zoom } };
}

// The page zoom of the app, as the page reports it. A page that does not report its viewport
// (readViewport), or reports it without the zoom, is refused: taken as 1, a point would land where
// the page has not looked whenever the zoom is another.
async function zoomOf(page: InputPage): Promise<number> {
  const { zoom, zoomReported } = await readViewport(page.session);
  if (!zoomReported) {
    throw new TvMcpError('NOT_AVAILABLE', 'The page did not report its zoom', {
      hint: `${LOADED_PAGE_HINT} A point of the page cannot be told in the window without its zoom.`,
    });
  }
  return zoom;
}

// One look at the target: what the page says about it, which refuses the action or gives the point
// it judged, and the zoom of the page, which turns that point into DIPs. The zoom is read anew with
// every look, after the page has cleared the target, because a change of zoom moves everything on
// the page as much as a change of its layout does.
async function aimFor(page: InputPage, target: PointerTarget, action: PointerAction): Promise<Aim> {
  const point = aimAt(target, action, await lookAt(page, target, action));
  if (isTvMcpError(point)) {
    throw point;
  }
  return aimed(point, await zoomOf(page));
}

// The target as the page is asked about it, or INVALID_INPUT before anything is looked at or
// waited for. A point is rounded to whole pixels, which the page judges and the event goes to, the
// way the center of an element is, and a negative one is outside the viewport. A text is trimmed
// and must not be empty. A selector is the page's to judge.
function checkedTarget(target: PointerTarget): PointerTarget {
  if ('x' in target) {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new TvMcpError('INVALID_INPUT', 'A point needs x and y as finite numbers', {
        hint: POINT_HINT,
      });
    }
    const point = { x: Math.round(target.x), y: Math.round(target.y) };
    if (point.x < 0 || point.y < 0) {
      throw outsideTheViewport(point);
    }
    return point;
  }
  if ('text' in target) {
    const text = target.text.trim();
    if (text === '') {
      throw new TvMcpError('INVALID_INPUT', 'The text to look for is empty', {
        hint: `Give the name of the element: ${NAME_RULE}.`,
      });
    }
    return { text };
  }
  return target;
}

function moveTo(page: InputPage, aim: Aim): Promise<unknown> {
  return page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...aim.dips });
}

// Clicks the target with the left button, once, and resolves with the point, in CSS pixels, where
// the button went down. The target is looked up anew on every call and nothing is cached, because
// the page moves between calls. The lookup comes first and nothing is sent to the page before it
// says the target is safe, so a refused click does not even move the mouse.
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
// (aimFor).
export async function clickTarget(page: InputPage, target: PointerTarget): Promise<Point> {
  const wanted = checkedTarget(target);
  return exclusively(page, async () => {
    const { session } = page;
    await moveTo(page, await aimFor(page, wanted, 'click'));

    const { point, dips } = await aimFor(page, wanted, 'click');
    const press = { ...dips, button: 'left', clickCount: 1 } as const;
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
    return point;
  });
}

// Clicks the center of the first element that matches `selector` (clickTarget).
export async function clickElement(page: InputPage, selector: string): Promise<void> {
  await clickTarget(page, { selector });
}

// Clicks at `point`, in CSS pixels of the viewport, rounded to whole pixels (clickTarget).
export async function clickPoint(page: InputPage, point: Point): Promise<void> {
  await clickTarget(page, point);
}

// What a hover did: where the pointer is, in CSS pixels, and, when the page under it was not as
// clean once it arrived as it was before, what the second look found there.
export interface HoverResult {
  point: Point;
  warning: string | null;
}

// Moves the pointer onto the target without pressing a button, for what the page shows on hover: a
// tooltip, the buttons of a legend item, a menu that opens on hover. It is refused as a click is,
// before anything is sent, except that what an element holds does not count (describeElement).
//
// The target is looked at again once the pointer is there, as for a click. A click then presses only
// if that look is as clean as the first; a hover has already done what it does, so it reports what
// the second look found instead: a trading control under the pointer, a menu that covers the point,
// a target that is gone. A target that is clean but moved as the pointer arrived is followed to
// where the second look found it, the way a click presses there.
export async function hoverTarget(page: InputPage, target: PointerTarget): Promise<HoverResult> {
  const wanted = checkedTarget(target);
  return exclusively(page, async () => {
    const first = await aimFor(page, wanted, 'hover');
    await moveTo(page, first);

    const point = aimAt(wanted, 'hover', await lookAt(page, wanted, 'hover'));
    if (isTvMcpError(point)) {
      return {
        point: first.point,
        warning:
          point.code === 'UNSAFE_ACTION_BLOCKED'
            ? 'A broker trading control lies under the pointer since it arrived.'
            : `After the pointer arrived: ${point.message}`,
      };
    }
    if (point.x !== first.point.x || point.y !== first.point.y) {
      await moveTo(page, aimed(point, await zoomOf(page)));
    }
    return { point, warning: null };
  });
}

// Moves the pointer onto the center of the first element that matches `selector` (hoverTarget).
export function hoverElement(page: InputPage, selector: string): Promise<HoverResult> {
  return hoverTarget(page, { selector });
}

// Moves the pointer to `point`, in CSS pixels of the viewport, rounded to whole pixels
// (hoverTarget).
export function hoverPoint(page: InputPage, point: Point): Promise<HoverResult> {
  return hoverTarget(page, point);
}

// How far one turn of the mouse wheel goes, in CSS pixels: x to the right and y down.
export interface ScrollDelta {
  x: number;
  y: number;
}

// Turns the mouse wheel once over the target, by `delta`, and resolves with the point, in CSS
// pixels, where it turned. It is refused as a hover is (the pane of the chart, which holds the buy
// and sell buttons, can be scrolled), and, as for a click, the pointer arrives first, the target is
// looked at again, and the wheel turns only if that look is as clean as the first, where it found
// the target. No button goes down. The point is sent in DIPs, and the deltas as they are given, in
// CSS pixels, which is what the protocol documents them in.
export async function scrollAt(
  page: InputPage,
  target: PointerTarget,
  delta: ScrollDelta,
): Promise<Point> {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
    throw new TvMcpError('INVALID_INPUT', 'A scroll needs deltaX and deltaY as finite numbers', {
      hint: 'Give the deltas in CSS pixels: deltaY above 0 scrolls down, deltaX above 0 to the right.',
    });
  }
  const wanted = checkedTarget(target);
  return exclusively(page, async () => {
    await moveTo(page, await aimFor(page, wanted, 'scroll'));

    const { point, dips } = await aimFor(page, wanted, 'scroll');
    await page.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...dips,
      deltaX: delta.x,
      deltaY: delta.y,
    });
    return point;
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

import type { TvWindow } from '../../../src/core/tv/tv-window.js';

// A minimal DOM for the page functions that look at elements. The shared fake window of a
// TradingView chart models the chart API and has no DOM, so a test that needs elements builds a
// window here instead.
//
// There is no CSS engine. An element declares the selectors it matches, and a selector matches
// when it is one of them, character for character, or when it is the universal selector `*`,
// which every element matches. That is enough to test what a page function decides from the
// answers of matches, closest, querySelector and querySelectorAll, and it keeps the fake too small
// to hide a bug of its own. The structure follows the DOM: closest starts at the element itself,
// querySelector looks at descendants only, querySelectorAll lists in document order, the child nodes
// of an element are a text node with its own text, when it has one, followed by its children, and
// its text content is that text followed by that of its children, a later element is painted over
// an earlier one, an element that is not shown cannot be hit, and the body is focused, and holds
// the page, when nothing else has the focus.
//
// Like the shared fake window, these objects live in the host realm, so page code that runs in a
// vm context must not use `instanceof` on them.

export interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FakeElementOptions {
  // The selectors the element matches, such as '[data-name="buy-order-button"]'.
  matches?: readonly string[];
  // Viewport coordinates in CSS pixels. Defaults to a box that has a size.
  rect?: FakeRect;
  // The computed style, which defaults to that of a shown element.
  display?: string;
  visibility?: string;
  // Whether the element is part of the document. Defaults to true.
  connected?: boolean;
  children?: readonly FakeElement[];
  // What the element reports about itself. The tag is in lower case and defaults to 'div'. The
  // attributes answer getAttribute and do not make the element match a selector: that is what
  // `matches` is for. The type attribute also decides the type property, the way it does in a page.
  tag?: string;
  id?: string;
  attributes?: Readonly<Record<string, string>>;
  // The text of the element itself, which comes before the text of its children in its text
  // content. Defaults to none. A field has no text of its own in a page, whatever was typed into
  // it, so a test gives none to an input.
  text?: string;
  // Whether the element is content-editable, which is what isContentEditable reports. Without it,
  // the element reports what a page computes: editable for a contenteditable attribute of "", "true"
  // or "plaintext-only", not editable for "false", and otherwise what its parent reports.
  contentEditable?: boolean;
  // Makes the element the host of a shadow root, and says which element in it has the focus, null
  // for none. Without this the element has no shadow root, as most elements have none.
  shadowFocus?: FakeElement | null;
}

export interface FakeComputedStyle {
  display: string;
  visibility: string;
}

// A text node, as an element lists it among its child nodes. Its data and its node value are its
// text, as they are in a page.
export interface FakeTextNode {
  readonly nodeType: 3;
  readonly data: string;
  readonly nodeValue: string;
}

const DEFAULT_RECT: FakeRect = { x: 10, y: 10, width: 100, height: 40 };

// The types an input can have. A page reports any other value of the attribute, and a missing one,
// as 'text'.
const INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'search',
  'submit',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

function inputType(attribute: string | undefined): string {
  const type = attribute?.toLowerCase() ?? '';
  return INPUT_TYPES.has(type) ? type : 'text';
}

// What the fake accepts as a selector: a comma-separated list whose parts are not empty and whose
// attribute brackets are closed. Anything else throws the SyntaxError a browser throws. Commas
// inside attribute values are not supported, because no selector of the server has one.
function parseSelectorList(selectors: string): string[] {
  const parts = selectors.split(',').map((part) => part.trim());
  const opened = selectors.split('[').length - 1;
  const closed = selectors.split(']').length - 1;
  if (parts.includes('') || opened !== closed) {
    throw new SyntaxError(`'${selectors}' is not a valid selector.`);
  }
  return parts;
}

export class FakeElement {
  // Node.ELEMENT_NODE.
  readonly nodeType = 1;
  readonly isConnected: boolean;
  readonly display: string;
  readonly visibility: string;
  readonly children: readonly FakeElement[];
  readonly localName: string;
  readonly tagName: string;
  // Like the property of an element, an empty string when there is none.
  readonly id: string;
  readonly shadowRoot: { activeElement: FakeElement | null } | null;
  // The property of an input is its type normalized, so it is never empty. On any other element
  // the property reflects the attribute, as it does on a link, and is empty without one.
  readonly type: string;
  // Set by the parent when it is created, because children are built before their parent.
  parent: FakeElement | null = null;
  readonly #matches: ReadonlySet<string>;
  #rect: FakeRect;
  readonly #attributes: ReadonlyMap<string, string>;
  readonly #text: string;
  readonly #contentEditable: boolean | undefined;

  constructor(options: FakeElementOptions = {}) {
    this.#matches = new Set(options.matches);
    this.#text = options.text ?? '';
    this.#rect = { ...(options.rect ?? DEFAULT_RECT) };
    this.display = options.display ?? 'block';
    this.visibility = options.visibility ?? 'visible';
    this.isConnected = options.connected ?? true;
    this.children = options.children ?? [];
    this.localName = options.tag ?? 'div';
    this.tagName = this.localName.toUpperCase();
    this.id = options.id ?? '';
    const attributes = new Map(Object.entries(options.attributes ?? {}));
    if (options.id !== undefined) {
      attributes.set('id', options.id);
    }
    this.#attributes = attributes;
    this.#contentEditable = options.contentEditable;
    this.shadowRoot =
      options.shadowFocus === undefined ? null : { activeElement: options.shadowFocus };
    const typeAttribute = attributes.get('type');
    this.type = this.localName === 'input' ? inputType(typeAttribute) : (typeAttribute ?? '');
    for (const child of this.children) {
      child.parent = this;
    }
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  get isContentEditable(): boolean {
    if (this.#contentEditable !== undefined) {
      return this.#contentEditable;
    }
    const attribute = this.#attributes.get('contenteditable')?.toLowerCase();
    if (attribute === '' || attribute === 'true' || attribute === 'plaintext-only') {
      return true;
    }
    if (attribute === 'false') {
      return false;
    }
    return this.parent?.isContentEditable ?? false;
  }

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  // Its own text as a text node, then its children, as Node.childNodes.
  get childNodes(): (FakeTextNode | FakeElement)[] {
    const own: FakeTextNode[] =
      this.#text === '' ? [] : [{ nodeType: 3, data: this.#text, nodeValue: this.#text }];
    return [...own, ...this.children];
  }

  // Its own text, then the text of its children, in document order, as Node.textContent.
  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }

  // Moves the element, as a page does when its layout changes under the pointer. Only tests that
  // need the page to change call it.
  place(rect: FakeRect): void {
    this.#rect = { ...rect };
  }

  getBoundingClientRect(): FakeRect & { left: number; top: number; right: number; bottom: number } {
    const { x, y, width, height } = this.#rect;
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  }

  matches(selectors: string): boolean {
    return parseSelectorList(selectors).some(
      (selector) => selector === '*' || this.#matches.has(selector),
    );
  }

  // The element itself, or the nearest ancestor, that matches.
  closest(selectors: string): FakeElement | null {
    return this.matches(selectors) ? this : (this.parent?.closest(selectors) ?? null);
  }

  // Itself or a descendant, like Node.contains.
  contains(other: FakeElement): boolean {
    return this === other || this.children.some((child) => child.contains(other));
  }

  // The first descendant, in document order, that matches. Never the element itself.
  querySelector(selectors: string): FakeElement | null {
    parseSelectorList(selectors);
    return this.descendants().find((element) => element.matches(selectors)) ?? null;
  }

  // In document order: every child comes right after its parent.
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export function fakeElement(options: FakeElementOptions = {}): FakeElement {
  return new FakeElement(options);
}

// The members of the window as they really are, with the fake's own element type. A TvWindow
// takes real elements, which the fake is not, so createFakeDomWindow hands out the window as one.
export interface FakeDomWindow {
  // The viewport in CSS pixels and the window in DIPs, which is the viewport times the page zoom,
  // when the window was given a viewport or a zoom. The fake debug port answers
  // Page.getLayoutMetrics from them, and takes a window without them for one of 1280 by 720 CSS
  // pixels at a zoom of 1. Assignable, so that a test can zoom the page.
  innerWidth?: number;
  innerHeight?: number;
  outerWidth?: number;
  outerHeight?: number;
  document: {
    readonly visibilityState: 'visible';
    querySelector?: (selectors: string) => FakeElement | null;
    // Every element that matches, in document order.
    querySelectorAll?: (selectors: string) => FakeElement[];
    elementFromPoint?: (x: number, y: number) => FakeElement | null;
    // Assignable, so that a test can move the focus.
    activeElement?: FakeElement | null;
    // Assignable, so that a test can enter and leave fullscreen.
    fullscreenElement?: FakeElement | null;
  };
  getComputedStyle?: (element: FakeElement) => FakeComputedStyle;
}

export type FakeDomMember =
  | 'querySelector'
  | 'querySelectorAll'
  | 'elementFromPoint'
  | 'getComputedStyle'
  | 'activeElement'
  | 'fullscreenElement';

export interface FakeDomOptions {
  // Members to leave out, the way a page or a fake without them would be.
  without?: readonly FakeDomMember[];
  // The size of the viewport, which elementFromPoint answers null outside of, as a page does. By
  // default there is no limit.
  viewport?: { width: number; height: number };
  // The page zoom of the app: how many device-independent pixels (DIPs) a CSS pixel takes, 1 at
  // 100%. The window reports it the way the app does, with an outer width that is the inner one
  // times the zoom.
  zoom?: number;
  // The element that has the focus: null for none at all. By default it is the body, as in a page
  // where nothing was focused. The body is not part of the elements the window is built from, so
  // it takes no part in elementFromPoint.
  focus?: FakeElement | null;
  // The element that fills the screen in the browser's fullscreen mode. By default none does, which
  // a page says with null.
  fullscreen?: FakeElement | null;
}

function rectContains(rect: FakeRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

// A window whose document holds `elements`, top level first. A later element is painted over an
// earlier one, and a child over its parent, which is what elementFromPoint reports.
export function createFakeDomWindow(
  elements: readonly FakeElement[],
  options: FakeDomOptions = {},
): TvWindow {
  const all = elements.flatMap((element) => [element, ...element.descendants()]);
  const without = new Set(options.without);
  const fakeWindow: FakeDomWindow = { document: { visibilityState: 'visible' } };

  if (options.viewport !== undefined || options.zoom !== undefined) {
    const { width, height } = options.viewport ?? { width: 1280, height: 720 };
    const zoom = options.zoom ?? 1;
    fakeWindow.innerWidth = width;
    fakeWindow.innerHeight = height;
    fakeWindow.outerWidth = width * zoom;
    fakeWindow.outerHeight = height * zoom;
  }

  if (!without.has('querySelector')) {
    fakeWindow.document.querySelector = (selectors) => {
      parseSelectorList(selectors);
      return all.find((element) => element.matches(selectors)) ?? null;
    };
  }
  if (!without.has('querySelectorAll')) {
    fakeWindow.document.querySelectorAll = (selectors) => {
      parseSelectorList(selectors);
      return all.filter((element) => element.matches(selectors));
    };
  }
  if (!without.has('elementFromPoint')) {
    const { viewport } = options;
    fakeWindow.document.elementFromPoint = (x, y) => {
      if (
        viewport !== undefined &&
        (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
      ) {
        return null;
      }
      // An element that is not shown has no box to hit.
      return (
        all.findLast(
          (element) =>
            element.isConnected &&
            element.display !== 'none' &&
            element.visibility !== 'hidden' &&
            rectContains(element.getBoundingClientRect(), x, y),
        ) ?? null
      );
    };
  }
  if (!without.has('getComputedStyle')) {
    fakeWindow.getComputedStyle = (element) => ({
      display: element.display,
      visibility: element.visibility,
    });
  }
  if (!without.has('activeElement')) {
    fakeWindow.document.activeElement =
      options.focus === undefined
        ? fakeElement({ tag: 'body', children: elements })
        : options.focus;
  }
  if (!without.has('fullscreenElement')) {
    fakeWindow.document.fullscreenElement = options.fullscreen ?? null;
  }
  return fakeWindow as unknown as TvWindow;
}

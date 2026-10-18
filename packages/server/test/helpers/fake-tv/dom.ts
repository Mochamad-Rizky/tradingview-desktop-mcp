import type { TvWindow } from '../../../src/core/tv/tv-window.js';

// A minimal DOM for the page functions that look at elements. The shared fake window of a
// TradingView chart models the chart API and has no DOM, so a test that needs elements builds a
// window here instead.
//
// There is no CSS engine. An element declares the selectors it matches, and a selector matches
// when it is one of them, character for character. That is enough to test what a page function
// decides from the answers of matches, closest and querySelector, and it keeps the fake too small
// to hide a bug of its own. The structure follows the DOM: closest starts at the element itself,
// querySelector looks at descendants only, a later element is painted over an earlier one, an
// element that is not shown cannot be hit, and the body is focused, and holds the page, when
// nothing else has the focus.
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
  // Whether the element is content-editable, which is what isContentEditable reports. Defaults to
  // false.
  contentEditable?: boolean;
}

export interface FakeComputedStyle {
  display: string;
  visibility: string;
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
  readonly isConnected: boolean;
  readonly display: string;
  readonly visibility: string;
  readonly children: readonly FakeElement[];
  readonly localName: string;
  readonly tagName: string;
  // Like the property of an element, an empty string when there is none.
  readonly id: string;
  readonly isContentEditable: boolean;
  // The property of an input is its type normalized, so it is never empty. On any other element
  // the property reflects the attribute, as it does on a link, and is empty without one.
  readonly type: string;
  // Set by the parent when it is created, because children are built before their parent.
  parent: FakeElement | null = null;
  readonly #matches: ReadonlySet<string>;
  #rect: FakeRect;
  readonly #attributes: ReadonlyMap<string, string>;

  constructor(options: FakeElementOptions = {}) {
    this.#matches = new Set(options.matches);
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
    this.isContentEditable = options.contentEditable ?? false;
    const typeAttribute = attributes.get('type');
    this.type = this.localName === 'input' ? inputType(typeAttribute) : (typeAttribute ?? '');
    for (const child of this.children) {
      child.parent = this;
    }
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
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
    return parseSelectorList(selectors).some((selector) => this.#matches.has(selector));
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
  document: {
    readonly visibilityState: 'visible';
    querySelector?: (selectors: string) => FakeElement | null;
    elementFromPoint?: (x: number, y: number) => FakeElement | null;
    // Assignable, so that a test can move the focus.
    activeElement?: FakeElement | null;
  };
  getComputedStyle?: (element: FakeElement) => FakeComputedStyle;
}

export type FakeDomMember =
  'querySelector' | 'elementFromPoint' | 'getComputedStyle' | 'activeElement';

export interface FakeDomOptions {
  // Members to leave out, the way a page or a fake without them would be.
  without?: readonly FakeDomMember[];
  // The size of the viewport, which elementFromPoint answers null outside of, as a page does. By
  // default there is no limit.
  viewport?: { width: number; height: number };
  // The element that has the focus: null for none at all. By default it is the body, as in a page
  // where nothing was focused. The body is not part of the elements the window is built from, so
  // it takes no part in elementFromPoint.
  focus?: FakeElement | null;
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

  if (!without.has('querySelector')) {
    fakeWindow.document.querySelector = (selectors) => {
      parseSelectorList(selectors);
      return all.find((element) => element.matches(selectors)) ?? null;
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
  return fakeWindow as unknown as TvWindow;
}

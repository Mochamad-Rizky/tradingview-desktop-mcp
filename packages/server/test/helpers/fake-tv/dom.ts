import type { TvWindow } from '../../../src/core/tv/tv-window.js';

// A minimal DOM for the page functions that look at elements. The shared fake window of a
// TradingView chart models the chart API and has no DOM, so a test that needs elements builds a
// window here instead.
//
// There is no CSS engine. An element declares the selectors it matches, and a selector matches
// when it is one of them, character for character. That is enough to test what a page function
// decides from the answers of matches, closest and querySelector, and it keeps the fake too small
// to hide a bug of its own. The structure follows the DOM: closest starts at the element itself,
// querySelector looks at descendants only, and a later element is painted over an earlier one.
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
}

export interface FakeComputedStyle {
  display: string;
  visibility: string;
}

const DEFAULT_RECT: FakeRect = { x: 10, y: 10, width: 100, height: 40 };

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
  // Set by the parent when it is created, because children are built before their parent.
  parent: FakeElement | null = null;
  readonly #matches: ReadonlySet<string>;
  readonly #rect: FakeRect;

  constructor(options: FakeElementOptions = {}) {
    this.#matches = new Set(options.matches);
    this.#rect = { ...(options.rect ?? DEFAULT_RECT) };
    this.display = options.display ?? 'block';
    this.visibility = options.visibility ?? 'visible';
    this.isConnected = options.connected ?? true;
    this.children = options.children ?? [];
    for (const child of this.children) {
      child.parent = this;
    }
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
  };
  getComputedStyle?: (element: FakeElement) => FakeComputedStyle;
}

export type FakeDomMember = 'querySelector' | 'elementFromPoint' | 'getComputedStyle';

export interface FakeDomOptions {
  // Members to leave out, the way a page or a fake without them would be.
  without?: readonly FakeDomMember[];
}

function contains(rect: FakeRect, x: number, y: number): boolean {
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
    fakeWindow.document.elementFromPoint = (x, y) =>
      all.findLast(
        (element) => element.isConnected && contains(element.getBoundingClientRect(), x, y),
      ) ?? null;
  }
  if (!without.has('getComputedStyle')) {
    fakeWindow.getComputedStyle = (element) => ({
      display: element.display,
      visibility: element.visibility,
    });
  }
  return fakeWindow as unknown as TvWindow;
}

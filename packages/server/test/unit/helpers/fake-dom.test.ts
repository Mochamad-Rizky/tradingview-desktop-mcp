import type { TvWindow } from '../../../src/core/tv/tv-window.js';
import {
  createFakeDomWindow,
  fakeElement,
  type FakeDomWindow,
  type FakeRect,
} from '../../helpers/fake-tv/dom.js';

// Page functions that look at elements are tested against this fake DOM, so what it answers has to
// be pinned here: a test that passes because the fake answers wrongly proves nothing.

const BUTTON = '[data-name="button"]';
const PANEL = '[data-name="panel"]';

function box(x: number, y: number, width: number, height: number): FakeRect {
  return { x, y, width, height };
}

// The window is typed as a TvWindow, whose members take real elements. These tests hand the fake
// its own elements, so they look at it through its own types.
function domOf(win: TvWindow): FakeDomWindow {
  return win as unknown as FakeDomWindow;
}

describe('the fake DOM', () => {
  test('finds the first element in document order, children after their parent', () => {
    const inner = fakeElement({ matches: [BUTTON] });
    const panel = fakeElement({ matches: [PANEL], children: [inner] });
    const later = fakeElement({ matches: [BUTTON] });
    const { document } = domOf(createFakeDomWindow([panel, later]));

    expect(document.querySelector?.(PANEL)).toBe(panel);
    expect(document.querySelector?.(BUTTON)).toBe(inner);
    expect(document.querySelector?.('[data-name="missing"]')).toBeNull();
  });

  test('answers a list of selectors with the first element that matches any of them', () => {
    const panel = fakeElement({ matches: [PANEL] });
    const button = fakeElement({ matches: [BUTTON] });
    const { document } = domOf(createFakeDomWindow([panel, button]));

    expect(document.querySelector?.(`${BUTTON}, ${PANEL}`)).toBe(panel);
    expect(document.querySelector?.(`[data-name="missing"], ${BUTTON}`)).toBe(button);
  });

  test('closest starts at the element itself and walks up the parents', () => {
    const button = fakeElement({ matches: [BUTTON] });
    const panel = fakeElement({ matches: [PANEL], children: [button] });
    const sibling = fakeElement();

    expect(button.closest(BUTTON)).toBe(button);
    expect(button.closest(PANEL)).toBe(panel);
    expect(button.closest(`${PANEL}, ${BUTTON}`)).toBe(button);
    expect(panel.closest(BUTTON)).toBeNull();
    expect(sibling.closest(PANEL)).toBeNull();
  });

  test('querySelector of an element looks at its descendants only, nearest in document order', () => {
    const deep = fakeElement({ matches: [BUTTON] });
    const shallow = fakeElement({ matches: [BUTTON] });
    const panel = fakeElement({
      matches: [PANEL, BUTTON],
      children: [fakeElement({ children: [deep] }), shallow],
    });

    expect(panel.querySelector(BUTTON)).toBe(deep);
    expect(panel.querySelector(PANEL)).toBeNull();
    expect(fakeElement({ matches: [BUTTON] }).querySelector(BUTTON)).toBeNull();
  });

  test('reports the box it was given, and a default box that has a size', () => {
    const sized = fakeElement({ rect: box(1.5, 2.5, 30, 40) });

    expect(sized.getBoundingClientRect()).toEqual({
      x: 1.5,
      y: 2.5,
      width: 30,
      height: 40,
      left: 1.5,
      top: 2.5,
      right: 31.5,
      bottom: 42.5,
    });
    const { width, height } = fakeElement().getBoundingClientRect();
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  test('is connected unless it is told otherwise', () => {
    expect(fakeElement().isConnected).toBe(true);
    expect(fakeElement({ connected: false }).isConnected).toBe(false);
  });

  test('puts the later element on top at a point, a child above its parent, and skips detached ones', () => {
    const below = fakeElement({ rect: box(0, 0, 100, 100) });
    const inner = fakeElement({ rect: box(55, 55, 10, 10) });
    const above = fakeElement({ rect: box(50, 50, 40, 40), children: [inner] });
    const detached = fakeElement({ rect: box(0, 0, 100, 100), connected: false });
    const { document } = domOf(createFakeDomWindow([below, above, detached]));

    expect(document.elementFromPoint?.(5, 5)).toBe(below);
    expect(document.elementFromPoint?.(80, 80)).toBe(above);
    expect(document.elementFromPoint?.(60, 60)).toBe(inner);
    expect(document.elementFromPoint?.(500, 500)).toBeNull();
  });

  test('takes the left and top edges as inside the box and the right and bottom as outside', () => {
    const element = fakeElement({ rect: box(10, 20, 30, 40) });
    const { document } = domOf(createFakeDomWindow([element]));

    expect(document.elementFromPoint?.(10, 20)).toBe(element);
    expect(document.elementFromPoint?.(39, 59)).toBe(element);
    expect(document.elementFromPoint?.(40, 59)).toBeNull();
    expect(document.elementFromPoint?.(39, 60)).toBeNull();
    expect(document.elementFromPoint?.(9, 20)).toBeNull();
  });

  test('refuses what a browser refuses as a selector', () => {
    const { document } = domOf(createFakeDomWindow([fakeElement({ matches: [BUTTON] })]));
    const element = fakeElement();

    expect(() => document.querySelector?.('')).toThrow(SyntaxError);
    expect(() => document.querySelector?.('[data-name="button"')).toThrow(SyntaxError);
    expect(() => document.querySelector?.(`${BUTTON},`)).toThrow(SyntaxError);
    expect(() => element.closest('')).toThrow(SyntaxError);
    expect(() => element.querySelector('')).toThrow(SyntaxError);
  });

  test('reads the computed style from the element, with the defaults of a shown element', () => {
    const shown = fakeElement();
    const hidden = fakeElement({ display: 'none', visibility: 'hidden' });
    const { getComputedStyle } = domOf(createFakeDomWindow([shown, hidden]));

    expect(getComputedStyle?.(shown)).toEqual({ display: 'block', visibility: 'visible' });
    expect(getComputedStyle?.(hidden)).toEqual({ display: 'none', visibility: 'hidden' });
  });

  test('tells its tag, its id and the attributes it was given, like an element does', () => {
    const button = fakeElement({
      tag: 'button',
      id: 'save',
      attributes: { 'data-name': 'save-button' },
    });
    const plain = fakeElement();

    expect([button.localName, button.tagName, button.id]).toEqual(['button', 'BUTTON', 'save']);
    expect(button.getAttribute('data-name')).toBe('save-button');
    expect(button.getAttribute('id')).toBe('save');
    expect(button.getAttribute('data-qa-id')).toBeNull();
    expect([plain.localName, plain.tagName, plain.id]).toEqual(['div', 'DIV', '']);
    expect(plain.getAttribute('id')).toBeNull();
  });

  test('reports the type of an input like a page does: normalized, and text when unknown', () => {
    const typeOf = (attributes?: Record<string, string>) =>
      fakeElement({ tag: 'input', ...(attributes === undefined ? {} : { attributes }) }).type;

    expect(typeOf()).toBe('text');
    expect(typeOf({ type: 'search' })).toBe('search');
    expect(typeOf({ type: 'SEARCH' })).toBe('search');
    expect(typeOf({ type: 'checkbox' })).toBe('checkbox');
    expect(typeOf({ type: 'datetime-local' })).toBe('datetime-local');
    expect(typeOf({ type: 'foo' })).toBe('text');
    expect(typeOf({ type: '' })).toBe('text');
  });

  test('reports the type attribute of any other element as it is, like a link does', () => {
    expect(fakeElement({ tag: 'a', attributes: { type: 'text' } }).type).toBe('text');
    expect(fakeElement({ tag: 'button' }).type).toBe('');
    expect(fakeElement().type).toBe('');
  });

  test('is content-editable only when it is told so', () => {
    expect(fakeElement().isContentEditable).toBe(false);
    expect(fakeElement({ contentEditable: false }).isContentEditable).toBe(false);
    expect(fakeElement({ contentEditable: true }).isContentEditable).toBe(true);
  });

  test('has the body focused unless it is told otherwise, and the body holds the page', () => {
    const button = fakeElement({ matches: [BUTTON] });
    const panel = fakeElement({ matches: [PANEL], children: [fakeElement()] });
    const page = [button, panel];

    const byDefault = domOf(createFakeDomWindow(page)).document.activeElement;
    const onButton = domOf(createFakeDomWindow(page, { focus: button })).document.activeElement;
    const nowhere = domOf(createFakeDomWindow(page, { focus: null })).document.activeElement;

    expect(byDefault?.localName).toBe('body');
    expect(byDefault?.querySelector(BUTTON)).toBe(button);
    expect(byDefault?.querySelector(PANEL)).toBe(panel);
    expect(onButton).toBe(button);
    expect(nowhere).toBeNull();
  });

  test('moves the focus when a test assigns it', () => {
    const button = fakeElement({ matches: [BUTTON] });
    const { document } = domOf(createFakeDomWindow([button]));

    document.activeElement = button;

    expect(document.activeElement).toBe(button);
  });

  test('can leave out the members a page or a fake might lack', () => {
    const element = fakeElement({ matches: [BUTTON] });

    const full = domOf(createFakeDomWindow([element]));
    const bare = domOf(
      createFakeDomWindow([element], {
        without: ['querySelector', 'elementFromPoint', 'getComputedStyle', 'activeElement'],
      }),
    );
    const partial = domOf(createFakeDomWindow([element], { without: ['elementFromPoint'] }));

    expect(typeof full.document.querySelector).toBe('function');
    expect(typeof full.document.elementFromPoint).toBe('function');
    expect(typeof full.getComputedStyle).toBe('function');
    expect(full.document.activeElement).toBeDefined();
    expect(bare.document.querySelector).toBeUndefined();
    expect(bare.document.elementFromPoint).toBeUndefined();
    expect(bare.getComputedStyle).toBeUndefined();
    expect(bare.document.activeElement).toBeUndefined();
    expect(bare.document.visibilityState).toBe('visible');
    expect(typeof partial.document.querySelector).toBe('function');
    expect(partial.document.elementFromPoint).toBeUndefined();
    expect(typeof partial.getComputedStyle).toBe('function');
  });
});

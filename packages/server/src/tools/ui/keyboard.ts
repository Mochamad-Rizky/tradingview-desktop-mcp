import { z } from 'zod';
import { pressKey, SUPPORTED_KEYS, typeText } from '../../core/tv/input.js';
import { defineTool } from '../types.js';
import { ACTS, targetInput, TRADING_NAMES, uiTargetPage } from './pointer.js';

// The keyboard tools of the low-level interface (design spec 7, domain Low-level UI): text typed
// into the focused field of TradingView, and a key pressed on the focused element. They go through
// the guarded input helpers (core/tv/input.ts), which look at the focus before anything is sent:
// text goes only into a focused text field, and a key is refused while the focus is on a trading
// control or a trading action, since a key on a focused button clicks it. On the window chrome they
// only read its DOM, through the page function of the helpers, and send it input events.

const MAX_TEXT = 1000;
const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;

export const uiTypeText = defineTool({
  name: 'ui_type_text',
  domain: 'ui',
  title: 'Type text',
  description:
    'Types text into the text field that has the focus in TradingView, the way an input method ' +
    'inserts it: no key events, so no shortcut of the app sees the letters, and a line break in ' +
    'the text is inserted as text, never pressed as Enter (ui_press_key presses keys). Focus the ' +
    'field first, for example with ui_click on it. Text goes only into a focused text field, an ' +
    'input that takes text, a text area or an editable region: with the focus on a button, a ' +
    'container, the page itself or nothing, or inside a frame or a shadow root, which this ' +
    'server cannot look into, it fails with NOT_AVAILABLE and nothing is typed. A field that is ' +
    'part of a trading control (the buy and sell buttons and the trade button) is refused with ' +
    'UNSAFE_ACTION_BLOCKED, because this server places no orders. target chart (default) is the ' +
    'chart tab; window is the window chrome, the strip with the tabs. Returns target and ' +
    'characters, how many were typed.',
  inputSchema: {
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .describe('The text to type, 1 to 1000 characters, as it is.'),
    target: targetInput(),
  },
  annotations: ACTS,
  // The text can be the user's own words: it stays out of the tool events.
  redactArgs: true,
  async handler({ text, target }, ctx) {
    const page = await uiTargetPage(ctx, target);
    await typeText(page, text);
    return { data: { target, characters: Array.from(text).length }, via: 'cdp' };
  },
});

export const uiPressKey = defineTool({
  name: 'ui_press_key',
  domain: 'ui',
  title: 'Press a key',
  description:
    'Presses a key once in TradingView, on the element that has the focus, with modifiers held, ' +
    'for what the app does on a key: Escape closes a menu or a dialog, Enter confirms it, the ' +
    'arrows move in a list, Control and Z undoes. key is one of ' +
    `${SUPPORTED_KEYS}; anything else is INVALID_INPUT and nothing is sent. modifiers are ` +
    'any of Alt, Control, Meta and Shift; a key held with Alt, Control or Meta types nothing and ' +
    'reaches the shortcuts of the app. Trading actions are never keyed, because this server ' +
    'places no orders: a key is refused with UNSAFE_ACTION_BLOCKED, before anything is sent, ' +
    'while the focus is on or inside a trading control (the buy and sell buttons and the trade ' +
    `button), and while a trading action (${TRADING_NAMES}, as words) is named by the ` +
    'aria-label or the input button value of the focused element, or by the aria-label, the input ' +
    'button value or the text shown of the control it belongs to: its closest button, link (a), ' +
    'label or summary element, or element with the role button, link, menuitem, ' +
    'menuitemcheckbox, menuitemradio, option, tab, switch, checkbox or radio, which can be the ' +
    'focused element itself, or the element around it, up to six levels up, that the pointer ' +
    'cursor shows as clickable. So a key in a field inside a label that names a trading action is ' +
    'refused too. Enter or Space clicks a focused control. The text a focused element that is no ' +
    'control shows is not read, since a ' +
    'key does not reach what it holds. Enter is also refused in a field of a form whose default ' +
    'button is named so, since Enter submits the form through it. With the focus ' +
    'inside a frame or a shadow root, or on a page that cannot say what has the focus, it fails ' +
    'with NOT_AVAILABLE. Whether TradingView binds a trading action to a key chord is not known, ' +
    'so prefer keys that close, confirm or move. target chart (default) or window, the window ' +
    'chrome. Returns target, key and modifiers.',
  inputSchema: {
    key: z.string().min(1).max(20).describe(`The key, by its name: ${SUPPORTED_KEYS}.`),
    modifiers: z
      .array(z.enum(MODIFIERS))
      .max(MODIFIERS.length)
      .optional()
      .describe('The modifiers held with the key: Alt, Control, Meta and Shift. None by default.'),
    target: targetInput(),
  },
  annotations: ACTS,
  async handler({ key, modifiers, target }, ctx) {
    const page = await uiTargetPage(ctx, target);
    await pressKey(page, key, modifiers ?? []);
    return { data: { target, key, modifiers: modifiers ?? [] }, via: 'cdp' };
  },
});

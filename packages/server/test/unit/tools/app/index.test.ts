import { z } from 'zod';
import { appTools } from '../../../../src/tools/app/index.js';
import type { AnyToolDefinition } from '../../../../src/tools/types.js';

// What the model and the client see of the app tools: their names, their annotations, and the
// promises their descriptions make. The behavior behind them is tested through a server in
// test/integration/tools/app.test.ts.

function toolNamed(name: string): AnyToolDefinition {
  const tool = appTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`There is no app tool ${name}`);
  }
  return tool;
}

const descriptionOf = (tool: AnyToolDefinition, field: string): string | undefined =>
  z.globalRegistry.get(tool.inputSchema[field] ?? z.never())?.description;

test('appTools lists the app tools of the catalog, in its order', () => {
  expect(appTools.map(({ name }) => name)).toEqual([
    'app_launch',
    'app_health',
    'app_discover',
    'app_get_ui_state',
    'app_reconnect',
  ]);
  expect(new Set(appTools.map(({ domain }) => domain))).toEqual(new Set(['app']));
});

test('every app tool is part of the core profile', () => {
  expect(appTools.map(({ core }) => core)).toEqual([true, true, true, true, true]);
});

// A client asks the user before a call by these hints, while confirm is filled in by the model, so
// a tool with a mode that can lose unsaved work says it is destructive: app_launch with restart,
// app_reconnect with reloadTab, which reloads the page again on every call.
test.each([
  ['app_launch', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
  ['app_health', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['app_discover', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['app_get_ui_state', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['app_reconnect', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
])('%s says how it acts', (name, hints) => {
  expect(toolNamed(name).annotations).toEqual({ ...hints, openWorldHint: false });
});

test('only the tools that read are read-only, so that the readonly profile keeps just them', () => {
  expect(
    appTools.filter(({ annotations }) => annotations.readOnlyHint === true).map(({ name }) => name),
  ).toEqual(['app_health', 'app_discover', 'app_get_ui_state']);
});

test('app_launch tells that a restart closes TradingView and can take more than a minute', () => {
  const { description } = toolNamed('app_launch');

  expect(description).toMatch(/restart: true/);
  expect(description).toMatch(/closes? (and reopens )?TradingView|quit and reopen/i);
  expect(description).toMatch(/unsaved/i);
  expect(description).toMatch(/confirm: true/);
  expect(description).toMatch(/more than a minute/);
  expect(description).toMatch(/time ?out/i);
});

test('app_launch takes a port only to say it must be the configured one', () => {
  const port = descriptionOf(toolNamed('app_launch'), 'port');

  expect(port).toMatch(/TV_CDP_PORT/);
  expect(port).toMatch(/omit it/i);
});

test('app_launch explains what confirm is for', () => {
  const confirm = descriptionOf(toolNamed('app_launch'), 'confirm');

  expect(confirm).toMatch(/restart: true/);
  expect(confirm).toMatch(/unsaved/i);
});

test('app_reconnect warns that reloading the tab discards what is not saved in it, and asks to confirm', () => {
  const { description } = toolNamed('app_reconnect');
  const reload = descriptionOf(toolNamed('app_reconnect'), 'reloadTab');

  expect(description).toMatch(/app_health/);
  expect(description).toMatch(/reloadTab: true/);
  expect(description).toMatch(/confirm: true/);
  expect(description).toMatch(/unsaved/i);
  expect(reload).toMatch(/reload/i);
  expect(reload).toMatch(/not saved|unsaved/i);
  expect(reload).toMatch(/confirm: true/);
});

test('app_reconnect explains what confirm is for', () => {
  const confirm = descriptionOf(toolNamed('app_reconnect'), 'confirm');

  expect(confirm).toMatch(/reloadTab: true/);
  expect(confirm).toMatch(/unsaved/i);
  expect(confirm).toMatch(/ignored/i);
});

test('app_health tells what to do when TradingView is down', () => {
  expect(toolNamed('app_health').description).toMatch(/cdp\.reachable is false/);
  expect(toolNamed('app_health').description).toMatch(/app_launch/);
});

test('the tools that take nothing have an empty input', () => {
  for (const name of ['app_health', 'app_discover', 'app_get_ui_state']) {
    expect(Object.keys(toolNamed(name).inputSchema), name).toEqual([]);
  }
});

// An MCP call is parsed by the SDK first and by the registry again, so a schema must give the
// same value when it parses its own output.
test.each([
  ['app_launch', {}],
  ['app_launch', { restart: true, confirm: true, port: 9222 }],
  ['app_launch', { port: 1 }],
  ['app_reconnect', {}],
  ['app_reconnect', { reloadTab: true }],
  ['app_reconnect', { reloadTab: true, confirm: true }],
])(
  'the input schema of %s gives the same value when it parses its own output: %j',
  (name, input) => {
    const schema = z.object(toolNamed(name).inputSchema);

    const once = schema.parse(input);

    expect(schema.parse(once)).toEqual(once);
  },
);

test('app_launch fills in restart: false and leaves the other inputs out when they are not given', () => {
  const schema = z.object(toolNamed('app_launch').inputSchema);

  expect(schema.parse({})).toEqual({ restart: false });
});

test.each([
  ['port 0', { port: 0 }],
  ['port 65536', { port: 65536 }],
  ['a fractional port', { port: 9222.5 }],
  ['a port as text', { port: '9222' }],
  ['restart as text', { restart: 'yes' }],
  ['confirm as a number', { confirm: 1 }],
])('app_launch refuses %s', (_case, input) => {
  const schema = z.object(toolNamed('app_launch').inputSchema);

  expect(schema.safeParse(input).success).toBe(false);
});

test.each([
  ['reloadTab as text', { reloadTab: 'yes' }],
  ['confirm as a number', { confirm: 1 }],
  ['confirm as text', { confirm: 'true' }],
])('app_reconnect refuses %s', (_case, input) => {
  const schema = z.object(toolNamed('app_reconnect').inputSchema);

  expect(schema.safeParse(input).success).toBe(false);
});

test('app_reconnect fills in reloadTab: false and leaves confirm out when it is not given', () => {
  const schema = z.object(toolNamed('app_reconnect').inputSchema);

  expect(schema.parse({})).toEqual({ reloadTab: false });
  expect(schema.parse({ reloadTab: true, confirm: true })).toEqual({
    reloadTab: true,
    confirm: true,
  });
});

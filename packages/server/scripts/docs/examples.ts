import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createMcpServer } from '../../src/server.js';
import type { JsonValue } from '../../src/utils/json.js';
import { toIso } from '../../src/utils/time.js';
import { startFakeCdpServer } from '../../test/helpers/fake-cdp/server.js';
import { loadTargetsFixture } from '../../test/helpers/fake-cdp/targets.js';
import { loadTvFixture } from '../../test/helpers/fake-tv/fixture.js';
import { createFakeTvWindow } from '../../test/helpers/fake-tv/window.js';
import { callTool, connectInMemoryClient } from '../../test/helpers/mcp-client.js';
import { quietLogger, refusingLauncher, testConfig } from '../../test/helpers/tool-context.js';
import { connectToApp, runScript } from '../re/session.js';
import { isEntryPoint } from './entry-point.js';
import { SCENARIOS, type Scenario, type ScenarioStep } from './scenarios.js';

// Generates docs/examples.md (`pnpm docs:examples`): every scenario of scenarios.ts runs against the
// fake TradingView app of the test suite, through the real server and an MCP client, and the
// prompts, tool calls, results and summaries are written as markdown. The results are what the
// server returns, so the page shows the real field names, errors and hints, with synthetic values.
//
// The page has to come out the same on every run, machine and time zone, because a test compares it
// with the committed file. Nothing on it depends on the clock, the time zone or the locale: the fake
// app answers from its fixture, the values of a result that come from the clock (the time of a
// compilation, which the server stamps, and the expiration of an alert set without one, which the
// server sets from the moment of the call) are pinned below, and the duration of a call is left out.
// The images a result holds are left out too, and named in a note.

export const EXAMPLES_PATH = fileURLToPath(
  new URL('../../../../docs/examples.md', import.meta.url),
);

// The longest list a result shows before the rest is counted, and the width JSON is laid out in.
const MAX_ITEMS = 3;
const WIDTH = 100;

// As in the integration tests of the tools.
const CALL_TIMEOUT_MS = 5000;

const DAY = 86_400;
// How long after the generator reads the clock the server may read it for a call, at most: far
// more than a call takes (CALL_TIMEOUT_MS), far less than a day.
const MAX_CALL_SECONDS = 60;

// What the assistant gets back from a tool, without the duration, which differs on every run.
// images are the media types of the images in front of the JSON block (a screenshot), whose data the
// page leaves out.
export type StepResult =
  | { ok: true; via: string | null; warnings: string[]; images: string[]; data: JsonValue }
  | { ok: false; error: JsonValue };

export interface ScenarioRun {
  scenario: Scenario;
  // One result for each step of the scenario, in order.
  results: StepResult[];
}

// The envelope of design spec 5.2, as far as the page shows it. Keys that are not listed here
// (meta.durationMs) are dropped by the parse.
const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.json().optional(),
  error: z.json().optional(),
  meta: z.object({ via: z.string().optional(), warnings: z.array(z.string()).optional() }),
});

type Envelope = z.infer<typeof envelopeSchema>;

function errorCodeOf(error: JsonValue | undefined): string | undefined {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

// The time of a compilation (compiledAt and compiledAtIso) is the one value of a result that comes
// from the clock: the server stamps it when it compiles. It is replaced by a fixed time in every
// result.
function pinCompileTime(value: JsonValue, time: number): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => pinCompileTime(item, time));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]): [string, JsonValue] => {
      if (key === 'compiledAt' && typeof item === 'number') {
        return [key, time];
      }
      if (key === 'compiledAtIso' && typeof item === 'string') {
        return [key, toIso(time)];
      }
      return [key, pinCompileTime(item, time)];
    }),
  );
}

// The expiration of an alert that alert_create set without being given one comes from the clock as
// well: the server sets it the default span of TradingView after the moment of the call, which it
// reads at most MAX_CALL_SECONDS after `calledAt`. The span of the fake app is 30 days (its free
// plan, the only plan the generator gives it), so the expiration is moved to as many whole days
// after `time`, and the seconds the call took drop out. An expiration that is not whole days after
// the call is refused rather than shown at a time it does not stand for. A span in calendar months,
// which the pro plan of the fake has, would be whole days too, but a different number of them at
// another time of the year, so it could not be pinned this way.
export function pinnedExpiration(expiration: number, calledAt: number, time: number): number {
  const days = Math.floor((expiration - calledAt) / DAY);
  const late = expiration - calledAt - days * DAY;
  if (days < 1 || late > MAX_CALL_SECONDS) {
    throw new Error(
      `The expiration ${toIso(expiration)} of the alert is not a whole number of days after the ` +
        `call at ${toIso(calledAt)}, so the page cannot show it from the time of the last bar`,
    );
  }
  return time + days * DAY;
}

function pinDefaultExpiration(data: JsonValue, calledAt: number, time: number): JsonValue {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return data;
  }
  const { expiration } = data;
  if (typeof expiration !== 'number') {
    return data;
  }
  const pinned = pinnedExpiration(expiration, calledAt, time);
  return { ...data, expiration: pinned, expirationIso: toIso(pinned) };
}

// The data of a result with the values that come from the clock pinned to `time`.
function pinClockTimes(
  step: ScenarioStep,
  data: JsonValue,
  calledAt: number,
  time: number,
): JsonValue {
  const pinned = pinCompileTime(data, time);
  return step.tool === 'alert_create' && step.arguments.expiration === undefined
    ? pinDefaultExpiration(pinned, calledAt, time)
    : pinned;
}

// The media types of the images in front of the JSON block of a result.
function imagesOf(result: CallToolResult): string[] {
  return result.content.flatMap((block) => (block.type === 'image' ? [block.mimeType] : []));
}

// What one call gave: its envelope and the images in front of it, and when it was made, in Unix
// seconds as the server reads the clock.
interface StepCall {
  envelope: Envelope;
  images: string[];
  calledAt: number;
}

// The result of a step if it ended as the scenario says it must: a success, or the error code that
// the step expects. Anything else is a scenario that no longer describes the tools, which stops the
// generator instead of reaching the page.
function toStepResult(
  label: string,
  step: ScenarioStep,
  { envelope, images, calledAt }: StepCall,
  pinnedTime: number,
): StepResult {
  if (envelope.ok) {
    if (step.expectError !== undefined) {
      throw new Error(`${label} should fail with ${step.expectError}, but it succeeded`);
    }
    if (envelope.data === undefined) {
      throw new Error(`${label} succeeded without data`);
    }
    return {
      ok: true,
      via: envelope.meta.via ?? null,
      warnings: envelope.meta.warnings ?? [],
      images,
      data: pinClockTimes(step, envelope.data, calledAt, pinnedTime),
    };
  }
  const code = errorCodeOf(envelope.error);
  if (envelope.error === undefined || code !== step.expectError) {
    const expected = step.expectError === undefined ? 'succeed' : `fail with ${step.expectError}`;
    throw new Error(
      `${label} should ${expected}, but it failed with ${code ?? 'an unknown error'}: ` +
        JSON.stringify(envelope.error),
    );
  }
  return { ok: false, error: envelope.error };
}

async function runSteps(
  client: Client,
  scenario: Scenario,
  pinnedTime: number,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const label = `Scenario "${scenario.title}", step ${String(index + 1)} (${step.tool})`;
    const calledAt = Math.floor(Date.now() / 1000);
    const called = await callTool(client, step.tool, step.arguments);
    const envelope = envelopeSchema.safeParse(called.structuredContent);
    if (!envelope.success) {
      throw new Error(`${label} returned no result envelope: ${z.prettifyError(envelope.error)}`);
    }
    results.push(
      toStepResult(
        label,
        step,
        { envelope: envelope.data, images: imagesOf(called), calledAt },
        pinnedTime,
      ),
    );
  }
  return results;
}

// Runs one scenario against a fake app of its own: the fake debug port of TradingView with a fake
// chart window behind it, and the real server, connected to it, with an MCP client in front. The
// connection is the one the scripts that look at the real app use. tsx compiles the page functions
// with a __name helper that the page does not have, and every tool would fail with a
// ReferenceError; that connection defines the helper around each call (scripts/re/README.md).
async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const base = loadTvFixture();
  const { bars } = base;
  // The time of the last bar of the chart, which is also the time of its last quote: the moment the
  // values that come from the clock are pinned to.
  const pinnedTime = bars.startTime + (bars.count - 1) * bars.stepSeconds;
  const win = createFakeTvWindow(scenario.fixture?.(base) ?? base);

  const cleanups: (() => Promise<void>)[] = [];
  try {
    const app = await startFakeCdpServer({
      targets: loadTargetsFixture({ chartWindow: () => win }),
    });
    cleanups.push(() => app.close());
    const config = testConfig({ cdpPort: app.port, callTimeoutMs: CALL_TIMEOUT_MS });
    const link = connectToApp(config);
    cleanups.push(() => link.close());
    const { server } = createMcpServer(config, {
      launcher: refusingLauncher(),
      logger: quietLogger,
      connection: link.connection,
    });
    cleanups.push(() => server.close());
    const client = await connectInMemoryClient(server);
    cleanups.push(() => client.close());

    return { scenario, results: await runSteps(client, scenario, pinnedTime) };
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  }
}

// Runs the scenarios one after the other, each against its own fake app.
export async function runScenarios(
  scenarios: readonly Scenario[] = SCENARIOS,
): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) {
    runs.push(await runScenario(scenario));
  }
  return runs;
}

// Lists longer than MAX_ITEMS keep their first items and end in a marker that counts the rest, so
// that the page stays readable. This is done here and not by the tools, which return everything.
export function trimArrays(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ITEMS).map(trimArrays);
    return value.length > MAX_ITEMS
      ? [...kept, `… ${String(value.length - MAX_ITEMS)} more`]
      : kept;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]): [string, JsonValue] => [key, trimArrays(item)]),
  );
}

function inlineJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(inlineJson).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`,
    );
    return members.length === 0 ? '{}' : `{ ${members.join(', ')} }`;
  }
  return JSON.stringify(value);
}

// `column` is where the value starts on its line, `trailing` how many characters follow it there (a
// comma), and `depth` how deep it is nested. A value stays on one line when that line fits in
// WIDTH, and else each member or item gets a line of its own.
function layout(value: JsonValue, column: number, trailing: number, depth: number): string {
  const inline = inlineJson(value);
  if (typeof value !== 'object' || value === null || column + inline.length + trailing <= WIDTH) {
    return inline;
  }
  const indent = '  '.repeat(depth + 1);
  const entries: [string | null, JsonValue][] = Array.isArray(value)
    ? value.map((item): [null, JsonValue] => [null, item])
    : Object.entries(value);
  const lines = entries.map(([key, item], index) => {
    const head = key === null ? indent : `${indent}${JSON.stringify(key)}: `;
    const last = index === entries.length - 1;
    return `${head}${layout(item, head.length, last ? 0 : 1, depth + 1)}${last ? '' : ','}`;
  });
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${lines.join('\n')}\n${'  '.repeat(depth)}${close}`;
}

// JSON as a person writes it: what fits in 100 columns stays on one line, the rest is indented by
// two spaces a level. The text is still valid JSON.
export function formatJson(value: JsonValue): string {
  return layout(value, 0, 0, 0);
}

// A fenced code block. Its fence is longer than any run of backticks in the text, so that the text
// can never end it.
function fenced(info: string, text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

// The strings of a value that contain line breaks, with the path of each. In JSON they are one
// line full of \n, which is hard to read for a script or a diff.
function textsWithBreaks(value: JsonValue, path: string): { path: string; text: string }[] {
  if (typeof value === 'string') {
    return value.includes('\n') ? [{ path, text: value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => textsWithBreaks(item, `${path}[${String(index)}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      textsWithBreaks(item, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

// The language that makes a text readable: the source of a script, and the diff of a change. Any
// other text gets none.
function languageOf(key: string): string {
  if (key === 'source') {
    return 'pine';
  }
  return key === 'diff' ? 'diff' : '';
}

// Each text with line breaks of a value, laid out as lines below the block that holds the value.
function unfold(value: JsonValue): string[] {
  return textsWithBreaks(value, '').flatMap(({ path, text }) => {
    const key = /(\w+)(?:\[\d+\])*$/.exec(path)?.[1] ?? '';
    const lines = text.endsWith('\n') ? text.slice(0, -1) : text;
    return [`\`${path}\`:`, fenced(languageOf(key), lines)];
  });
}

// What the page shows of a result: the envelope the assistant gets, without the duration and with
// long lists cut, and the part of it that holds the data or the error.
function shownResult(result: StepResult): { envelope: JsonValue; content: JsonValue } {
  if (!result.ok) {
    const error = trimArrays(result.error);
    // The meta of an error holds only the duration, which is left out.
    return { envelope: { ok: false, error, meta: {} }, content: error };
  }
  const data = trimArrays(result.data);
  const meta = result.via === null ? {} : { via: result.via };
  return {
    envelope: { ok: true, data, meta: trimArrays({ ...meta, warnings: result.warnings }) },
    content: data,
  };
}

// What stands on the page for the images of a result, which come in front of its JSON block as MCP
// image content. Their data is left out: the page would show a block of base64. The screenshots of
// the page are jpegs, which the fake app writes byte by byte in one shade of grey (its pngs, which
// zlib compresses and which are black, would make the size on the page depend on the zlib of Node),
// and a test checks that every screenshot of the scenarios asks for one.
function imageNote(types: readonly string[]): string[] {
  const [type, ...more] = types;
  if (type === undefined) {
    return [];
  }
  const images =
    more.length === 0
      ? `The image itself, of type ${type}, comes first, as MCP image content, and this page ` +
        'leaves it out'
      : `The ${String(types.length)} images themselves, of types ${types.join(', ')}, come ` +
        'first, as MCP image content, and this page leaves them out';
  return [
    `_${images}: the fake app answers a screenshot with a plain grey picture of the size the ` +
      'result gives._',
  ];
}

function renderStep(step: ScenarioStep, result: StepResult, first: boolean): string[] {
  const shown = shownResult(result);
  return [
    `**${first ? 'The assistant calls' : 'Then it calls'} \`${step.tool}\`**`,
    fenced('json', formatJson(step.arguments)),
    ...unfold(step.arguments),
    `**The server returns${result.ok ? '' : ' an error'}**`,
    ...(result.ok ? imageNote(result.images) : []),
    fenced('json', formatJson(shown.envelope)),
    ...unfold(shown.content),
  ];
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function renderScenario({ scenario, results }: ScenarioRun, number: number): string[] {
  if (results.length !== scenario.steps.length) {
    throw new Error(
      `The run of "${scenario.title}" has ${plural(scenario.steps.length, 'step')} and ` +
        plural(results.length, 'result'),
    );
  }
  return [
    `## ${String(number)}. ${scenario.title}`,
    '**You type**',
    quote(scenario.prompt),
    ...scenario.steps.flatMap((step, index) => {
      const result = results[index];
      return result === undefined ? [] : renderStep(step, result, index === 0);
    }),
    '**The assistant answers**',
    quote(scenario.summary),
  ];
}

const INTRODUCTION = [
  '# Usage examples',
  'Each section below is a request that you can type to an AI assistant that has this server ' +
    'connected: the prompt, the tool calls that the assistant makes for it, what the server ' +
    'returns, and what the assistant can tell you from that. [The README](../README.md) shows how ' +
    'to connect a client.',
  '> **All values on this page are synthetic.** The results come from running the real server ' +
    'against the fake TradingView app of the test suite, which serves a made-up NASDAQ:AAPL chart: ' +
    'prices from a seeded random walk, one bar for every calendar day (weekends included), an ' +
    'invented layout, invented drawings, alerts, watchlists and scripts, an invented strategy ' +
    'report, and a plain grey picture for a screenshot. Indicator values follow the closing ' +
    'prices instead of being calculated by the indicators. Nothing here is market ' +
    'data, and nothing comes from a real account. The shape of every result, with its field ' +
    'names, error codes and hints, is what the server returns, with one caveat: what the ' +
    'Strategy Tester holds for a strategy has not been read from the real app yet, so the shape ' +
    'of its report, behind the backtest results below, follows the reverse-engineering notes ' +
    'rather than an observed report.',
  'Every result is the envelope of the server: `ok`, then `data` or `error`, then `meta`. ' +
    '`meta.durationMs` is left out, because it differs on every run, which leaves the `meta` of ' +
    'an error empty, and a list longer than three items is cut to its first three followed by a ' +
    'marker such as `"… 1 more"`. Text with line breaks, such as a script or a diff, is laid out ' +
    'again as lines below its block, and an image that comes in front of the envelope, such as a ' +
    'screenshot, is named in a note instead of shown. Two times that the server takes from the ' +
    'clock are fixed as well, as if the call had been made at the time of the last bar of the ' +
    'chart: the time of a compilation, and the expiration of an alert set without one.',
  'This page is generated by `pnpm docs:examples` from the scenarios in ' +
    '`packages/server/scripts/docs/scenarios.ts`, and a test fails when it is out of date. Do not ' +
    'edit it by hand.',
];

// The page, as markdown with a single line break at the end.
export function renderExamples(runs: readonly ScenarioRun[]): string {
  const blocks = [...INTRODUCTION, ...runs.flatMap((run, index) => renderScenario(run, index + 1))];
  return `${blocks.join('\n\n')}\n`;
}

async function main(): Promise<void> {
  const runs = await runScenarios();
  writeFileSync(EXAMPLES_PATH, renderExamples(runs));
  process.stdout.write(`Wrote ${EXAMPLES_PATH} (${String(runs.length)} scenarios)\n`);
}

if (isEntryPoint(import.meta.url)) {
  runScript(main);
}

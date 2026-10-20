import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
import { SCENARIOS, type Scenario, type ScenarioStep } from './scenarios.js';

// Generates docs/examples.md (`pnpm docs:examples`): every scenario of scenarios.ts runs against the
// fake TradingView app of the test suite, through the real server and an MCP client, and the
// prompts, tool calls, results and summaries are written as markdown. The results are what the
// server returns, so the page shows the real field names, errors and hints, with synthetic values.
//
// The page has to come out the same on every run, machine and time zone, because a test compares it
// with the committed file. Nothing here reads the clock, the time zone or the locale: the fake app
// answers from its fixture, the one value of a result that comes from the clock (the time of a
// compilation, which the server stamps) is pinned below, and the duration of a call is left out.

export const EXAMPLES_PATH = fileURLToPath(
  new URL('../../../../docs/examples.md', import.meta.url),
);

// The longest list a result shows before the rest is counted, and the width JSON is laid out in.
const MAX_ITEMS = 3;
const WIDTH = 100;

// As in the integration tests of the tools.
const CALL_TIMEOUT_MS = 5000;

// What the assistant gets back from a tool, without the duration, which differs on every run.
export type StepResult =
  | { ok: true; via: string | null; warnings: string[]; data: JsonValue }
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

// The result of a step if it ended as the scenario says it must: a success, or the error code that
// the step expects. Anything else is a scenario that no longer describes the tools, which stops the
// generator instead of reaching the page.
function toStepResult(
  label: string,
  step: ScenarioStep,
  envelope: Envelope,
  compileTime: number,
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
      data: pinCompileTime(envelope.data, compileTime),
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
  compileTime: number,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const label = `Scenario "${scenario.title}", step ${String(index + 1)} (${step.tool})`;
    const called = await callTool(client, step.tool, step.arguments);
    const envelope = envelopeSchema.safeParse(called.structuredContent);
    if (!envelope.success) {
      throw new Error(`${label} returned no result envelope: ${z.prettifyError(envelope.error)}`);
    }
    results.push(toStepResult(label, step, envelope.data, compileTime));
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
  // The time of the last bar of the chart, which is also the time of its last quote.
  const compileTime = bars.startTime + (bars.count - 1) * bars.stepSeconds;
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

    return { scenario, results: await runSteps(client, scenario, compileTime) };
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

function renderStep(step: ScenarioStep, result: StepResult, first: boolean): string[] {
  const shown = shownResult(result);
  return [
    `**${first ? 'The assistant calls' : 'Then it calls'} \`${step.tool}\`**`,
    fenced('json', formatJson(step.arguments)),
    ...unfold(step.arguments),
    `**The server returns${result.ok ? '' : ' an error'}**`,
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
    'invented layout, invented scripts and an invented strategy report. Indicator values follow ' +
    'the closing prices instead of being calculated by the indicators. Nothing here is market ' +
    'data, and nothing comes from a real account. The shape of every result, with its field ' +
    'names, error codes and hints, is what the server returns, with one caveat: what the ' +
    'Strategy Tester holds for a strategy has not been read from the real app yet, so the shape ' +
    'of its report, behind the backtest results below, follows the reverse-engineering notes ' +
    'rather than an observed report.',
  'Every result is the envelope of the server: `ok`, then `data` or `error`, then `meta`. ' +
    '`meta.durationMs` is left out, because it differs on every run, which leaves the `meta` of ' +
    'an error empty, and a list longer than three items is cut to its first three followed by a ' +
    'marker such as `"… 1 more"`. Text with line breaks, such as a script or a diff, is laid out ' +
    'again as lines below its block. The time of a compilation is fixed as well, because the ' +
    'server stamps it from the clock.',
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

// Whether this module is the script that node was started with (`pnpm docs:examples`) and not a
// module that a test imports. Both paths are resolved, so a link in the path does not keep the
// script from running.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runScript(main);
}

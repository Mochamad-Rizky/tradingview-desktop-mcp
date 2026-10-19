import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChartState } from '../../src/tools/chart/page.js';
import { CHART_TYPE_NAMES_BY_ID } from '../../src/tools/chart/mappers.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';
import { findLeaks, scrubFixture, scrubTargets, toStateFixture } from './scrub.js';
import { connectToApp, readOptions, runScript } from './session.js';

// Records the state of the running TradingView Desktop as fixtures for the fake app (design spec
// 10): the chart state through the chart tools' own page function, the bars, symbol info, studies
// and drawings through the read-only function below, and the target list of the debug port. Both
// are scrubbed before anything is written (see scrub.ts): no personal data, the identity of
// NASDAQ:AAPL, and synthetic prices. A last check refuses to write a file in which any of the
// recorded identifying texts survived.
//
// It only reads, like the probe: the same getters, plus getStudyById and metaInfo of a study to
// learn the ids of its plots.

const USAGE = `Usage: pnpm re:record [--out DIR] [--name NAME] [--force] [--host 127.0.0.1] [--port 9222]

  --out DIR    where to write: DIR/tv/NAME.json and DIR/cdp/targets.<platform>-<version>.json
               (default: the package's test/fixtures)
  --name NAME  name of the chart fixture (default: chart-recorded)
  --force      replace files that exist already
`;

const DEFAULT_OUT = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

// What the chart tab holds beyond the chart state: every loaded bar as a row, the symbol info, the
// interval list, the build, and each study with the ids of its plots and each drawing with its type.
// Of a drawing only the id and the type are read, never its text or points.
export function readRecording(win: TvWindow): {
  buildTime: string | null;
  intervals: JsonValue;
  symbolInfo: JsonValue;
  bars: number[][];
  studies: { id: string; name: string; plots: string[] }[];
  shapes: { id: string; name: string }[];
} {
  const member = (owner: unknown, name: string): unknown => {
    try {
      return (typeof owner === 'object' && owner !== null) || typeof owner === 'function'
        ? (owner as Record<string, unknown>)[name]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (owner: unknown, name: string, ...args: unknown[]): unknown => {
    const fn = member(owner, name);
    if (typeof fn !== 'function') {
      return undefined;
    }
    try {
      return (fn as (...values: unknown[]) => unknown).apply(owner, args);
    } catch {
      return undefined;
    }
  };
  // A copy that JSON can carry: functions and undefined values drop out.
  const json = (value: unknown): JsonValue => {
    try {
      // JSON.stringify answers undefined for a function, which its type does not say.
      const stringify = JSON.stringify as (input: unknown) => string | undefined;
      const text = stringify(value);
      return text === undefined ? null : (JSON.parse(text) as JsonValue);
    } catch {
      return null;
    }
  };
  const api = member(win, 'TradingViewApi');
  const chart = call(api, 'activeChart');
  const model = call(member(chart, '_chartWidget'), 'model');
  const series = call(model, 'mainSeries');
  const core = call(model, 'model');
  const loaded = call(series, 'bars');
  const first = call(loaded, 'firstIndex');
  const last = call(loaded, 'lastIndex');
  const bars: number[][] = [];
  if (typeof first === 'number' && typeof last === 'number') {
    for (let index = first; index <= last; index += 1) {
      const row = call(loaded, 'valueAt', index);
      if (Array.isArray(row)) {
        const cells = row.filter((cell): cell is number => typeof cell === 'number');
        if (cells.length === row.length) {
          bars.push(cells.slice(0, 6));
        }
      }
    }
  }
  const studies = call(chart, 'getAllStudies');
  const shapes = call(chart, 'getAllShapes');
  const buildTime = member(win, 'BUILD_TIME');
  return {
    buildTime: typeof buildTime === 'string' ? buildTime : null,
    intervals: json(call(api, 'getIntervals')),
    symbolInfo: json(call(series, 'symbolInfo')),
    bars,
    studies: Array.isArray(studies)
      ? studies.map((study: unknown) => {
          const id = String(member(study, 'id'));
          const plots = member(call(call(core, 'getStudyById', id), 'metaInfo'), 'plots');
          return {
            id,
            name: String(member(study, 'name')),
            plots: Array.isArray(plots)
              ? plots
                  .map((plot: unknown) => member(plot, 'id'))
                  .filter((plotId): plotId is string => typeof plotId === 'string')
              : [],
          };
        })
      : [],
    shapes: Array.isArray(shapes)
      ? shapes.map((shape: unknown) => ({
          id: String(member(shape, 'id')),
          name: String(member(shape, 'name')),
        }))
      : [],
  };
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

// The texts of a recording that identify the user or the recorded symbol, the layout ids in the
// addresses of chart tabs among them. None of them may be in a file that is written.
function identifyingTexts(chart: JsonObject, info: JsonValue, urls: readonly string[]): string[] {
  const layout = chart.layout;
  const needles = [text(chart.symbol)];
  for (const url of urls) {
    const id = /tradingview\.com\/chart\/([^/?#]+)/.exec(url)?.[1];
    if (id !== undefined) {
      needles.push(id);
    }
  }
  if (typeof layout === 'object' && layout !== null && !Array.isArray(layout)) {
    needles.push(text(layout.name), text(layout.id));
  }
  if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    for (const key of [
      'name',
      'full_name',
      'pro_name',
      'description',
      'short_description',
      'isin',
    ]) {
      needles.push(text(info[key]));
    }
  }
  // The fixture names NASDAQ:AAPL and Apple whatever was recorded, so recording AAPL itself is
  // not a leak.
  const fixtureTexts = ['AAPL', 'NASDAQ:AAPL', 'Apple Inc.', 'US0378331005'];
  return needles.filter((needle) => needle !== '' && !fixtureTexts.includes(needle));
}

// A file for the fixtures, refused when it exists unless --force was given, so that a recording
// never replaces a committed fixture by accident.
function writeJson(path: string, value: unknown, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new Error(
      `${path} exists already. Pass --force to replace it, or choose --name or --out.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// macos-3.4.1 for TradingView Desktop 3.4.1 on macOS, as the committed target list is named.
function targetsFileName(userAgent: string): string {
  const version = /TradingView\/([\d.]+)/.exec(userAgent)?.[1] ?? 'unknown';
  const platform =
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : process.platform;
  return `targets.${platform}-${version}.json`;
}

async function main(): Promise<void> {
  const { config, flags } = readOptions(process.argv.slice(2), {
    out: { type: 'string' },
    name: { type: 'string', default: 'chart-recorded' },
    force: { type: 'boolean', default: false },
  });
  if (flags.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const out = resolve(typeof flags.out === 'string' ? flags.out : DEFAULT_OUT);
  const name = typeof flags.name === 'string' ? flags.name : 'chart-recorded';
  if (!/^[\w.-]+$/.test(name)) {
    throw new Error(
      `The fixture name may hold letters, digits, dots, dashes and underscores only: ${name}`,
    );
  }
  const force = flags.force === true;

  const app = connectToApp(config);
  try {
    const version = await app.discovery.version();
    const page = await app.connection.chartPage();
    const chart = await page.bridge.evaluate(readChartState, [null, { ...CHART_TYPE_NAMES_BY_ID }]);
    const extra = await page.bridge.evaluate(readRecording, []);
    const targets = await app.connection.targets();

    const raw: JsonObject = {
      buildTime: extra.buildTime ?? '',
      symbol: chart.symbol,
      resolution: chart.resolution,
      chartType: chart.chartType,
      visibleRange: chart.visibleRange,
      studies: extra.studies,
      shapes: extra.shapes,
      layout: {
        type: chart.layout.type,
        chartsCount: chart.layout.chartsCount,
        name: chart.layout.name,
        id: chart.layout.id,
      },
      intervals: extra.intervals,
      symbolInfo: extra.symbolInfo,
      bars: extra.bars,
    };
    const fixture = toStateFixture(scrubFixture(raw));
    const scrubbedTargets = scrubTargets(targets.map((target) => ({ ...target })));

    const needles = identifyingTexts(
      raw,
      extra.symbolInfo,
      targets.map((target) => target.url),
    );
    const leaks = [
      ...findLeaks(fixture as unknown as JsonValue, needles),
      ...findLeaks(scrubbedTargets, needles),
    ];
    if (leaks.length > 0) {
      // The texts themselves are not printed: they are what must not leak.
      throw new Error(
        `Refusing to write: ${String(leaks.length)} identifying text(s) survived the scrubber. ` +
          'Extend scrub.ts to cover them.',
      );
    }

    const chartPath = join(out, 'tv', `${name}.json`);
    const targetsPath = join(out, 'cdp', targetsFileName(version.userAgent));
    writeJson(chartPath, fixture, force);
    writeJson(targetsPath, scrubbedTargets, force);
    process.stdout.write(
      `Wrote ${chartPath} (${String(fixture.bars.count)} synthetic bars, ${String(fixture.studies.length)} studies, ` +
        `${String(fixture.shapes.length)} drawings, ${String(Object.keys(fixture.symbolInfo).length)} symbol info fields)\n` +
        `Wrote ${targetsPath} (${String(scrubbedTargets.length)} targets)\n`,
    );
  } finally {
    await app.close();
  }
}

runScript(main);

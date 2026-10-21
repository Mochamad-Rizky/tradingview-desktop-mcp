import { z } from 'zod';
import { READ_ONLY } from '../../../../src/tools/annotations.js';
import { allTools } from '../../../../src/tools/index.js';
import { selectTools } from '../../../../src/tools/registry.js';
import { screenshotCapture, screenshotTools } from '../../../../src/tools/screenshot/index.js';
import { strategyTools } from '../../../../src/tools/strategy/index.js';

// What the model and the client see of the screenshot tool: its name, annotations and input schema.
// The behavior behind them is tested through a server in test/integration/tools/screenshot.test.ts.

const schema = z.object(screenshotCapture.inputSchema);

test('screenshotTools lists screenshot_capture, the one tool of the domain', () => {
  expect(screenshotTools).toEqual([screenshotCapture]);
  expect(screenshotCapture.name).toBe('screenshot_capture');
  expect(screenshotCapture.domain).toBe('screenshot');
});

test('the catalog lists the screenshot tool after the strategy tools and before the batch', () => {
  const names = allTools.map(({ name }) => name);
  const lastStrategy = strategyTools.at(-1);
  if (lastStrategy === undefined) {
    throw new Error('There are no strategy tools');
  }

  expect(names.indexOf('screenshot_capture')).toBeGreaterThan(names.indexOf(lastStrategy.name));
  expect(names.indexOf('screenshot_capture')).toBeLessThan(names.indexOf('batch_run'));
});

test('screenshot_capture only reads, so the readonly profile offers it', () => {
  expect(screenshotCapture.annotations).toBe(READ_ONLY);
  expect(screenshotCapture.annotations).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  expect(
    selectTools(allTools, { profile: 'readonly', patterns: [] }).map(({ name }) => name),
  ).toContain('screenshot_capture');
});

test('screenshot_capture is left out of the core profile until the core set is chosen', () => {
  expect(screenshotCapture.core).toBeUndefined();
  expect(
    selectTools(allTools, { profile: 'core', patterns: [] }).map(({ name }) => name),
  ).not.toContain('screenshot_capture');
});

test('screenshot_capture takes the chart as a png by default, whole and at full size', () => {
  expect(schema.parse({})).toEqual({ target: 'chart', format: 'png' });
  expect(schema.parse({ target: 'window', format: 'jpeg', maxWidth: 800, chartIndex: 1 })).toEqual({
    target: 'window',
    format: 'jpeg',
    maxWidth: 800,
    chartIndex: 1,
  });
});

test.each([
  ['a target that is none of the three', { target: 'screen' }],
  ['a format that is neither png nor jpeg', { format: 'webp' }],
  ['a format in capitals', { format: 'PNG' }],
  ['a maxWidth under 100', { maxWidth: 99 }],
  ['a maxWidth over 4000', { maxWidth: 4001 }],
  ['a maxWidth that is not whole', { maxWidth: 800.5 }],
  ['a maxWidth that is a string', { maxWidth: '800' }],
  ['a negative chartIndex', { chartIndex: -1 }],
  ['a chartIndex that is not whole', { chartIndex: 0.5 }],
])('screenshot_capture refuses %s', (_case, input) => {
  expect(schema.safeParse(input).success).toBe(false);
});

test.each([[100], [800], [4000]])('screenshot_capture takes a maxWidth of %i', (maxWidth) => {
  expect(schema.parse({ maxWidth })).toMatchObject({ maxWidth });
});

test('the description says what each target captures and what the result holds', () => {
  const { description } = screenshotCapture;

  expect(description).toMatch(/changes nothing/);
  for (const word of ['chart', 'page', 'window', 'png', 'jpeg', 'maxWidth', 'chartIndex']) {
    expect(description, word).toContain(word);
  }
  expect(description).toMatch(/image/);
  expect(description).toMatch(/width, height and bytes|width and height/);
  expect(description).toMatch(/NOT_AVAILABLE/);
});

import {
  formatJson,
  pinnedExpiration,
  renderExamples,
  trimArrays,
  type ScenarioRun,
  type StepResult,
} from '../../../scripts/docs/examples.js';
import type { JsonValue } from '../../../src/utils/json.js';

// The pieces that turn the results of the scenarios into the page docs/examples.md: trimming long
// lists, laying JSON out, and the markdown around it. Everything here is made up.

describe('trimArrays', () => {
  test('trimArrays keeps the first three items of a longer list and says how many it left out', () => {
    expect(trimArrays([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, '… 3 more']);
    expect(trimArrays(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', '… 1 more']);
  });

  test('trimArrays leaves a list of three items or fewer as it is', () => {
    expect(trimArrays([])).toEqual([]);
    expect(trimArrays([1])).toEqual([1]);
    expect(trimArrays([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('trimArrays cuts the lists inside objects and inside the kept items', () => {
    const value: JsonValue = {
      bars: [{ tags: [1, 2, 3, 4] }, { tags: [] }, { tags: [5] }, { tags: [6] }],
      note: 'text',
      count: 4,
      empty: null,
    };

    expect(trimArrays(value)).toEqual({
      bars: [{ tags: [1, 2, 3, '… 1 more'] }, { tags: [] }, { tags: [5] }, '… 1 more'],
      note: 'text',
      count: 4,
      empty: null,
    });
  });

  test('trimArrays does not change the value it is given', () => {
    const value: JsonValue = { list: [1, 2, 3, 4] };

    trimArrays(value);

    expect(value).toEqual({ list: [1, 2, 3, 4] });
  });
});

describe('pinnedExpiration', () => {
  const DAY = 86_400;

  test('pinnedExpiration moves an expiration whole days after a call to as many days after the time of the page', () => {
    // The server read its clock 2 s after the generator did, and set 30 days from then.
    expect(pinnedExpiration(1_000 + 2 + 30 * DAY, 1_000, 50_000)).toBe(50_000 + 30 * DAY);
    expect(pinnedExpiration(1_000 + 7 * DAY, 1_000, 50_000)).toBe(50_000 + 7 * DAY);
  });

  test('pinnedExpiration refuses an expiration that is not whole days after the call', () => {
    expect(() => pinnedExpiration(1_000 + 30 * DAY + 3_600, 1_000, 50_000)).toThrow(
      /not a whole number of days after the call/,
    );
    expect(() => pinnedExpiration(1_000 - 5, 1_000, 50_000)).toThrow(
      /not a whole number of days after the call/,
    );
  });
});

describe('formatJson', () => {
  test('formatJson writes values that fit on a line on one line', () => {
    expect(formatJson({ a: 1, b: [1, 2], c: { d: null } })).toBe(
      '{ "a": 1, "b": [1, 2], "c": { "d": null } }',
    );
    expect(formatJson([])).toBe('[]');
    expect(formatJson({})).toBe('{}');
    expect(formatJson('text')).toBe('"text"');
    expect(formatJson(null)).toBe('null');
  });

  test('formatJson breaks an object that is wider than 100 columns, two spaces a level', () => {
    const wide = { name: 'x'.repeat(60), other: 'y'.repeat(60) };

    expect(formatJson(wide)).toBe(
      `{\n  "name": "${'x'.repeat(60)}",\n  "other": "${'y'.repeat(60)}"\n}`,
    );
  });

  test('formatJson counts exactly 100 columns as fitting', () => {
    // { "k": "…" } is 11 characters around the text.
    expect(formatJson({ k: 'a'.repeat(89) })).toBe(`{ "k": "${'a'.repeat(89)}" }`);
    expect(formatJson({ k: 'a'.repeat(90) })).toBe(`{\n  "k": "${'a'.repeat(90)}"\n}`);
  });

  test('formatJson counts the indent, the key and the comma of a member when it decides', () => {
    // The line of the first member is `  "first": { "id": "…" },`: 24 columns around the text.
    expect(formatJson({ first: { id: 'a'.repeat(76) }, last: 1 })).toBe(
      `{\n  "first": { "id": "${'a'.repeat(76)}" },\n  "last": 1\n}`,
    );
    expect(formatJson({ first: { id: 'a'.repeat(77) }, last: 1 })).toBe(
      `{\n  "first": {\n    "id": "${'a'.repeat(77)}"\n  },\n  "last": 1\n}`,
    );
  });

  test('formatJson gives the last member the column that a comma would have taken', () => {
    // `  "last": { "id": "…" }` is 22 columns around the text, with no comma after it.
    expect(formatJson({ first: 1, last: { id: 'a'.repeat(78) } })).toBe(
      `{\n  "first": 1,\n  "last": { "id": "${'a'.repeat(78)}" }\n}`,
    );
    expect(formatJson({ first: 1, last: { id: 'a'.repeat(79) } })).toBe(
      `{\n  "first": 1,\n  "last": {\n    "id": "${'a'.repeat(79)}"\n  }\n}`,
    );
  });

  test('formatJson puts each item of a list that does not fit on a line of its own', () => {
    const items = [{ id: 'a'.repeat(40) }, { id: 'b'.repeat(40) }];

    expect(formatJson(items)).toBe(
      `[\n  { "id": "${'a'.repeat(40)}" },\n  { "id": "${'b'.repeat(40)}" }\n]`,
    );
  });

  test('formatJson escapes like JSON does, so a line break never breaks a line', () => {
    expect(formatJson({ text: 'a "quote"\nand a line break … done' })).toBe(
      '{ "text": "a \\"quote\\"\\nand a line break … done" }',
    );
  });

  test('formatJson writes something JSON.parse reads back as the same value', () => {
    const value: JsonValue = {
      list: [{ id: 'a'.repeat(50), n: 1.5 }, { id: 'b', n: -2 }, [], {}, null, true],
      deep: { deeper: { deepest: ['x'.repeat(95)] } },
    };

    expect(JSON.parse(formatJson(value))).toEqual(value);
  });
});

describe('renderExamples', () => {
  const stateResult: StepResult = {
    ok: true,
    via: 'api',
    warnings: [],
    images: [],
    data: { symbol: 'NASDAQ:AAPL', resolution: '1D' },
  };
  const first: ScenarioRun = {
    scenario: {
      title: 'Read the chart',
      prompt: 'What is on my chart?',
      steps: [{ tool: 'chart_get_state', arguments: {} }],
      summary: 'It is NASDAQ:AAPL.',
    },
    results: [stateResult],
  };
  const second: ScenarioRun = {
    scenario: {
      title: 'Add an indicator',
      prompt: 'Add the MACD.\nAnd tell me when it is done.',
      steps: [
        { tool: 'indicator_search', arguments: { query: 'macd' } },
        { tool: 'indicator_add', arguments: { name: 'STD;MACD' }, expectError: 'PLAN_LIMIT' },
      ],
      summary: 'The chart is full.\n\nNothing was added.',
    },
    results: [
      {
        ok: true,
        via: 'internal',
        warnings: ['careful'],
        images: [],
        data: { results: [{ id: 'STD;MACD' }] },
      },
      { ok: false, error: { code: 'PLAN_LIMIT', message: 'The chart is full', details: {} } },
    ],
  };

  // The fenced blocks of a page, in order, as [info string, text].
  function blocksOf(page: string): [string, string][] {
    return [...page.matchAll(/^(`{3,})(\w*)\n([\s\S]*?)\n\1$/gm)].map((match): [string, string] => [
      match[2] ?? '',
      match[3] ?? '',
    ]);
  }

  // The text of the block at an index, parsed as JSON.
  function jsonAt(page: string, index: number): unknown {
    return JSON.parse(blocksOf(page)[index]?.[1] ?? 'no such block');
  }

  test('renderExamples starts with a title and says that the values are synthetic', () => {
    const page = renderExamples([first]);

    expect(page.startsWith('# Usage examples\n')).toBe(true);
    expect(page).toMatch(/synthetic/i);
    expect(page).toMatch(/pnpm docs:examples/);
  });

  test('renderExamples writes one numbered section for each scenario, in order', () => {
    const page = renderExamples([first, second]);

    expect(page.match(/^## .*$/gm)).toEqual(['## 1. Read the chart', '## 2. Add an indicator']);
  });

  test('renderExamples quotes the prompt and the summary, line by line', () => {
    const page = renderExamples([first, second]);

    expect(page).toContain('> What is on my chart?\n');
    expect(page).toContain('> Add the MACD.\n> And tell me when it is done.\n');
    expect(page).toContain('> It is NASDAQ:AAPL.\n');
    expect(page).toContain('> The chart is full.\n>\n> Nothing was added.\n');
  });

  test('renderExamples shows each tool call and its result as JSON, in the order of the steps', () => {
    const page = renderExamples([second]);

    expect(blocksOf(page).map(([language]) => language)).toEqual(['json', 'json', 'json', 'json']);
    expect([0, 1, 2, 3].map((index) => jsonAt(page, index))).toEqual([
      { query: 'macd' },
      {
        ok: true,
        data: { results: [{ id: 'STD;MACD' }] },
        meta: { via: 'internal', warnings: ['careful'] },
      },
      { name: 'STD;MACD' },
      // The meta of an error holds only the duration, which the page leaves out.
      {
        ok: false,
        error: { code: 'PLAN_LIMIT', message: 'The chart is full', details: {} },
        meta: {},
      },
    ]);
  });

  test('renderExamples leaves via out of meta for a result that has none', () => {
    const run: ScenarioRun = {
      ...first,
      results: [{ ok: true, via: null, warnings: ['w'], images: [], data: {} }],
    };

    expect(jsonAt(renderExamples([run]), 1)).toEqual({
      ok: true,
      data: {},
      meta: { warnings: ['w'] },
    });
  });

  test('renderExamples names the tool of each call and says when a result is an error', () => {
    const page = renderExamples([second]);

    expect(page).toContain('**The assistant calls `indicator_search`**');
    expect(page).toContain('**Then it calls `indicator_add`**');
    expect(page).toContain('**The server returns an error**');
    expect(page.match(/\*\*The server returns\*\*/g)).toHaveLength(1);
  });

  test('renderExamples says which times that the server takes from the clock it fixes', () => {
    const page = renderExamples([first]);

    expect(page).toMatch(/Two times that the server takes from the clock are fixed as well/);
    expect(page).toMatch(
      /the time of a compilation, and the expiration of an alert set without one/,
    );
    expect(page).not.toMatch(/fake app takes it from the clock/);
  });

  test('renderExamples names the images of a result in a note above its JSON block, and shows none of their data', () => {
    const run: ScenarioRun = {
      ...first,
      results: [{ ok: true, via: 'cdp', warnings: [], images: ['image/jpeg'], data: { width: 8 } }],
    };
    const two: ScenarioRun = {
      ...first,
      results: [
        {
          ok: true,
          via: 'cdp',
          warnings: [],
          images: ['image/jpeg', 'image/jpeg'],
          data: { width: 8 },
        },
      ],
    };

    const page = renderExamples([run]);

    expect(page).toContain(
      '**The server returns**\n\n_The image itself, of type image/jpeg, comes first, as MCP image ' +
        'content, and this page leaves it out: the fake app answers a screenshot with a plain ' +
        'grey picture of the size the result gives._\n\n```json\n',
    );
    expect(jsonAt(page, 1)).toEqual({
      ok: true,
      data: { width: 8 },
      meta: { via: 'cdp', warnings: [] },
    });
    expect(renderExamples([two])).toContain(
      '_The 2 images themselves, of types image/jpeg, image/jpeg, come first, as MCP image ' +
        'content, and this page leaves them out:',
    );
    // A result without an image has no note, and the page says why a note can stand in for one.
    expect(renderExamples([first])).not.toMatch(/^_The image/m);
    expect(renderExamples([first])).toMatch(/named in a note instead of shown/);
  });

  test('renderExamples says that the strategy report has not been seen on the real app', () => {
    const page = renderExamples([first]);

    expect(page).toMatch(/Strategy Tester[^.]*has not been read from the real app/);
  });

  test('renderExamples says that the duration is left out of the results', () => {
    const page = renderExamples([first, second]);

    expect(page).toContain('`meta.durationMs` is left out');
    expect(blocksOf(page).some(([, text]) => text.includes('durationMs'))).toBe(false);
  });

  test('renderExamples cuts long lists in results to three items and counts the rest', () => {
    const run: ScenarioRun = {
      ...first,
      results: [
        { ok: true, via: 'api', warnings: [], images: [], data: { list: [1, 2, 3, 4, 5, 6, 7] } },
      ],
    };

    expect(jsonAt(renderExamples([run]), 1)).toEqual({
      ok: true,
      data: { list: [1, 2, 3, '… 4 more'] },
      meta: { via: 'api', warnings: [] },
    });
  });

  test('renderExamples leaves the arguments of a call whole, however long a list in them is', () => {
    const run: ScenarioRun = {
      ...first,
      scenario: { ...first.scenario, steps: [{ tool: 'x_y', arguments: { ids: [1, 2, 3, 4] } }] },
    };

    expect(jsonAt(renderExamples([run]), 0)).toEqual({ ids: [1, 2, 3, 4] });
  });

  test('renderExamples lays out text with line breaks again below its block', () => {
    const run: ScenarioRun = {
      scenario: {
        ...first.scenario,
        steps: [{ tool: 'pine_x', arguments: { source: '//@version=6\nplot(close)\n' } }],
      },
      results: [
        {
          ok: true,
          via: 'internal',
          warnings: [],
          images: [],
          data: { diff: ' a\n-b\n+c\n', note: 'one' },
        },
      ],
    };

    const page = renderExamples([run]);

    expect(page).toContain('`source`:\n\n```pine\n//@version=6\nplot(close)\n```\n');
    expect(page).toContain('`diff`:\n\n```diff\n a\n-b\n+c\n```\n');
    expect(page).not.toContain('`note`:');
  });

  test('renderExamples fences text that holds backticks with more backticks', () => {
    const run: ScenarioRun = {
      ...first,
      results: [{ ok: true, via: 'api', warnings: [], images: [], data: { text: 'a\n```\nb' } }],
    };

    const page = renderExamples([run]);

    expect(page).toContain('`text`:\n\n````\na\n```\nb\n````\n');
    // The line of the JSON block that holds the three backticks does not close its fence.
    expect(jsonAt(page, 1)).toEqual({
      ok: true,
      data: { text: 'a\n```\nb' },
      meta: { via: 'api', warnings: [] },
    });
  });

  test('renderExamples gives the same page for the same results, ending with one line break', () => {
    const page = renderExamples([first, second]);

    expect(renderExamples([first, second])).toBe(page);
    expect(page.endsWith('\n')).toBe(true);
    expect(page.endsWith('\n\n')).toBe(false);
    expect(page).not.toContain('\r');
  });

  test('renderExamples fails for a run whose results do not match its steps', () => {
    const broken: ScenarioRun = { scenario: second.scenario, results: [stateResult] };

    expect(() => renderExamples([broken])).toThrow(/Add an indicator.*2 steps.*1 result/s);
  });
});

import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { toErrorResult, toSuccessResult } from '../../../src/core/result.js';

// Clients that ignore structuredContent still get the same envelope from the first text block.
function parseTextBlock(result: CallToolResult): unknown {
  const block = result.content.find((c) => c.type === 'text');
  if (block?.type !== 'text') {
    throw new Error('result has no text block');
  }
  const parsed: unknown = JSON.parse(block.text);
  return parsed;
}

test('toSuccessResult mirrors the payload in text and structuredContent', () => {
  const r = toSuccessResult({ a: 1 }, { via: 'api', durationMs: 5 });
  expect(r.structuredContent).toEqual({
    ok: true,
    data: { a: 1 },
    meta: { via: 'api', durationMs: 5 },
  });
  expect(parseTextBlock(r)).toEqual(r.structuredContent);
});

test('toSuccessResult carries only the meta fields it was given', () => {
  expect(toSuccessResult(null, { durationMs: 7 }).structuredContent).toStrictEqual({
    ok: true,
    data: null,
    meta: { durationMs: 7 },
  });
});

test('toSuccessResult keeps warnings in meta', () => {
  const r = toSuccessResult([], {
    via: 'dom',
    durationMs: 9,
    warnings: ['indicator list truncated'],
  });

  expect(r.structuredContent).toMatchObject({ meta: { warnings: ['indicator list truncated'] } });
});

test('toSuccessResult is not flagged as an error', () => {
  expect(toSuccessResult({}, { durationMs: 1 }).isError).not.toBe(true);
});

test('toSuccessResult puts image blocks in front of the JSON block', () => {
  const image: ImageContent = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

  const r = toSuccessResult({ saved: false }, { via: 'cdp', durationMs: 120 }, [image]);

  expect(r.content).toHaveLength(2);
  expect(r.content[0]).toEqual(image);
  expect(r.content[1]).toMatchObject({ type: 'text' });
  expect(parseTextBlock(r)).toEqual(r.structuredContent);
});

test('toErrorResult sets isError and the error code', () => {
  const r = toErrorResult({ code: 'TIMEOUT', message: 't' }, 3);
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
});

test('toErrorResult mirrors the full envelope in text and structuredContent', () => {
  const error = {
    code: 'PLAN_LIMIT',
    message: 'Plan allows 2 indicators',
    hint: 'Remove an indicator first',
    details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
  } as const;

  const r = toErrorResult(error, 8);

  expect(r.structuredContent).toEqual({
    ok: false,
    error: {
      code: 'PLAN_LIMIT',
      message: 'Plan allows 2 indicators',
      hint: 'Remove an indicator first',
      details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
    },
    meta: { durationMs: 8 },
  });
  expect(parseTextBlock(r)).toEqual(r.structuredContent);
});

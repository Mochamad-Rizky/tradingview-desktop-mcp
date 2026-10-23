import { errorResult, okResult } from '@/test/fixtures';
import { resultEnvelope } from './tool-result';

test('resultEnvelope reads the data of a call that succeeded and the error of one that failed', () => {
  expect(resultEnvelope(okResult({ limits: {} }))).toEqual({ ok: true, data: { limits: {} } });
  expect(
    resultEnvelope(
      errorResult({ code: 'PLAN_LIMIT', message: 'The plan allows 5', hint: 'Remove one.' }),
    ),
  ).toEqual({
    ok: false,
    error: { code: 'PLAN_LIMIT', message: 'The plan allows 5', hint: 'Remove one.' },
  });
  expect(resultEnvelope(errorResult({ code: 'INTERNAL', message: 'Something broke' }))).toEqual({
    ok: false,
    error: { code: 'INTERNAL', message: 'Something broke' },
  });
});

test('resultEnvelope gives null for an envelope it cannot read', () => {
  const content = [{ type: 'text' as const, text: '{}' }];
  expect(resultEnvelope({ content })).toBeNull();
  expect(resultEnvelope({ content, structuredContent: { ok: true } })).toBeNull();
  expect(resultEnvelope({ content, structuredContent: { ok: false, error: 'broken' } })).toBeNull();
  expect(
    resultEnvelope({ content, structuredContent: { ok: false, error: { code: 'INTERNAL' } } }),
  ).toBeNull();
  // A hint that is no text is left out.
  expect(
    resultEnvelope({
      content,
      structuredContent: { ok: false, error: { code: 'INTERNAL', message: 'Broke', hint: 3 } },
    }),
  ).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Broke' } });
});

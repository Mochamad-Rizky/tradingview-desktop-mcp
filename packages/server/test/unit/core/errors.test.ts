import {
  CapabilityError,
  PlanLimitError,
  TimeoutError,
  TvMcpError,
  isTvMcpError,
  toErrorPayload,
} from '../../../src/core/errors.js';

test('TvMcpError carries code, hint and details', () => {
  const e = new TvMcpError('TARGET_NOT_FOUND', 'No chart tab', {
    hint: 'Open a chart',
    details: { tabs: 0 },
  });
  expect(e.toPayload()).toEqual({
    code: 'TARGET_NOT_FOUND',
    message: 'No chart tab',
    hint: 'Open a chart',
    details: { tabs: 0 },
  });
});

test('TvMcpError payload omits hint and details when they were not provided', () => {
  // toStrictEqual tells a missing key apart from a key that holds undefined.
  expect(new TvMcpError('INTERNAL', 'oops').toPayload()).toStrictEqual({
    code: 'INTERNAL',
    message: 'oops',
  });
});

test('TvMcpError keeps the cause for logging but never exposes it in the payload', () => {
  const original = new Error('socket closed by peer');
  const e = new TvMcpError('CDP_UNREACHABLE', 'Cannot reach TradingView', { cause: original });

  expect(e.cause).toBe(original);
  expect(e.toPayload()).toStrictEqual({
    code: 'CDP_UNREACHABLE',
    message: 'Cannot reach TradingView',
  });
});

test('PlanLimitError exposes feature and limit', () => {
  expect(new PlanLimitError('INDICATORS_ON_CHART', 2).toPayload().details).toEqual({
    feature: 'INDICATORS_ON_CHART',
    limit: 2,
  });
});

test('PlanLimitError is PLAN_LIMIT and its default message names the feature and limit', () => {
  const payload = new PlanLimitError('INDICATORS_ON_CHART', 2).toPayload();

  expect(payload.code).toBe('PLAN_LIMIT');
  expect(payload.message).toContain('INDICATORS_ON_CHART');
  expect(payload.message).toContain('2');
});

test('PlanLimitError relays a server-provided message unchanged', () => {
  const e = new PlanLimitError('INDICATORS_ON_CHART', 2, 'You can only add 2 indicators');

  expect(e.message).toBe('You can only add 2 indicators');
});

test('PlanLimitError puts a given hint in the payload next to its details', () => {
  const e = new PlanLimitError(
    'INDICATORS_ON_CHART',
    2,
    'You can only add 2 indicators',
    'Remove an indicator before adding another',
  );

  expect(e.toPayload()).toStrictEqual({
    code: 'PLAN_LIMIT',
    message: 'You can only add 2 indicators',
    hint: 'Remove an indicator before adding another',
    details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
  });
});

test('PlanLimitError keeps its generated message when only a hint is given', () => {
  const payload = new PlanLimitError(
    'INDICATORS_ON_CHART',
    2,
    undefined,
    'Remove an indicator before adding another',
  ).toPayload();

  expect(payload.hint).toBe('Remove an indicator before adding another');
  expect(payload.message).toContain('INDICATORS_ON_CHART');
});

test('PlanLimitError payload has no hint key when none was given', () => {
  const withGeneratedMessage = new PlanLimitError('INDICATORS_ON_CHART', 2);
  const withGivenMessage = new PlanLimitError('INDICATORS_ON_CHART', 2, 'custom message');

  expect(withGeneratedMessage.toPayload()).not.toHaveProperty('hint');
  expect(withGivenMessage.toPayload()).not.toHaveProperty('hint');
});

test('TimeoutError reports TIMEOUT with the label and duration', () => {
  const e = new TimeoutError('Runtime.evaluate', 5000);

  expect(e.code).toBe('TIMEOUT');
  expect(e.details).toEqual({ label: 'Runtime.evaluate', ms: 5000 });
  expect(e.message).toContain('Runtime.evaluate');
  expect(e.message).toContain('5000');
});

test('CapabilityError stores the attempted strategies in details.attempts', () => {
  const e = new CapabilityError('No strategy could read the chart', ['api', 'internal', 'dom']);

  expect(e.toPayload()).toEqual({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'No strategy could read the chart',
    details: { attempts: ['api', 'internal', 'dom'] },
  });
});

test('CapabilityError without attempts has no details', () => {
  expect(new CapabilityError('Replay API is missing').toPayload()).toStrictEqual({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'Replay API is missing',
  });
});

test('isTvMcpError recognizes TvMcpError and its subclasses only', () => {
  expect(isTvMcpError(new TvMcpError('INTERNAL', 'x'))).toBe(true);
  expect(isTvMcpError(new PlanLimitError('F', 1))).toBe(true);
  expect(isTvMcpError(new TimeoutError('x', 1))).toBe(true);
  expect(isTvMcpError(new CapabilityError('x'))).toBe(true);

  expect(isTvMcpError(new Error('x'))).toBe(false);
  // A look-alike must not pass, because callers trust the payload of a real TvMcpError.
  expect(isTvMcpError({ code: 'TIMEOUT', message: 'x' })).toBe(false);
  expect(isTvMcpError('TIMEOUT')).toBe(false);
  expect(isTvMcpError(undefined)).toBe(false);
});

test('toErrorPayload passes TvMcpError payloads through unchanged', () => {
  const e = new PlanLimitError('INDICATORS_ON_CHART', 2, 'Plan allows 2 indicators');

  expect(toErrorPayload(e)).toEqual({
    code: 'PLAN_LIMIT',
    message: 'Plan allows 2 indicators',
    details: { feature: 'INDICATORS_ON_CHART', limit: 2 },
  });
});

test('toErrorPayload maps unknown errors to INTERNAL without leaking the stack', () => {
  const p = toErrorPayload(new Error('boom'));
  expect(p.code).toBe('INTERNAL');
  expect(JSON.stringify(p)).not.toContain('at ');
});

test('toErrorPayload hides the message of unexpected errors', () => {
  const p = toErrorPayload(new Error('ENOENT: no such file /Users/alice/.tv/session.json'));

  expect(p).toStrictEqual({ code: 'INTERNAL', message: 'Unexpected error' });
});

test.each([
  ['a string', 'boom'],
  ['undefined', undefined],
  ['null', null],
  ['a look-alike object', { code: 'TIMEOUT', message: 'spoofed' }],
])('toErrorPayload maps %s to INTERNAL', (_label, thrown) => {
  expect(toErrorPayload(thrown)).toStrictEqual({ code: 'INTERNAL', message: 'Unexpected error' });
});

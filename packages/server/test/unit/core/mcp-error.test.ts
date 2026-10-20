import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { PlanLimitError, TvMcpError } from '../../../src/core/errors.js';
import { toMcpError } from '../../../src/core/mcp-error.js';

// How a failure of a resource or a prompt reaches a client: a JSON-RPC error with the error payload
// of design spec 5.2 as its data.

test('toMcpError answers a mistake of the client with invalid params and its payload', () => {
  const error = toMcpError(
    new TvMcpError('INVALID_INPUT', 'The timeframe is blank', {
      hint: 'Give a timeframe such as 1D.',
      details: { timeframe: '' },
    }),
  );

  expect(error).toBeInstanceOf(McpError);
  expect(error.code).toBe(ErrorCode.InvalidParams);
  expect(error.data).toEqual({
    code: 'INVALID_INPUT',
    message: 'The timeframe is blank',
    hint: 'Give a timeframe such as 1D.',
    details: { timeframe: '' },
  });
});

test.each([
  new TvMcpError('NOT_AVAILABLE', 'The Pine Editor is not open'),
  new TvMcpError('TARGET_NOT_FOUND', 'No chart tab is open'),
  new PlanLimitError('INDICATORS_ON_CHART', 2),
])('toMcpError answers $code with an internal error that keeps the payload', (failure) => {
  const error = toMcpError(failure);

  expect(error.code).toBe(ErrorCode.InternalError);
  expect(error.data).toEqual(failure.toPayload());
});

test('toMcpError tells a client nothing of an unexpected error', () => {
  const error = toMcpError(new Error('ENOENT: /Users/someone/private/state.json'));

  expect(error.code).toBe(ErrorCode.InternalError);
  expect(error.data).toEqual({ code: 'INTERNAL', message: 'Unexpected error' });
  expect(error.message).not.toContain('private');
});

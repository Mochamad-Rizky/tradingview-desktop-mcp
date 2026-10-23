import type { DashboardCallResult } from '@contract';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/api/client';
import { fact } from '@/test/render';
import { errorResult, okResult } from '@/test/fixtures';
import { CallResult } from './call-result';

function result(): HTMLElement {
  return screen.getByRole('region', { name: 'Result' });
}

function json(): HTMLElement {
  return within(result()).getByRole('region', { name: 'Structured content' });
}

function jsonText(): string {
  return json().querySelector('pre')?.textContent ?? '';
}

// One pixel of PNG, as a screenshot tool sends an image.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('an OK result shows where it came from, how long it took, its warnings and its JSON', () => {
  const answer = okResult(
    { symbol: 'NASDAQ:AAPL', changed: true },
    { via: 'dom', durationMs: 1234, warnings: ['The chart took long to load.', 'Another note.'] },
  );
  const { rerender } = render(
    <CallResult tool="chart_set_symbol" pending={false} result={answer} error={null} />,
  );
  expect(within(result()).getByRole('status')).toHaveTextContent('OK');
  expect(fact(result(), 'Via')).toBe('dom');
  expect(fact(result(), 'Duration')).toBe('1,234 ms');
  const warnings = within(result()).getByRole('list', { name: 'Warnings' });
  expect(
    within(warnings)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['The chart took long to load.', 'Another note.']);
  expect(jsonText()).toBe(JSON.stringify(answer.structuredContent, null, 2));
  expect(within(result()).queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  expect(within(result()).queryByRole('img')).not.toBeInTheDocument();

  // Each fact shows when the meta states it.
  rerender(
    <CallResult
      tool="chart_set_symbol"
      pending={false}
      result={{ content: [], structuredContent: { ok: true, data: {}, meta: { via: 'api' } } }}
      error={null}
    />,
  );
  expect(fact(result(), 'Via')).toBe('api');
  expect(within(result()).queryByText('Duration', { selector: 'dt' })).not.toBeInTheDocument();
});

test('an error result shows its code, message and hint', () => {
  const answer = errorResult({
    code: 'INVALID_INPUT',
    message: 'TradingView does not know the symbol NASDAQ:NOPE',
    hint: 'Use EXCHANGE:SYMBOL, such as NASDAQ:AAPL.',
  });
  const { rerender } = render(
    <CallResult tool="chart_set_symbol" pending={false} result={answer} error={null} />,
  );
  expect(within(result()).getByRole('status')).toHaveTextContent('Error');
  const alert = within(result()).getByRole('alert');
  expect(within(alert).getByText('INVALID_INPUT').tagName).toBe('CODE');
  expect(alert).toHaveTextContent('TradingView does not know the symbol NASDAQ:NOPE');
  expect(alert).toHaveTextContent('Use EXCHANGE:SYMBOL, such as NASDAQ:AAPL.');
  // A failed call names no tier.
  expect(fact(result(), 'Duration')).toBe('7 ms');
  expect(within(result()).queryByText('Via', { selector: 'dt' })).not.toBeInTheDocument();
  expect(jsonText()).toContain('"code": "INVALID_INPUT"');

  // An error without a hint has its message alone.
  rerender(
    <CallResult
      tool="chart_set_symbol"
      pending={false}
      result={errorResult({ code: 'TIMEOUT', message: 'The chart did not load in time' })}
      error={null}
    />,
  );
  const timeout = within(result()).getByRole('alert');
  expect(timeout).toHaveTextContent('TIMEOUTThe chart did not load in time');
  expect(timeout.querySelectorAll('p')).toHaveLength(1);
});

test('an image result renders as an image', () => {
  // A screenshot of several MB comes through whole.
  const big = PIXEL + 'A'.repeat(4_000_000);
  const ok = okResult({ width: 1, height: 1 });
  const answer: DashboardCallResult = {
    ...ok,
    content: [
      { type: 'image', data: PIXEL, mimeType: 'image/png' },
      { type: 'image', data: big, mimeType: 'image/jpeg' },
      // Not an image type: nothing to show it as.
      { type: 'image', data: 'PGh0bWw+', mimeType: 'text/html' },
      ...ok.content,
    ],
  };
  render(<CallResult tool="screenshot_capture" pending={false} result={answer} error={null} />);
  const images = within(result()).getAllByRole('img', { name: 'Tool image' });
  expect(images.map((image) => image.getAttribute('src'))).toEqual([
    `data:image/png;base64,${PIXEL}`,
    `data:image/jpeg;base64,${big}`,
  ]);
  expect(
    within(result()).getByText('An image of type text/html is not shown.'),
  ).toBeInTheDocument();
});

test('a 50 000-character result is collapsed behind Show all', async () => {
  const user = userEvent.setup();
  const bars = Array.from({ length: 1000 }, (_, n) => ({
    time: 1704067200 + n * 60,
    close: 100 + n,
  }));
  const answer = okResult({ bars });
  const full = JSON.stringify(answer.structuredContent, null, 2);
  expect(full.length).toBeGreaterThan(50_000);
  render(<CallResult tool="data_get_ohlcv" pending={false} result={answer} error={null} />);

  expect(jsonText()).toBe(full.slice(0, 20_000));
  expect(json()).toHaveTextContent('Only the first 20,000 characters are shown.');
  await user.click(within(json()).getByRole('button', { name: 'Show all' }));
  expect(jsonText()).toBe(full);
  expect(within(json()).queryByText(/Only the first/)).not.toBeInTheDocument();
  await user.click(within(json()).getByRole('button', { name: 'Show less' }));
  expect(jsonText()).toBe(full.slice(0, 20_000));
});

test('the result says when nothing ran yet, while a run is on its way, and when the server refused it', () => {
  const { rerender } = render(
    <CallResult tool="chart_get_state" pending={false} result={undefined} error={null} />,
  );
  expect(result()).toHaveTextContent('Not run yet.');
  // The page moves the focus here when a run starts.
  expect(result()).toHaveAttribute('tabindex', '-1');

  rerender(<CallResult tool="chart_get_state" pending result={undefined} error={null} />);
  expect(within(result()).getByRole('status')).toHaveTextContent('Running chart_get_state…');

  rerender(
    <CallResult
      tool="chart_get_state"
      pending={false}
      result={undefined}
      error={new ApiError(400, 'arguments must be a JSON object')}
    />,
  );
  expect(within(result()).getByRole('alert')).toHaveTextContent(
    'The tool could not be run: arguments must be a JSON object.',
  );

  rerender(
    <CallResult
      tool="chart_get_state"
      pending={false}
      result={undefined}
      error={new TypeError('Failed to fetch')}
    />,
  );
  expect(within(result()).getByRole('alert')).toHaveTextContent(
    'The tool could not be run: The server could not be reached.',
  );
});

test('a result without structured content shows its text', () => {
  const answer: DashboardCallResult = {
    isError: true,
    content: [{ type: 'text', text: 'Something went wrong' }],
  };
  render(<CallResult tool="chart_get_state" pending={false} result={answer} error={null} />);
  expect(within(result()).getByRole('status')).toHaveTextContent('Error');
  expect(within(result()).getByText('Something went wrong')).toBeInTheDocument();
  expect(within(result()).queryByRole('region', { name: 'Structured content' })).toBeNull();
  expect(within(result()).queryByText('Duration', { selector: 'dt' })).not.toBeInTheDocument();
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatFullTime } from '@/lib/format';
import { at, endedCall, runningCall } from '@/test/fixtures';
import { fact } from '@/test/render';
import { CallDetail } from './call-detail';

const HIDDEN = 'redacted (hidden by the server)';

function sheet(tool: string): HTMLElement {
  return screen.getByRole('dialog', { name: tool });
}

// The arguments as the sheet shows them, as text.
function argumentsText(dialog: HTMLElement): string | null | undefined {
  return within(dialog).getByRole('region', { name: 'Arguments' }).querySelector('pre')
    ?.textContent;
}

test('the detail sheet shows redacted arguments as hidden by the server', async () => {
  const user = userEvent.setup();
  // An alert's message can carry the secret of a webhook: the server keeps it out of the event.
  const args = {
    symbol: 'NASDAQ:AAPL',
    price: 101.5,
    message: { redacted: true },
    notify: [{ redacted: true }, 'app'],
    // Not what the server writes for a value it keeps out: shown as it is.
    note: { redacted: false },
  };
  const call = endedCall(3, { tool: 'alert_create', args });
  const { rerender } = render(<CallDetail call={call} open onOpenChange={vi.fn()} />);
  const dialog = sheet('alert_create');
  expect(argumentsText(dialog)).toBe(
    [
      '{',
      '  "symbol": "NASDAQ:AAPL",',
      '  "price": 101.5,',
      `  "message": ${HIDDEN},`,
      '  "notify": [',
      `    ${HIDDEN},`,
      '    "app"',
      '  ],',
      '  "note": {',
      '    "redacted": false',
      '  }',
      '}',
    ].join('\n'),
  );
  expect(within(dialog).getAllByText(HIDDEN)).toHaveLength(2);

  // A copy holds what the server sent: the dashboard has no more of it to give.
  await user.click(within(dialog).getByRole('button', { name: 'Copy arguments' }));
  expect(await navigator.clipboard.readText()).toBe(JSON.stringify(args, null, 2));
  expect(within(dialog).getByRole('status')).toHaveTextContent('Arguments copied.');

  // A tool whose every argument the server keeps out.
  rerender(
    <CallDetail
      call={endedCall(4, { tool: 'ui_evaluate', args: { redacted: true } })}
      open
      onOpenChange={vi.fn()}
    />,
  );
  expect(argumentsText(sheet('ui_evaluate'))).toBe(HIDDEN);
  // The message of the copy before belonged to the other call.
  expect(within(sheet('ui_evaluate')).getByRole('status')).toHaveTextContent('');
});

test('the detail sheet says when and how a call ended, and copies the tool name', async () => {
  const user = userEvent.setup();
  const call = endedCall(2, {
    tool: 'chart_set_symbol',
    origin: 'batch',
    args: { symbol: 'NASDAQ:AAPL' },
    ok: false,
    errorCode: 'TIMEOUT',
    durationMs: 30_000,
    endedAt: at(30_200),
  });
  render(<CallDetail call={call} open onOpenChange={vi.fn()} />);
  const dialog = sheet('chart_set_symbol');
  expect(fact(dialog, 'Tool')).toBe('chart_set_symbol');
  expect(fact(dialog, 'Origin')).toBe('batch');
  expect(fact(dialog, 'Started')).toBe(formatFullTime(at(200)));
  expect(fact(dialog, 'Ended')).toBe(formatFullTime(at(30_200)));
  expect(fact(dialog, 'Duration')).toBe('30,000 ms');
  expect(fact(dialog, 'Status')).toBe('Error: TIMEOUT');
  expect(within(dialog).getByText('TIMEOUT', { selector: 'code' })).toBeInTheDocument();
  expect(
    Array.from(dialog.querySelectorAll('time'), (time) => time.getAttribute('datetime')),
  ).toEqual([at(200), at(30_200)]);
  expect(argumentsText(dialog)).toBe('{\n  "symbol": "NASDAQ:AAPL"\n}');

  await user.click(within(dialog).getByRole('button', { name: 'Copy tool name' }));
  expect(await navigator.clipboard.readText()).toBe('chart_set_symbol');
  expect(within(dialog).getByRole('status')).toHaveTextContent('Tool name copied.');
});

test('the detail sheet of a call without a result says what is known of it', () => {
  const { rerender } = render(
    <CallDetail call={runningCall(5, { args: {} })} open onOpenChange={vi.fn()} />,
  );
  let dialog = sheet('chart_get_state');
  expect(fact(dialog, 'Status')).toBe('Running');
  expect(fact(dialog, 'Ended')).toBe('Not yet');
  expect(fact(dialog, 'Duration')).toBe('Not yet');
  expect(argumentsText(dialog)).toBe('{}');
  expect(within(dialog).queryByText(/stream had a gap/)).not.toBeInTheDocument();

  // Running when the stream had a gap: its end may have been lost.
  rerender(
    <CallDetail
      call={runningCall(5, { args: {}, resultNotSeen: true })}
      open
      onOpenChange={vi.fn()}
    />,
  );
  dialog = sheet('chart_get_state');
  expect(fact(dialog, 'Status')).toBe('Result not seen');
  expect(fact(dialog, 'Ended')).toBe('Not seen');
  expect(fact(dialog, 'Duration')).toBe('Not seen');
  expect(
    within(dialog).getByText(
      'The stream had a gap while this call ran, so its end may have been lost. If it comes after all, it shows here.',
    ),
  ).toBeInTheDocument();

  // Known from its end alone: its arguments came with the start, which the stream never sent.
  // An end without a duration, or without a code, says so too.
  rerender(
    <CallDetail
      call={{ ...runningCall(6), endedAt: at(700), ok: false }}
      open
      onOpenChange={vi.fn()}
    />,
  );
  dialog = sheet('chart_get_state');
  expect(fact(dialog, 'Status')).toBe('Failed');
  expect(fact(dialog, 'Duration')).toBe('Unknown');
  const section = within(dialog).getByRole('region', { name: 'Arguments' });
  expect(section).toHaveTextContent('Not known: the stream never sent the start of this call.');
  expect(section.querySelector('pre')).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Copy arguments' })).toBeDisabled();
});

test('copying says so when the browser refuses', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
    new DOMException('Write permission denied.', 'NotAllowedError'),
  );
  render(<CallDetail call={endedCall(1, { args: {} })} open onOpenChange={vi.fn()} />);
  const dialog = sheet('chart_get_state');
  await user.click(within(dialog).getByRole('button', { name: 'Copy arguments' }));
  expect(within(dialog).getByRole('status')).toHaveTextContent(
    'Could not copy: the browser refused.',
  );
});

test('the sheet asks its owner to close it, with its button or Escape', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const { rerender } = render(<CallDetail call={endedCall(1)} open onOpenChange={onOpenChange} />);
  await user.click(within(sheet('chart_get_state')).getByRole('button', { name: 'Close' }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledTimes(2);

  rerender(<CallDetail call={endedCall(1)} open={false} onOpenChange={onOpenChange} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // No call to show: no sheet, even when asked to be open.
  rerender(<CallDetail call={null} open onOpenChange={onOpenChange} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

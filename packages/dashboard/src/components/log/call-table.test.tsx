import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ALL } from '@/lib/call-filter';
import { formatTime } from '@/lib/format';
import { at, endedCall, runningCall } from '@/test/fixtures';
import { cells } from '@/test/render';
import { CallTable } from './call-table';

function table(): HTMLElement {
  return screen.getByRole('table', { name: 'Tool calls, newest first' });
}

function row(index: number): HTMLElement {
  const found = within(table()).getAllByRole('row')[index];
  if (found === undefined) {
    throw new Error(`The table has no row ${String(index)}`);
  }
  return found;
}

// The rows of the table without the header and without the time, which is on the browser clock.
function rowsWithoutTime(): string[][] {
  return cells(table())
    .slice(1)
    .map((cellsOfRow) => cellsOfRow.slice(1));
}

test('a long log renders at most 200 rows and says how many there are', () => {
  // As many calls as the log keeps: every eighth of a batch, every tenth a drawing_list.
  const calls = Array.from({ length: 1000 }, (_, index) => {
    const n = index + 1;
    return endedCall(n, {
      ...(n % 8 === 0 ? { origin: 'batch' as const } : {}),
      ...(n % 10 === 0 ? { tool: 'drawing_list' } : {}),
    });
  });
  const onSelect = vi.fn();
  const { rerender } = render(<CallTable calls={calls} filter={ALL} onSelect={onSelect} />);
  expect(within(table()).getAllByRole('row')).toHaveLength(201);
  expect(screen.getByText('Showing 200 of 1,000')).toBeInTheDocument();
  // The newest 200, newest first.
  expect(row(1).querySelector('time')).toHaveAttribute('datetime', at(100_000));
  expect(row(200).querySelector('time')).toHaveAttribute('datetime', at(80_100));

  // The count is of the calls that pass the filters.
  rerender(<CallTable calls={calls} filter={{ ...ALL, q: 'chart' }} onSelect={onSelect} />);
  expect(within(table()).getAllByRole('row')).toHaveLength(201);
  expect(screen.getByText('Showing 200 of 900')).toBeInTheDocument();
  expect(rowsWithoutTime().every(([tool]) => tool === 'chart_get_state')).toBe(true);

  // No more than 200 match: all of them show, and there is nothing to say.
  rerender(<CallTable calls={calls} filter={{ ...ALL, origin: 'batch' }} onSelect={onSelect} />);
  expect(within(table()).getAllByRole('row')).toHaveLength(126);
  expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
});

test('the table names each status in words, and leaves the duration of an unfinished call empty', () => {
  const calls = [
    endedCall(1),
    endedCall(2, { tool: 'chart_set_symbol', ok: false, errorCode: 'TIMEOUT', durationMs: 30_000 }),
    endedCall(3, { tool: 'drawing_clear_all', ok: false }),
    runningCall(4, { tool: 'drawing_list', origin: 'batch' }),
    runningCall(5, { resultNotSeen: true }),
    endedCall(6, { tool: 'app_health', origin: 'dashboard', durationMs: 1250 }),
  ];
  render(<CallTable calls={calls} filter={ALL} onSelect={vi.fn()} />);
  expect(cells(table())[0]).toEqual(['Time', 'Tool', 'Origin', 'Status', 'Duration']);
  expect(rowsWithoutTime()).toEqual([
    ['app_health', 'dashboard', 'OK', '1,250 ms'],
    ['chart_get_state', 'mcp', 'Result not seen', ''],
    ['drawing_list', 'batch', 'Running', ''],
    ['drawing_clear_all', 'mcp', 'Failed', '42 ms'],
    ['chart_set_symbol', 'mcp', 'TIMEOUT', '30,000 ms'],
    ['chart_get_state', 'mcp', 'OK', '42 ms'],
  ]);
  // The time of its start, on the browser clock.
  const time = row(1).querySelector('time');
  expect(time).toHaveAttribute('datetime', at(600));
  expect(time).toHaveTextContent(formatTime(at(600)));
  expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
});

test('a click anywhere on a row, or its button from the keyboard, opens that call', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const calls = [endedCall(1), runningCall(2, { tool: 'drawing_list', origin: 'batch' })];
  render(<CallTable calls={calls} filter={ALL} onSelect={onSelect} />);

  // The status cell of the older call.
  await user.click(within(row(2)).getByText('OK'));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenLastCalledWith(calls[0], within(row(2)).getByRole('button'));

  // The newest call's button is the first stop of Tab, and names its call.
  await user.tab();
  const button = within(row(1)).getByRole('button', {
    name: `Details of drawing_list at ${formatTime(at(200))}`,
  });
  expect(button).toHaveFocus();
  expect(button).toHaveTextContent('drawing_list');
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith(calls[1], button);
});

test('the table says when there are no calls yet, or none that pass the filters', () => {
  const { rerender } = render(<CallTable calls={[]} filter={ALL} onSelect={vi.fn()} />);
  expect(screen.getByText('No tool calls yet.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();

  rerender(
    <CallTable calls={[endedCall(1)]} filter={{ ...ALL, origin: 'batch' }} onSelect={vi.fn()} />,
  );
  expect(screen.getByText('No calls match the filters.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

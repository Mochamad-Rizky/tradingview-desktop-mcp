import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ALL } from '@/lib/call-filter';
import { CallFilters } from './call-filters';

function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent);
}

test('the filter controls show the filter, and report each change', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <CallFilters filter={{ q: 'chart', origin: 'batch', status: 'running' }} onChange={onChange} />,
  );
  const search = screen.getByRole('searchbox', { name: 'Search tools' });
  const origin = screen.getByRole('combobox', { name: 'Origin' });
  const status = screen.getByRole('combobox', { name: 'Status' });
  expect(search).toHaveValue('chart');
  expect(origin).toHaveTextContent('batch');
  expect(status).toHaveTextContent('Running');

  await user.type(search, 's');
  expect(onChange).toHaveBeenLastCalledWith({ q: 'charts' });

  await user.click(origin);
  expect(optionNames()).toEqual(['All origins', 'mcp', 'batch', 'dashboard']);
  await user.click(screen.getByRole('option', { name: 'dashboard' }));
  expect(onChange).toHaveBeenLastCalledWith({ origin: 'dashboard' });

  await user.click(status);
  expect(optionNames()).toEqual(['All statuses', 'Running', 'OK', 'Error']);
  await user.click(screen.getByRole('option', { name: 'OK' }));
  expect(onChange).toHaveBeenLastCalledWith({ status: 'ok' });

  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(onChange).toHaveBeenLastCalledWith(ALL);
});

test('reset is offered only while a filter is set', () => {
  const { rerender } = render(<CallFilters filter={ALL} onChange={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: 'Origin' })).toHaveTextContent('All origins');
  expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('All statuses');
  expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
  for (const filter of [{ q: 'x' }, { origin: 'mcp' as const }, { status: 'error' as const }]) {
    rerender(<CallFilters filter={{ ...ALL, ...filter }} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument();
  }
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toolNamed as tool } from '@/test/fixtures';
import { RunConfirm } from './run-confirm';

test("a destructive tool's confirmation warns that it can remove or replace data", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const args = { scope: 'all', chartIndex: 1 };
  const { rerender } = render(
    <RunConfirm
      tool={tool('drawing_clear_all')}
      args={args}
      running={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onCloseAutoFocus={vi.fn()}
    />,
  );
  const dialog = screen.getByRole('alertdialog', { name: 'Run drawing_clear_all?' });
  expect(dialog).toHaveAccessibleDescription(
    'It acts on your TradingView. It can remove or replace data.',
  );
  // The arguments as they will be sent.
  expect(within(dialog).getByRole('region', { name: 'Arguments' })).toHaveTextContent(
    '{ "scope": "all", "chartIndex": 1 }',
  );
  // The safe choice has the focus.
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

  await user.click(within(dialog).getByRole('button', { name: 'Run' }));
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(args);
  expect(onCancel).not.toHaveBeenCalled();

  // A tool that changes things without removing any is not said to remove data.
  rerender(
    <RunConfirm
      tool={tool('chart_set_symbol')}
      args={{ symbol: 'NASDAQ:AAPL' }}
      running={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      onCloseAutoFocus={vi.fn()}
    />,
  );
  const plain = screen.getByRole('alertdialog', { name: 'Run chart_set_symbol?' });
  expect(plain).toHaveAccessibleDescription('It acts on your TradingView.');
  expect(within(plain).queryByText('It can remove or replace data.')).not.toBeInTheDocument();
});

test('the confirmation closes with Cancel or Escape, and waits while a run is in progress', async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props = { tool: tool('chart_set_symbol'), onCancel, onConfirm, onCloseAutoFocus: vi.fn() };
  const { rerender } = render(<RunConfirm {...props} args={{}} running={false} />);

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  await user.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).not.toHaveBeenCalled();

  rerender(<RunConfirm {...props} args={{}} running />);
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

  // No arguments to confirm, no dialog.
  rerender(<RunConfirm {...props} args={null} running={false} />);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

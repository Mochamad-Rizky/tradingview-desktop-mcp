import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArgsEditor, parseArgs } from './args-editor';

test('invalid JSON disables Run and explains why', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const { rerender } = render(<ArgsEditor running={false} onRun={onRun} />);
  const editor = screen.getByRole('textbox', { name: 'Arguments (JSON)' });
  const run = screen.getByRole('button', { name: 'Run' });
  // Prefilled with no arguments, which every tool without a required field takes.
  expect(editor).toHaveValue('{}');
  expect(run).toBeEnabled();
  expect(editor).not.toHaveAttribute('aria-invalid', 'true');

  const write = async (text: string) => {
    await user.clear(editor);
    if (text !== '') {
      await user.click(editor);
      await user.paste(text);
    }
  };

  await write('{"symbol": ');
  expect(run).toBeDisabled();
  expect(editor).toHaveAttribute('aria-invalid', 'true');
  const problem = screen.getByText(/^Not valid JSON: /);
  expect(problem.textContent.length).toBeGreaterThan('Not valid JSON: '.length);
  expect(editor).toHaveAccessibleDescription(problem.textContent);

  for (const notAnObject of ['[1, 2]', '"NASDAQ:AAPL"', 'null', '42', '']) {
    await write(notAnObject);
    expect(run).toBeDisabled();
  }
  await write('[1, 2]');
  expect(screen.getByText('The arguments must be a JSON object, such as {}.')).toBeInTheDocument();

  await write('{\n  "symbol": "NASDAQ:AAPL"\n}');
  expect(run).toBeEnabled();
  expect(screen.queryByText(/Not valid JSON/)).not.toBeInTheDocument();
  expect(editor).not.toHaveAttribute('aria-invalid', 'true');
  await user.click(run);
  expect(onRun).toHaveBeenCalledExactlyOnceWith({ symbol: 'NASDAQ:AAPL' });

  // While a run is in progress, Run waits, whatever the JSON.
  rerender(<ArgsEditor running onRun={onRun} />);
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  expect(editor).toHaveValue('{\n  "symbol": "NASDAQ:AAPL"\n}');
});

test('parseArgs takes a JSON object and nothing else', () => {
  expect(parseArgs(' { "a": [1, {"b": null}] } ')).toEqual({
    ok: true,
    args: { a: [1, { b: null }] },
  });
  expect(parseArgs('{}')).toEqual({ ok: true, args: {} });
  expect(parseArgs('[]')).toEqual({
    ok: false,
    message: 'The arguments must be a JSON object, such as {}.',
  });
  const broken = parseArgs('{,}');
  expect(broken.ok).toBe(false);
  expect(!broken.ok && broken.message).toMatch(/^Not valid JSON: \S/);
});

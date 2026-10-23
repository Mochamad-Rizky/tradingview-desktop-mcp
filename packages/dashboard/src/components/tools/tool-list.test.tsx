import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tools } from '@/test/fixtures';
import { ToolList } from './tool-list';

function list(): HTMLElement {
  return screen.getByRole('list', { name: 'Tools' });
}

// The tool names the list shows, in order.
function shown(): string[] {
  const found = screen.queryByRole('list', { name: 'Tools' });
  return found === null
    ? []
    : within(found)
        .getAllByRole('link')
        .map((link) => link.querySelector('code')?.textContent ?? '');
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent);
}

test('the tool list filters by search, domain, profile and annotation', async () => {
  const user = userEvent.setup();
  render(<ToolList tools={tools} selected="chart_set_symbol" />);
  const all = [
    'app_health',
    'app_get_plan_limits',
    'chart_get_state',
    'chart_set_symbol',
    'drawing_list',
    'drawing_clear_all',
  ];
  expect(shown()).toEqual(all);
  expect(screen.getByRole('status')).toHaveTextContent('6 tools');

  // Each item: the name, the title, and badges for read-only, destructive and core.
  const item = (name: string) => within(list()).getByRole('link', { name: new RegExp(`^${name}`) });
  expect(item('chart_set_symbol')).toHaveAttribute('href', '/tools/chart_set_symbol');
  expect(item('chart_set_symbol')).toHaveAttribute('aria-current', 'page');
  expect(item('chart_get_state')).not.toHaveAttribute('aria-current');
  expect(item('chart_get_state')).toHaveTextContent(
    'chart_get_stateread-onlycoreRead the chart state',
  );
  expect(item('chart_set_symbol')).toHaveTextContent('chart_set_symbolcoreChange the chart symbol');
  expect(item('drawing_clear_all')).toHaveTextContent(
    'drawing_clear_alldestructiveRemove the drawings',
  );
  expect(item('app_get_plan_limits')).toHaveTextContent(
    'app_get_plan_limitsread-onlyRead the plan limits',
  );

  // The search looks in the name, the title and the description, for every word typed.
  const search = screen.getByRole('searchbox', { name: 'Search tools' });
  await user.type(search, 'symbol');
  expect(shown()).toEqual(['chart_set_symbol']);
  expect(screen.getByRole('status')).toHaveTextContent('1 of 6 tools');
  await user.clear(search);
  await user.type(search, 'UNLIMITED');
  expect(shown()).toEqual(['app_get_plan_limits']);
  await user.clear(search);
  await user.type(search, '  drawings  remove ');
  expect(shown()).toEqual(['drawing_clear_all']);
  await user.clear(search);
  await user.type(search, 'nothing like this');
  expect(shown()).toEqual([]);
  expect(screen.getByText('No tools match the filters.')).toBeInTheDocument();
  await user.clear(search);

  // The domains of the tools offered, in the order they come.
  await user.click(screen.getByRole('combobox', { name: 'Domain' }));
  expect(optionNames()).toEqual(['All domains', 'app', 'chart', 'drawing']);
  await user.click(screen.getByRole('option', { name: 'chart' }));
  expect(shown()).toEqual(['chart_get_state', 'chart_set_symbol']);
  await user.click(screen.getByRole('combobox', { name: 'Domain' }));
  await user.click(screen.getByRole('option', { name: 'All domains' }));
  expect(shown()).toEqual(all);

  // A profile toggle keeps the tools of that profile; both keep the tools of both.
  const core = screen.getByRole('switch', { name: 'core profile' });
  const readonly = screen.getByRole('switch', { name: 'readonly profile' });
  await user.click(core);
  expect(core).toBeChecked();
  expect(shown()).toEqual(['app_health', 'chart_get_state', 'chart_set_symbol', 'drawing_list']);
  await user.click(readonly);
  expect(shown()).toEqual(['app_health', 'chart_get_state', 'drawing_list']);
  await user.click(core);
  expect(shown()).toEqual(['app_health', 'app_get_plan_limits', 'chart_get_state', 'drawing_list']);
  await user.click(readonly);
  expect(shown()).toEqual(all);

  // Read-only, changes and destructive part the tools: each tool is one of them.
  const effect = screen.getByRole('combobox', { name: 'Effect' });
  await user.click(effect);
  expect(optionNames()).toEqual(['Any effect', 'Read-only', 'Changes', 'Destructive']);
  await user.click(screen.getByRole('option', { name: 'Read-only' }));
  expect(shown()).toEqual(['app_health', 'app_get_plan_limits', 'chart_get_state', 'drawing_list']);
  await user.click(effect);
  await user.click(screen.getByRole('option', { name: 'Changes' }));
  expect(shown()).toEqual(['chart_set_symbol']);
  await user.click(effect);
  await user.click(screen.getByRole('option', { name: 'Destructive' }));
  expect(shown()).toEqual(['drawing_clear_all']);

  // The filters add up, and Reset filters takes them all away.
  await user.type(search, 'symbol');
  expect(shown()).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(shown()).toEqual(all);
  expect(search).toHaveValue('');
  expect(effect).toHaveTextContent('Any effect');
  expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
});

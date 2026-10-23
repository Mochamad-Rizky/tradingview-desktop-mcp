import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, within, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { EventLogProvider } from '@/hooks/use-event-log';
import { createTestQueryClient } from './query';

// Renders `ui` as the app does behind the token gate: with a query client and the event log.
export function renderInApp(
  ui: ReactElement,
  client: QueryClient = createTestQueryClient(),
): RenderResult & { client: QueryClient } {
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <EventLogProvider>{children}</EventLogProvider>
      </QueryClientProvider>
    );
  }
  return Object.assign(render(ui, { wrapper: Providers }), { client });
}

// The text of the value that `label` names in a list of facts (<dt> and <dd>) inside `container`.
export function fact(container: HTMLElement, label: string): string | null {
  const term = within(container).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

// The text of each cell of `table`, row by row, the header row included.
export function cells(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent.trim()));
}

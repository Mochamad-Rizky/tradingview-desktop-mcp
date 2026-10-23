import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Route, Switch } from 'wouter';
import { createQueryClient } from '@/api/query-client';
import { AppShell } from '@/components/layout/app-shell';
import { TokenGate } from '@/components/token-gate';
import { EventLogProvider } from '@/hooks/use-event-log';
import { LogPage } from '@/pages/log-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { StatusPage } from '@/pages/status-page';
import { ToolsPage } from '@/pages/tools-page';

// The page follows the path, which the server answers with this app for every page of it. Nothing
// shows before the token gate has a token, and the event log streams for every page alike.
export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <EventLogProvider>
          <AppShell>
            <Switch>
              <Route path="/" component={StatusPage} />
              <Route path="/log" component={LogPage} />
              <Route path="/tools/:name?" component={ToolsPage} />
              <Route component={NotFoundPage} />
            </Switch>
          </AppShell>
        </EventLogProvider>
      </TokenGate>
    </QueryClientProvider>
  );
}

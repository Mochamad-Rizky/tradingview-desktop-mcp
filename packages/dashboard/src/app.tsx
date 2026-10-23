import { Route, Switch } from 'wouter';
import { AppShell } from '@/components/layout/app-shell';
import { LogPage } from '@/pages/log-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { StatusPage } from '@/pages/status-page';
import { ToolsPage } from '@/pages/tools-page';

// The page follows the path, which the server answers with this app for every page of it.
export function App() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={StatusPage} />
        <Route path="/log" component={LogPage} />
        <Route path="/tools" component={ToolsPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </AppShell>
  );
}

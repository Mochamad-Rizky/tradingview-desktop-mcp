import type { ReactNode } from 'react';
import { Link, useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from './theme-toggle';

const PAGES = [
  { href: '/', label: 'Status' },
  { href: '/log', label: 'Log' },
  { href: '/tools', label: 'Tools' },
] as const;

function NavLink({ href, label }: { href: string; label: string }) {
  const [active] = useRoute(href);
  return (
    <Button asChild variant={active ? 'secondary' : 'ghost'}>
      <Link href={href} aria-current={active ? 'page' : undefined}>
        {label}
      </Link>
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
          <span className="font-heading font-semibold">TradingView MCP</span>
          <nav aria-label="Main" className="flex items-center gap-1">
            {PAGES.map((page) => (
              <NavLink key={page.href} {...page} />
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

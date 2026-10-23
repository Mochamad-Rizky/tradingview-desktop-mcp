import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { Button } from '@/components/ui/button';
import { ConnectionBadge } from './connection-badge';
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

// After a move to another page the focus goes to its heading, so that a screen reader says where
// it landed and Tab goes on from there. Not on the first load, which starts at the top of the
// document; the location the page was first shown at tells the two apart, also when StrictMode
// runs the effect twice.
function useFocusOnNavigation(main: RefObject<HTMLElement | null>): void {
  const [location] = useLocation();
  const shown = useRef(location);
  useEffect(() => {
    if (shown.current === location) {
      return;
    }
    shown.current = location;
    main.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [location, main]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  useFocusOnNavigation(main);
  return (
    <div className="flex min-h-svh flex-col">
      {/* The first stop of Tab, shown only then: it skips the header. It moves the focus itself
          rather than follow #main, so that the address stays as it is. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-ring"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="border-b">
        {/* On a narrow screen the badge and the theme toggle wrap to a line of their own. */}
        <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <span className="font-heading font-semibold whitespace-nowrap">TradingView MCP</span>
          <nav aria-label="Main" className="flex items-center gap-1">
            {PAGES.map((page) => (
              <NavLink key={page.href} {...page} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none"
      >
        {children}
      </main>
    </div>
  );
}

import { useEffect } from 'react';

const APP_TITLE = 'TradingView MCP Dashboard';

// The heading of a page, which names the page in the browser tab too. The app shell moves the focus
// to the heading after a move to another page, hence its tabIndex.
export function PageHeader({ title, description }: { title: string; description: string }) {
  useEffect(() => {
    document.title = `${title} · ${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);

  return (
    <div className="flex flex-col gap-1">
      <h1 tabIndex={-1} className="font-heading text-2xl font-semibold tracking-tight outline-none">
        {title}
      </h1>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}

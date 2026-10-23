import { MoonIcon, SunIcon } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, initialTheme, storeTheme, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  // Before paint, so that the page never shows in the other theme.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        storeTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

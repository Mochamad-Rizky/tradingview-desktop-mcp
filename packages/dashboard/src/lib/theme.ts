// The colour theme: the one the user chose with the toggle, kept in localStorage, or else the one
// the system prefers. The dark class on <html> switches the theme's colour tokens.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tvmcp.theme';

// Storage can be refused (blocked site data, some private windows), which throws. The theme then
// lasts for the page load only.
function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Kept for this page load only.
  }
}

export function initialTheme(): Theme {
  return (
    storedTheme() ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

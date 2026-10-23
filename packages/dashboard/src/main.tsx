import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { applyTheme, initialTheme } from './lib/theme';
import './styles.css';

// Before the first render, so that a dark theme never flashes light while the app starts.
applyTheme(initialTheme());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

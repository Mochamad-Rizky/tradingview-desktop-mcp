import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { takeTokenFromLocation } from './api/token';
import { App } from './app';
import { applyTheme, initialTheme } from './lib/theme';
import './styles.css';

// Before the first render: a link such as /#token=… signs in, and the token leaves the address at
// once. Rendering then only reads it.
takeTokenFromLocation();
// Before the first render too, so that a dark theme never flashes light while the app starts.
applyTheme(initialTheme());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

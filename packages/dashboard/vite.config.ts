import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';

// `pnpm dev:dashboard` serves the dashboard with hot reload and hands the API to a server started
// next to it, on the port the server reads from the same variable.
const target = `http://127.0.0.1:${process.env.TV_MCP_HTTP_PORT ?? '8787'}`;

// The server refuses a request whose Host or Origin is not its own, and the page runs on Vite's
// port: both headers are rewritten to the server's address.
const toServer: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('Origin', target);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: { '/api': toServer, '/healthz': toServer },
  },
});

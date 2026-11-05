import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev the SPA runs on 5173 and proxies to the server; in production the
// server serves `web/dist` itself, so the base path stays relative.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:20121', changeOrigin: true },
      '/v1': { target: 'http://127.0.0.1:20121', changeOrigin: true },
      // The Anthropic surface is a third front door to the same process, and
      // it is reachable in production because the server serves it itself.
      // Without this the dialect works against the built server and silently
      // does not exist against `pnpm dev`, which is the worst way for the two
      // to differ - the failure looks like the proxy is down rather than like
      // one route is missing.
      '/anthropic': { target: 'http://127.0.0.1:20121', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});

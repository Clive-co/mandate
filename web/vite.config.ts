import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, /api/* is proxied to the Node server so there is no CORS to think about.
// In production, set VITE_API_URL to the deployed API's origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});

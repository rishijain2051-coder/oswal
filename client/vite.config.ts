import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Frontend dev server proxies API + uploaded images to the backend on :689
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 688,
    /**
     * Listen on the network, not just loopback.
     *
     * One factory, several devices: the office PC runs this and the floor wants the board on a
     * tablet. Vite binds to localhost by default, so another device could not open a socket at
     * all — which looks like a login or firewall problem and is neither.
     *
     * The API is reachable already (Express binds every interface), so this is the only half
     * that was missing. See `resolveOrigins` in server/src/env.ts for the matching CORS rule,
     * which is what decides whether the browser is then allowed to use it.
     */
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:689',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:689',
        changeOrigin: true,
      },
    },
  },
});

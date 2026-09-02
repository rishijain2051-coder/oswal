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
    /**
     * Hostnames this dev server will answer to, for reaching the app from outside the
     * factory network through a tunnel.
     *
     * Vite refuses a request whose `Host` header it does not recognise — a DNS-rebinding
     * defence — and answers "Blocked request" as plain text, which looks like the app
     * failing rather than a setting.
     *
     * Both are SUFFIXES rather than one name. A Cloudflare quick tunnel is issued a new
     * `<generated-name>.trycloudflare.com` every time it starts; a Tailscale tailnet is
     * `<machine>.<tailnet>.ts.net`, which is stable but not known until the machine joins.
     *
     * This only decides which Host header is answered. Whether the browser may then USE
     * the response is `CORS_ORIGINS` in server/.env — both must name the tunnel or the
     * app loads and every request fails. See `resolveOrigins` in server/src/env.ts.
     */
    allowedHosts: ['.trycloudflare.com', '.ts.net'],
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

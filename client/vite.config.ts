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

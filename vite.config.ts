import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': {
      target: 'http://127.0.0.1:43127', changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', (proxyReq, req) => {
          if (['http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin ?? '')) {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:43127');
          }
        });
      },
    } },
  },
});

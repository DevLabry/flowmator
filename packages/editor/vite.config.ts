import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = process.env.BACKEND_URL ?? 'http://localhost:5678';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/rest/push': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/rest': backend,
      '/api': backend,
      '/webhook': backend,
      '/webhook-test': backend,
      '/webhook-waiting': backend,
    },
  },
  // the shared workflow package references Buffer in a few helpers; give it a harmless global
  define: { 'process.env.NODE_DEBUG': 'false' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});

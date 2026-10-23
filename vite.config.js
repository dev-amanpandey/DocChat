import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'frontend'),
  server: { port: 5173 },
  build: { outDir: resolve(process.cwd(), 'dist/frontend'), emptyOutDir: true },
});

import { defineConfig } from 'vitest/config';
import { loomPlugin } from './src/server/api.js';

export default defineConfig({
  plugins: [loomPlugin(process.cwd())],
  server: {
    host: '127.0.0.1',
    port: 5230,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

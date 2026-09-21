import { defineConfig } from 'vite';
import { loomApi } from './src/server/api.ts';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5230,
    strictPort: true
  },
  plugins: [loomApi()]
});

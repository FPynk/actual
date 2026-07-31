import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: { external: ['@actual-app/api'] },
    target: 'es2022',
  },
});

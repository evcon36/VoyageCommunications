import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    // тяжёлые библиотеки — отдельными файлами: браузер качает их параллельно
    // и кэширует между релизами (обычно меняется только код приложения)
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/livekit-client')) return 'livekit';
          if (id.includes('node_modules/react') || id.includes('node_modules/socket.io')) return 'vendor';
        },
      },
    },
  },
})
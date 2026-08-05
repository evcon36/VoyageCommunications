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
        // Операторы душат подсеть сервера так, что крупные ответы рвутся, а
        // мелкие проходят. Поэтому дробим на много средних кусков вместо
        // нескольких больших: медиадвижок в один файл на 456 КБ был главным
        // кандидатом на обрыв.
        // Медиадвижок разрезать на части нельзя: livekit-client приходит одним
        // собранным файлом, внутренних путей для деления нет. Уменьшить первый
        // экран можно только отложенной загрузкой, а не раскладкой по кускам.
        // Остальное разводим, чтобы не было одного большого файла на всё.
        manualChunks(id) {
          if (id.includes('node_modules/livekit-client')) return 'livekit';
          if (id.includes('node_modules/socket.io') || id.includes('node_modules/engine.io')) return 'socket';
          if (id.includes('node_modules/react')) return 'react';
        },
      },
    },
  },
})
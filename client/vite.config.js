import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    https: {
      key: fs.readFileSync(path.resolve(__dirname, 'cert/localhost+3-key.pem')),
      cert: fs.readFileSync(path.resolve(__dirname, 'cert/localhost+3.pem')),
    },
    port: 5173,
  },
})
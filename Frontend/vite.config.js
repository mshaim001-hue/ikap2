import process from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const basePath = env.VITE_APP_BASE_PATH || '/'

  return {
    base: basePath.endsWith('/') ? basePath : `${basePath}/`,
    plugins: [react()],
    build: {
      sourcemap: true,
    },
  }
})

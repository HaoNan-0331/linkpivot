import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'electron/**/*.test.ts'],
    server: {
      deps: {
        inline: ['../../electron'],
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
})

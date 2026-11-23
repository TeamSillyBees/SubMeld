import { defineConfig } from '@playwright/test'

const port = Number(process.env.SUBMELD_BROWSER_TEST_PORT) || 47891
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './test/browser',
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:' + port,
    viewport: { width: 1440, height: 940 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/browser-server.ts',
    url: 'http://127.0.0.1:' + port,
    timeout: 10000,
  },
})

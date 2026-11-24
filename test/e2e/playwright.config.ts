import { defineConfig } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const workers = Number(process.env.E2E_WORKERS) || 1

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers,
  fullyParallel: false,
  outputDir: '../../test-results/e2e',
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 940 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'tier1', testDir: './tier1' },
    { name: 'tier2', testDir: './tier2' },
    { name: 'tier3', testDir: './tier3' },
    { name: 'tier4', testDir: './tier4' },
  ],
})

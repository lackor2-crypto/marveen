// #824 (Boss TG 4159): the real-browser regression suite that needs a RUNNING dashboard (signature, language versions,
// finalising, folder structure, Life-tree move). playwright.browser.config.ts serves the static front-end only; this one boots
// a disposable web-only instance (tests/browser-live/serve.mts) with an empty store, so it can click through what the vitest
// source tests cannot see. It never points at the owner's live dashboard.
import { defineConfig } from '@playwright/test'

const port = process.env.LIVE_BROWSER_PORT || '3498'

export default defineConfig({
  testDir: './tests/browser-live',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalTeardown: './tests/browser-live/global-teardown.ts',
  webServer: {
    command: 'npx tsx tests/browser-live/serve.mts',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { LIVE_BROWSER_PORT: port },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.CHROMIUM_BIN || undefined },
  },
})

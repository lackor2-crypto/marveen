// Boss, 2026-09-26 (TG 6550): the Settings -> Backup tab was EMPTY, and the
// Overview self-check's "backup key" row led to that empty page. index.html
// loaded /backup.js, but the static route only serves an allowlist, and
// backup.js was not on it: 404, window.renderBackupPanel never existed.
// Every script and stylesheet index.html references must have a route.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
const route = readFileSync(join(root, 'src', 'web', 'routes', 'static.ts'), 'utf8')
const assets = [...html.matchAll(/<(?:script\s+src|link\s+rel="stylesheet"\s+href)="(\/[^"?]+)"/g)].map(m => m[1])

describe('index.html assets are served', () => {
  it('finds the page assets', () => {
    expect(assets).toContain('/app.js')
    expect(assets).toContain('/backup.js')
  })

  it('every referenced local script/stylesheet exists and has a static route', () => {
    for (const a of assets) {
      expect(existsSync(join(root, 'web', a)), `${a} missing on disk`).toBe(true)
      const direct = route.includes(`path === '${a}'`)
      const lang = a.startsWith('/lang/') && /path\.startsWith\('\/lang\/'\)|\/lang\//.test(route)
      expect(direct || lang, `${a} is referenced by index.html but not served by routes/static.ts`).toBe(true)
    }
  })

  it('cache-busts backup.js like the other versioned assets', () => {
    expect(route).toMatch(/backup\\\.js/)
    expect(route).toContain("assetVersion(webDir, 'backup.js')")
  })
})

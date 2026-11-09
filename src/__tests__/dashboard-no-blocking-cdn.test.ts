import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// #891: a render-blocking CDN <script>/<link> in the <head> left the dashboard an empty window after every refresh
// when the CDN was slow. The external libraries load on first use (loadCdnAssets) instead.
const root = path.resolve(__dirname, '..', '..')
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')

describe('dashboard first paint does not wait for a CDN (#891)', () => {
  it('index.html has no external script or stylesheet tag', () => {
    const tags = html.match(/<(script|link)\b[^>]*(src|href)="https?:\/\/[^"]+"[^>]*>/g) ?? []
    expect(tags).toEqual([])
  })
  it('app.js loads xterm and the QR generator on first use', () => {
    expect(app).toContain('function loadCdnAssets(')
    expect(app).toMatch(/loadCdnAssets\('terminal'\)\.then\(\(\) => openTerminalModalNow/)
    expect(app).toMatch(/await loadCdnAssets\('qr'\) \}[^\n]*\n\s*if \(typeof qrcode !== 'function'\)/)
  })
})

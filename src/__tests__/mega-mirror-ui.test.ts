// Card #360: the account-root upload is reachable from the UI (fresh install:
// no terminal, no API call by hand) and never starts by itself.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const route = readFileSync(join(__dirname, '../web/routes/backup-rules.ts'), 'utf-8')

describe('MEGA account-root upload UI (#360)', () => {
  it('every MEGA account card has an upload button that opens the preview window', () => {
    expect(app).toContain('data-mega-upload="${name}"')
    expect(app).toContain("if (up) { _bkOpenMegaUpload(null, up.dataset.megaUpload); return }")
    expect(app).toContain("[data-mega-measure],[data-mega-remove],[data-mega-upload]")
  })

  it('the window previews first; only the button calls run', () => {
    expect(app).toContain("_bkPost(api + 'preview', body)")
    const runCalls = app.match(/_bkPost\(api \+ 'run', body\)/g) || []
    expect(runCalls.length).toBe(1)
    expect(app).toMatch(/go\.addEventListener\('click', async \(\) => \{\s*go\.disabled = true\s*try \{ const d = await _bkPost\(api \+ 'run', body\)/)
  })

  it('nothing on the server starts an upload on a timer', () => {
    expect(route).not.toMatch(/setInterval|setTimeout/)
    expect((route.match(/runMegaUpload\(/g) || []).length).toBe(1)
  })

  it('every new text exists in HU and EN', () => {
    const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
    const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
    for (const k of ['mega.upload', 'backup.mega_mirror_title', 'backup.mega_mirror_intro', 'backup.mega_mirror_empty', 'backup.mega_preview_remote_untracked']) {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    }
  })
})

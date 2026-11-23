// #983: a .fla opens in no program on the machine; the preview dialog offers the free FLA Viewer instead.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = join(import.meta.dirname, '..', '..')
const app = readFileSync(join(root, 'web/app.js'), 'utf-8')
describe('#983 .fla gets a FLA Viewer button', () => {
  it('the no-preview dialog adds the button for .fla files only and downloads the file', () => {
    expect(app).toContain("/\\.fla$/i.test(")
    expect(app).toContain('https://lifeart.github.io/fla-viewer/')
    expect(app).toContain("t('intezo.fla_viewer_btn')")
    expect(app).toContain("t('intezo.fla_viewer_hint'")
  })
  it('both language files carry both keys', () => {
    for (const l of ['hu', 'en']) {
      const f = readFileSync(join(root, `web/lang/${l}.js`), 'utf-8')
      expect(f).toContain("'intezo.fla_viewer_btn'")
      expect(f).toContain("'intezo.fla_viewer_hint'")
    }
  })
})

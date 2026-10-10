// #530 (lackor2-bot 5733): in the Simple view the attachments have their own labelled, open place on the
// draft tab, and on a phone the page column flows on the page (it used to collapse and hide behind the chat).
// Source contract only: the rendered result was looked at in a browser (simple + manual, 1500 and 390 px).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web/workbench.js'), 'utf8')
const css = readFileSync(join(root, 'web/workbench.css'), 'utf8')

describe('the attachments place in the Simple view', () => {
  it('is its own open section with a label, not folded into the language versions', () => {
    const fn = js.slice(js.indexOf('function docExtrasHtml()'), js.indexOf('// --- mentes es muveletek ---'))
    expect(fn).toContain('wb-dp-annex')
    expect(fn).toContain("t('workbench.dp.annex'")
    expect(fn).toMatch(/<details class="wb-dp-more wb-dp-annex" open>/)
    // the fold that is left must not mention attachments any more
    for (const f of ['hu', 'en']) {
      const l = readFileSync(join(root, `web/lang/${f}.js`), 'utf8')
      expect(l).toMatch(/"workbench\.dp\.annex": "[^"]+\{n\}\)?"/)
      expect(l).not.toMatch(/"workbench\.dp\.more": "[^"]*(mellékletek|attachments)/i)
    }
  })

  it('the page column does not collapse on a phone', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{ \.wb-fr-center \{ overflow: visible; \} \.wb-fr-scroll \{ flex: none; overflow: visible; max-height: none; \} \}/)
  })
})

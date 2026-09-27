// Mentes: az uj kulcs / sajat jelszo ott is, ahol a kulcsot latod (kanban #414,
// Boss TG 6748: "tedd fel oda, ahol a kulcs van ... hagyd ott, ahol van").
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'backup.js'), 'utf-8')

describe('mentesi kulcs vezerloi (#414)', () => {
  it('a vezerlok a veszhelyzeti lapnal ES a Halado reszben is megvannak', () => {
    expect(js).toContain("keyControlsHtml('kit')")
    expect(js).toContain("keyControlsHtml('adv')")
    // Nyitott (kulcs nelkuli) modban is: a kulcs attol meg letezik.
    expect(js).not.toMatch(/open \? '' : '<div class="bk-kit-key-controls">/)
  })
  it('a ket peldany mezoi nem utkoznek: a gomb data-kc szerint olvas', () => {
    expect(js).toMatch(/id="bkOwnPw-' \+ where/)
    expect(js).toMatch(/getElementById\('bkRotPw-' \+ kc\)/)
    expect(js).toMatch(/getElementById\('bkOwnPw-' \+ kc\)/)
    expect(js).not.toMatch(/id="bkOwnPw"/)
  })
})

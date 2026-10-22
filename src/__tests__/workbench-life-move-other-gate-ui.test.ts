// #736: the "Move to the Life tree" window gives every document of the folder its own "Already sent" box and a clear
// "not sent yet, so it does not move" line -- not only the open document.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const js = readFileSync(join(root, 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'lang', 'en.js'), 'utf8')

describe('Költöztetés ablak: minden irat saját "Már elküldtem" kapuja', () => {
  it('a nyitott iratnak és a mappa másik iratának is ugyanaz a doboz készül, saját munkadarab-azonosítóval', () => {
    expect(js).toContain("list.appendChild(gateBox(id, t('workbench.lifemove.gate_unsent')))")
    expect(js).toContain("unsentGate(f.item_id)")
    expect(js).toContain("gateBox(f.item_id, t('workbench.lifemove.gate_unsent_other'")
    // the button posts the mark for the document of ITS box, then reloads the list
    expect(js).toMatch(/'\/api\/workbench\/items\/' \+ encodeURIComponent\(itemId\) \+ '\/sent-mark'/)
  })

  it('a fájl sora nem azt mondja, hogy "marad", hanem hogy miért nem költözik; mindkét nyelven van másik-irat szöveg', () => {
    expect(hu).toContain('"workbench.lifemove.blocked_unsent": "nincs elküldve, ezért nem költözik"')
    expect(hu).toMatch(/"workbench\.lifemove\.gate_unsent_other": ".*\{title\}.*jelöld meg itt/)
    expect(en).toMatch(/"workbench\.lifemove\.gate_unsent_other": ".*\{title\}.*mark it here/)
    expect(hu).not.toContain('nincs elküldve, marad')
  })
})

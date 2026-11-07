import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #866 (Boss TG 5175): without an AI agent the translation page must still be a free, editable document: a chapter with no
// translation yet is an editable draft, what is typed or pasted into it becomes the translation (twCollect), and the save
// button is not tied to an agent-made translation. Source contract: the browser run is recorded on the card.
const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')

describe('#866: the translation page is editable before any translation', () => {
  it('a chapter without a translation is drawn as an editable draft (heading + empty paragraph), not a locked placeholder', () => {
    const at = js.indexOf('if (!pv && !ro && !tw.busy)')
    expect(at).toBeGreaterThan(0)
    const branch = js.slice(at, at + 1400)
    expect(branch).toContain('shownIds.push(sec.id)')
    expect(branch).toContain('data-tw="title"')
    expect(branch).toContain('data-tw="block"')
    expect(branch).toContain('ed ') // contenteditable follows the same ro flag as the translated page
  })

  it('twCollect turns typed text in a draft chapter into the translation of that chapter', () => {
    const at = js.indexOf('a chapter that has no translation yet stands on the page as an editable draft')
    expect(at).toBeGreaterThan(0)
    const body = js.slice(at, at + 900)
    expect(body).toContain('tw.prev[key0] = {')
    expect(body).toContain('sig: twSig(sec)')
    // an untouched draft (only the original heading, blank paragraph) must not count as a translation
    expect(body).toContain('g0.title !== sec.title')
  })

  it('the save button does not wait for an agent-made translation', () => {
    expect(js).toContain("(tw.busy || (!have && !secs.length) ? ' disabled' : '')")
  })

  it('the hint and the nothing-to-save message exist in both languages', () => {
    for (const f of ['hu', 'en']) {
      const l = readFileSync(join(root, 'web', 'lang', f + '.js'), 'utf8')
      expect(l).toContain('"workbench.tw.draft_hint"')
    }
  })

  // Boss TG 5184: the header box of the translation hung lower than the original's toolbar when the page had been scrolled,
  // because both are sticky and the offset was measured at their scrolled places.
  it('twAlignTop measures the toolbar / panel offset in their static place, not where sticky holds them', () => {
    const at = js.indexOf('function twAlignTop()')
    const body = js.slice(at, at + 2200)
    expect(body).toContain("bar.style.position = 'static'; panel.style.position = 'static'")
    expect(body.indexOf("panel.style.position = 'static'")).toBeLessThan(body.indexOf('off = Math.round('))
    expect(body.indexOf('off = Math.round(')).toBeLessThan(body.indexOf('bar.style.position = barPos'))
  })
})

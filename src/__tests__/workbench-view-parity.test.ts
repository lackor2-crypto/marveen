// #531 (owner, TG 8571/8574): the Simple and the Manual view must know exactly the same functions; only the place differs.
// Measured in Chromium on an empty instance (all seven work item kinds, both views, 1500 px): the parts list (add a text,
// add a picture) was reachable only in the Manual view for a document, a drawing, a video, a deck. This pins the rule
// from the page source, so a project panel or a tool added to the Manual head only turns this red.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

function fn(name: string): string {
  const at = src.indexOf(`  function ${name}(`)
  expect(at, `function ${name} exists`).toBeGreaterThan(-1)
  const next = src.indexOf('\n  function ', at + 10)
  return src.slice(at, next === -1 ? undefined : next)
}

/** The Manual view's head: everything drawn between the title row and the first panel. */
function manualHeadActs(): string[] {
  const at = src.indexOf("el.innerHTML = '<div class=\"wb-root\">'")
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('+ capsPanelHtml()', at)
  return Array.from(src.slice(at, end).matchAll(/data-wb-act="([\w-]+)"/g)).map((m) => m[1])
}

function manualPanels(): string[] {
  const at = src.indexOf("el.innerHTML = '<div class=\"wb-root\">'")
  const end = src.indexOf('+ overviewHtml()', at)
  return Array.from(src.slice(at, end).matchAll(/\+ (\w+PanelHtml)\(\)/g)).map((m) => m[1])
}

describe('Simple view knows what the Manual view knows (#531)', () => {
  const tech = fn('simpleTechHtml')
  const simpleOpen = new Set<string>()
  const list = /\[((?:'[a-z]+',?\s*)+)\]\.map\(function \(k\)/.exec(tech)
  it('the technical details list the project tools as one array', () => {
    expect(list).not.toBeNull()
    for (const m of (list?.[1] ?? '').matchAll(/'([a-z]+)'/g)) simpleOpen.add(m[1])
    expect(simpleOpen.size).toBeGreaterThan(5)
  })

  it('every "...-open" project tool of the Manual head is a button of the Simple view too', () => {
    const missing = manualHeadActs()
      .filter((a) => a.endsWith('-open'))
      .map((a) => a.replace(/-open$/, ''))
      // "pd" sits in the Simple head and in the frame top (#756: not repeated in the technical details); the "caps"
      // button is part of the same array.
      .filter((k) => k !== 'pd' && !simpleOpen.has(k))
    expect(missing).toEqual([])
  })

  it('every panel the Manual view draws is drawn by the Simple technical details as well', () => {
    // #756: the folder tree of an open work item is the frame's Projects tab (itemsPanelHtml(true)), not repeated below
    // #757: a panel the frame opens as a popup under its top bar (researchPanelHtml -> researchPopupHtml) is drawn too
    const top = fn('frTopHtml')
    const missing = manualPanels().filter((p) => !tech.includes(`${p}(`) && !fn('simpleHtml').includes(`${p}()`)
      && !(top.includes(`${p.replace(/PanelHtml$/, 'PopupHtml')}()`) && fn(p.replace(/PanelHtml$/, 'PopupHtml')).includes(`${p}()`)))
    expect(missing).toEqual([])
  })

  it('the parts of a work item (add a text / a picture) are reachable in the Simple view for every kind', () => {
    expect(tech).toContain('simpleItemPartsHtml(it)')
    const parts = fn('simpleItemPartsHtml')
    expect(parts).toContain('partsTechHtml()')
    expect(parts).toContain('partsHtml()')
    // the generic result column of the frame draws them itself; the helper must agree with it, or they show twice
    const inline = fn('frDrawsPartsInline')
    expect(inline).toContain('isDocSurface(it)')
    expect(fn('simpleResultHtml')).toContain('partsHtml()')
  })

  it('a document bound to a table / PDF file has no page editor, so its outline (add a chapter) is drawn in the Simple view', () => {
    // measured in Chromium on a document with source_path .xlsx / .pdf: "outline-add-section" was Manual-only
    expect(tech).toContain("isDocSurface(it) && (isTextProfile(it) || !it.source_path) ? '' : outlineHtml()")
  })

  it('the project start view (no work item open) has the assistant chat too, as the Manual view does', () => {
    // measured in Chromium: chat-send / chat-account / chat-setup / chat-side / dict were Manual-only with no work item open
    const start = fn('simpleHtml')
    expect(start).toContain('frChatHtml()')
    const head = fn('simpleHeadHtml')
    expect(head).toContain('data-wb-act="fr-chat"')
    expect(head).toMatch(/if \(!it\) \{[^}]*fr-chat/s)
  })
})

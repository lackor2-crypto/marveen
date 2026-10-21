// The frame's bars grow sideways, and what the owner looks for is on them (Boss, 2026-10-10).
// The behaviour was measured in a real browser on a separate empty instance (see the cards); this pins the structure.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const wb = readFileSync(join(root, 'web', 'workbench.js'), 'utf-8')
const css = readFileSync(join(root, 'web', 'workbench.css'), 'utf-8')

function fn(name: string): string {
  const i = wb.indexOf(`function ${name}(`)
  expect(i, `function ${name} missing`).toBeGreaterThan(-1)
  const next = wb.indexOf('\n  function ', i + 10)
  return wb.slice(i, next > -1 ? next : undefined)
}

describe('frame bars', () => {
  // #534, Boss TG 8748: "Piszkozat PDF / Veglegesites / Forditas melle" stand beside the tabs, not under them.
  it('the document tabs and the action buttons share one row', () => {
    expect(wb).toContain("'<div class=\"wb-sh-doc-bar\">' + head + actions + '</div>' + finalPanel")
    expect(css).toMatch(/\.wb-sh-doc-bar \{ display: flex; flex-wrap: wrap;/)
  })

  // #556, Boss TG 8751: MEASURED -- for a table, a presentation and a note no Finalize button was visible in the
  // frame (it sat only in the "more" panel). It is in the top bar for every kind now.
  it('Finalize is in the frame top bar for every kind, the drafted document too; a finalized item shows Reopen', () => {
    expect(fn('frTopHtml')).toContain('finalizeTopHtml(it)')
    const f = fn('finalizeTopHtml')
    expect(f).toContain('data-wb-act="item-finalize"')
    expect(f).toContain('data-wb-act="item-reopen"')
    expect(f).toContain("it.status === 'done'")
    // Boss TG 8765: the drafted document's own Finalize is in the same top bar (it opens the finalize panel on the page)
    expect(f).toContain('data-wb-act="sh-final"')
    expect(f).toContain("if (cls !== 'wb-fr-tbtn') return ''")
    expect(f).toContain('archived()')
    // the Manual view: in the head of the item (measured: it was only at the very bottom, after scrolling)
    expect(fn('editorPanelHtml')).toContain("finalizeTopHtml(it, 'btn-secondary btn-compact') + '</div>'")
  })

  // #743 (Boss TG 4171): a finalized drafted document had no E-mail button beside "Finalized" (only a Word item had), and its
  // own mail box is locked with the page -- it could not be sent again or to someone else.
  it('a finalized document of every kind has the E-mail button, and it opens the one mail panel', () => {
    expect(fn('finalizeTopHtml')).toContain('isMailDoneItem(it) ? \'<button type="button" class="\' + cls + \'" data-wb-act="docx-mail-open"')
    const m = fn('isMailDoneItem')
    expect(m).toContain('isDocxDoneItem(it)')
    expect(m).toContain("it.type === 'document' && !it.source_path && it.status === 'done'")
    expect(fn('noteFinalPanelHtml')).toContain('isMailDoneItem(it) && !archived()) return docxMailPanelHtml(it)')
    // the drafted document's draft travels in its outline
    expect(fn('docxMailPanelHtml')).toContain('WB.detail.outline.mail_draft')
  })

  // #557 (Boss TG 8744 / 8759 / 8793): MEASURED in Chromium -- the dashboard's own `header { display: flex; height:
  // 64px }` rule reached Univer's <header>; the grid's toolbar got 56px of 990 and folded every button into its
  // overflow menu ("three dots"). With the rule undone: 20 buttons on screen in two rows, no overflow button.
  it('the grid toolbar is fully on screen: the dashboard header rule is undone for it, rows wrap, no second undo / redo', () => {
    expect(css).toMatch(/\.wb-univer-el header \{ display: block; position: relative; top: auto; padding: 0; height: auto;/)
    expect(css).toMatch(/\.wb-univer-el header > \.univer-invisible \{ display: none !important; \}/)
    expect(css).toMatch(/\.wb-univer-el header \[data-u-comp="ribbon-toolbar"\] \{ flex-wrap: wrap;/)
    expect(css).toContain('[data-u-command="univer.command.undo"]')
    expect(css).toContain('[data-u-command="univer.command.redo"]')
  })
})

// #542 (owner, 2026-10-10): in the Documents panel "open" did nothing useful -- it was a plain link to the raw
// file (a download in a new tab), not wired to "open it in the machine's own program" (#529) like the file list.
// Measured in Chromium on an isolated instance: with the marker the click asks the server to open the file and
// says so; when the server cannot, the reason is shown and the browser link is used.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('Documents panel: "open" opens the file like the file list does (#542)', () => {
  it('every "open" link of the panel carries the path the open-on-machine handler reads', () => {
    const lines = src.split('\n').filter((l) => l.includes("t('workbench.pd.open_file')"))
    expect(lines.length).toBe(3)
    for (const l of lines) expect(l).toMatch(/data-wb-open-rel="' \+ escA\((d\.life_rel|f\.rel)\) \+ '" href="\/api\/life\/file\?rel=/)
  })

  it('the handler that reads the marker is there, and falls back to the link with the reason', () => {
    expect(src).toContain("var a = e.target.closest('a[data-wb-open-rel]')")
    expect(src).toContain("window.showToast(r.message || t('intezo.open_local_failed'))")
    expect(src).toContain("window.open(a.getAttribute('href'), '_blank', 'noopener')")
  })
})

// #657: the project tree shows the folder nesting unambiguously. The real web/workbench.js renders a box with a folder,
// a subfolder and files at both levels; every row carries the depth of its folder path, and the CSS gives each level a
// fixed indent plus Explorer-style guide lines (one per ancestor level and an elbow into the row).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { workbenchHarness, itemsBody, PROJECT } from './helpers/workbench-harness.js'

const BOX = 'Munkadarabok'
const W = BOX + '/Wohngeld'
const V = W + '/Vitazt'

async function rendered() {
  const h = workbenchHarness()
  h.respond((url) => {
    if (/\/api\/workbench\/items\?project=/.test(url)) {
      return {
        status: 200,
        body: {
          ...itemsBody([]),
          work_folders: { box: BOX, folders: [W, V], files: { [W]: [{ name: 'root-file.docx', rel: W + '/root-file.docx' }], [V]: [{ name: 'nested-file.pdf', rel: V + '/nested-file.pdf' }] } },
        },
      }
    }
    return { status: 200, body: {} }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await new Promise((r) => setTimeout(r, 50))
  return h.html()
}

function depthOf(html: string, text: string): number {
  const rows = html.split('<li ').filter((r) => r.includes(text))
  const row = rows[rows.length - 1] || ''
  const m = /wb-depth-(\d)/.exec(row)
  return m ? Number(m[1]) : -1
}

describe('the project tree shows how deep a row is nested (#657)', () => {
  it('folder rows and the files in them step one level at a time, the root file is NOT level with the nested one', async () => {
    const html = await rendered()
    const folder = depthOf(html, '📁 Wohngeld')
    const sub = depthOf(html, '📁 Vitazt')
    const rootFile = depthOf(html, 'root-file.docx')
    const nestedFile = depthOf(html, 'nested-file.pdf')
    expect(folder).toBeGreaterThan(0)
    expect(sub).toBe(folder + 1)
    expect(rootFile).toBe(folder + 1)
    expect(nestedFile).toBe(sub + 1)
    expect(nestedFile).not.toBe(rootFile)
  })

  it('the folder name still opens and closes the folder (#515)', async () => {
    const html = await rendered()
    expect(html).toContain('data-wb-act="folder-fold"')
  })

  it('CSS: a fixed step per level, a guide line per ancestor level and an elbow; the other panel is left alone', () => {
    const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')
    for (let d = 1; d <= 8; d++) expect(css).toContain('.wb-depth-' + d + ' { --wb-d: ' + d + '; margin-left: min(' + 12 * d + 'px, ' + 4 * d + '%); }')
    expect(css).toMatch(/\[class\*="wb-depth-"\]::before \{[^}]*repeating-linear-gradient/)
    expect(css).toMatch(/\[class\*="wb-depth-"\]::after \{[^}]*height: 1px/)
    expect(css).toContain('.wb-fr-panel [class*="wb-depth-"]::before')
  })
})

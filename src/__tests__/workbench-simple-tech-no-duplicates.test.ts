// #756 (Boss TG 4338, 4370): the Simple view's Technical details do not repeat what the frame above already shows --
// no "send for approval" anywhere (1B), no second Finalize, no folder tree when a work item is open (the Projects tab
// is it), no project / work item name and no materials in its Context, no Documents button among its tools. The
// project overview tiles stay (2A).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')

function fn(name: string): string {
  const at = js.indexOf(`  function ${name}(`)
  expect(at, `function ${name} exists`).toBeGreaterThan(-1)
  const next = js.indexOf('\n  function ', at + 10)
  return js.slice(at, next === -1 ? undefined : next)
}

describe('Simple view technical details without duplicates (#756)', () => {
  const tech = fn('simpleTechHtml')

  it('"send for approval" is gone from both views, with its texts', () => {
    expect(js).not.toContain('approval-submit')
    expect(hu).not.toContain('"workbench.approval.submit"')
    expect(en).not.toContain('"workbench.approval.submit"')
    expect(hu).not.toContain('"workbench.approval.intro"')
    expect(en).not.toContain('"workbench.approval.intro"')
  })

  it('the Manual view keeps its Finalize and a pending request can still be decided', () => {
    const box = fn('approvalBoxHtml')
    expect(box).toContain('data-wb-act="item-finalize"')
    expect(box).toContain('data-wb-act="approval-approve"')
    expect(fn('editorPanelHtml')).toContain('approvalBoxHtml()')
  })

  it('the technical details draw the approval box only for a pending request', () => {
    expect(tech).toContain("(it.status === 'review' ? approvalBoxHtml() : '')")
  })

  it('the Documents tool is not repeated among the tools', () => {
    const list = /\[((?:'[a-z]+',?\s*)+)\]\.map\(function \(k\)/.exec(tech)
    expect(list).not.toBeNull()
    expect(list![1]).not.toContain("'pd'")
    expect(fn('frTopHtml')).toContain('data-wb-act="pd-open"')
  })

  it('no folder tree below, the Context without names and materials; the overview stays (2A)', () => {
    expect(tech).toContain("grp('workbench.sh.tech_project', overviewHtml() + contextPanelHtml(true))")
    expect(tech).not.toContain('itemsPanelHtml(')
    expect(fn('frPanelBodyHtml')).toContain('itemsPanelHtml(true)')
    const ctx = fn('contextPanelHtml')
    expect(ctx).toContain("(inFrame ? '' : '<p>' + esc(WB.project ? WB.project.name : '-')")
    expect(ctx).toContain('if (!inFrame) rows.push(assetsBlockHtml())')
    expect(ctx).toContain('projectPrivacyHtml()')
    expect(ctx).toContain('itemPrivacyHtml()')
    expect(ctx).toContain('sharedBlockHtml(')
  })

  it('with no work item open the tree is on top, in a left column (Boss TG 4376)', () => {
    const start = fn('simpleHtml')
    expect(start).toContain('<aside class="wb-fr-panel wb-sh-tree"')
    expect(start).toContain('itemsPanelHtml(true)')
    const css = readFileSync(join(process.cwd(), 'web', 'workbench.css'), 'utf8')
    expect(css).toMatch(/\.wb-sh-start-tree \{ display: flex;/)
  })
})

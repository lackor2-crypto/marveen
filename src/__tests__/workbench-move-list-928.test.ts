import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #928 (Boss TG 6456): the "Move to folder..." lists held every system subfolder of every work item,
// so the person's folder and its "Social office" folder were buried ~150 rows down and looked missing.
const src = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')

function load(): (wf: unknown, items: unknown[]) => string[] {
  const m = src.match(/function moveTargetFolders\(wf\) \{[\s\S]*?\n  \}\n/)
  if (!m) throw new Error('moveTargetFolders missing')
  // the REAL list from the source, so a standard folder added there is covered here too
  const s = src.match(/var STD_FOLDERS = (\{[\s\S]*?\})\n/)
  if (!s) throw new Error('STD_FOLDERS missing')
  const std = s[1]
  // eslint-disable-next-line no-new-func
  return new Function('wf', 'items', `var STD_FOLDERS=${std};var WB={items:items};${m[0]};return moveTargetFolders(wf)`) as never
}

describe('move target list (#928)', () => {
  const box = 'Munkadarabok'
  const folders = [
    `${box}/Korpás László`,
    `${box}/Korpás László/5000 euros`,
    `${box}/Korpás László/5000 euros/Agent`,
    `${box}/Korpás László/5000 euros/Mellékletek`,
    `${box}/Korpás László/Szocialis hivatal`,
    `${box}/Korpás László/Szocialis hivatal/Mellékletek`, // the group's own plain folder named like a standard one
    `${box}/Korpás László/5000 euros/Verziók`,
    `${box}/Korpás László/5000 euros/Feladási bizonylatok`,
    `${box}/Korpás László/5000 euros/Proofs of submission`,
  ]
  const items = [{ folder: `${box}/Korpás László/5000 euros` }]

  it('keeps the groups, drops the work items standard subfolders and versions', () => {
    const out = load()({ folders, own_folders: [] }, items)
    expect(out).toContain(`${box}/Korpás László`)
    expect(out).toContain(`${box}/Korpás László/Szocialis hivatal`)
    expect(out).toContain(`${box}/Korpás László/5000 euros`)
    expect(out).not.toContain(`${box}/Korpás László/5000 euros/Agent`)
    expect(out).not.toContain(`${box}/Korpás László/5000 euros/Mellékletek`)
    expect(out).not.toContain(`${box}/Korpás László/5000 euros/Verziók`)
    expect(out).not.toContain(`${box}/Korpás László/5000 euros/Feladási bizonylatok`)
    expect(out).not.toContain(`${box}/Korpás László/5000 euros/Proofs of submission`)
    // a folder named like a standard one but NOT inside a work item's folder stays (no hidden rule)
    expect(out).toContain(`${box}/Korpás László/Szocialis hivatal/Mellékletek`)
  })

  it('both move lists use it and the current folder stays visible', () => {
    expect(src).toMatch(/moveTargetFolders\(wf\)\.forEach\(function \(f\)/)
    expect(src).toMatch(/moveTargetFolders\(wf\)\.forEach\(function \(g\)/)
    expect(src).toContain("t('workbench.folder.move_here')")
    for (const l of ['hu', 'en']) expect(readFileSync(join(__dirname, `../../web/lang/${l}.js`), 'utf8')).toContain('"workbench.folder.move_here"')
  })

  it('the "+ New work" folder pick list uses it too (same ~150-row list, same root cause)', () => {
    const m = src.match(/function folderPickHtml\(pickOnly\) \{[\s\S]*?\n  \}\n/)
    if (!m) throw new Error('folderPickHtml missing')
    expect(m[0]).toMatch(/moveTargetFolders\(wf\)\.forEach\(function \(f\)/)
    expect(m[0]).not.toMatch(/\(wf\.folders \|\| \[\]\)\.forEach/)
  })
})

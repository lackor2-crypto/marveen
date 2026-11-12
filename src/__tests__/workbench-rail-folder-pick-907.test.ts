/**
 * #907: the left column's "new work item" popover (Simple view) offers the folder/group choice AND the
 * "create group" box, so a new work item lands in the right place without moving it afterwards. The start view
 * leaves its own picker out while the popover is open (one `wbNewFolder` id on screen), and a typed intake
 * name/text survives the re-render a new group causes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('rail popover folder choice (#907)', () => {
  it('the popover form always carries the picker, with the group box in the Simple view', () => {
    const f = js.slice(js.indexOf('function newFormHtml()'), js.indexOf('function loadTemplates()'))
    expect(f).toContain("hasFolderSystem() ? '<div class=\"wb-new-folder\">' + folderPickHtml(!isSimple())")
    expect(f).not.toContain('simpleIntakeOn')
  })
  it('the start view leaves its picker out while the popover is open', () => {
    expect(js).toContain("hasFolderSystem() && !WB.formOpen ? '<div class=\"wb-sh-folder\">'")
  })
  it('opening the form drops a stale pick in every view, and a new group keeps the typed intake', () => {
    expect(js).toContain("dropStalePick(); WB.newDraft = null")
    const mk = js.slice(js.indexOf('function makeFolder()'), js.indexOf('function deleteFolder('))
    expect(mk).toContain('intakeReadDraft()')
    expect(mk).toContain("getElementById('wbIntakeName')")
  })
})

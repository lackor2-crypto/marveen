// #530 (Boss TG 2833/2845): the files lying in the work items' folders are listed in the Documents panel,
// read only and counted; "Attachment" is a role of the add chooser and asks which submission it goes to.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const BASE = { docs: [], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], places: [], ai_access: 'normal', ai_access_modes: ['normal', 'read_all'] }
const FILES = {
  files: [
    { rel: 'Iroda/Beadvany/beadvany.docx', name: 'beadvany.docx', item_id: 'i1', item: 'Beadvany', sub: '', size: 10, mtime: 1760000000 },
    { rel: 'Iroda/Beadvany/Mellekletek/szerzodes.pdf', name: 'szerzodes.pdf', item_id: 'i1', item: 'Beadvany', sub: 'Mellekletek', size: 20, mtime: 1760000100 },
  ],
  truncated: false,
}

async function open(itemFiles: unknown, items: unknown[] = []) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/api/workbench/project-docs')) return { status: 200, body: { ...BASE, item_files: itemFiles } }
    return { status: 200, body: itemsBody(items) }
  })
  h.win.MarvinWorkbench.open('p1', 'Iroda')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
  h.click({ 'data-wb-act': 'pd-open' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.group.files'))
  return h
}

describe('Munkadarab-mappak fajljai az Iratokban', () => {
  it('lists each file once, read only, with its work item and sub-folder, and counts them', async () => {
    const h = await open(FILES)
    const html = h.html()
    expect(html).toContain('beadvany.docx')
    expect(html).toContain('szerzodes.pdf')
    expect(html).toContain('Mellekletek')
    expect(html).toContain('⟦workbench.pd.file_of:{"item":"Beadvany"}⟧')
    expect(html).toContain('workbench.pd.group.files⟧: 2')
    expect(html).not.toContain('data-wb-pd-remove')
  })

  it('no file yet: says so, count 0', async () => {
    const h = await open({ files: [], truncated: false })
    const html = h.html()
    expect(html).toContain('⟦workbench.pd.files_none⟧')
    expect(html).toContain('workbench.pd.group.files⟧: 0')
  })
})

describe('Melleklet szerep', () => {
  it('the role chooser offers Attachment and then asks which submission', async () => {
    const h = await open(FILES, [{ id: 'i1', title: 'Beadvany', type: 'document', status: 'draft' }])
    expect(h.html()).toContain('⟦workbench.pd.role.attachment⟧')
    expect(h.html()).not.toContain('id="wbPdTarget"')
    h.change('wbPdRole', [], 'attachment')
    await vi.waitFor(() => expect(h.html()).toContain('id="wbPdTarget"'))
    expect(h.html()).toContain('Beadvany')
  })
})

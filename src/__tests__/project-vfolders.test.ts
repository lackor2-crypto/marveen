// Virtualis mappak a projekt Otletlada / Vitaztatas / Hatteranyag fulein (kanban #359).
//
//   - a mappa projektenkent es fulenkent kulonall, a nev kis-nagybetu nelkul egyedi,
//   - a mappa torlese az elemeket NEM torli, csak "Nincs mappaban" lesznek,
//   - a javaslat csak a mappa nelkuli elemeket kerdezi, ismeretlen id-t eldob,
//     a meglevo mappara a meglevo nevet irja vissza; semmit nem ment,
//   - az alkalmazas letrehozza a hianyzo mappat es athelyezi az elemet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-vfstore-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, APP_LANG: 'hu' }
})

const askAiJson = vi.fn()
vi.mock('../life-inbox-ai.js', () => ({ askAiJson: (...a: unknown[]) => askAiJson(...a) }))

const { initDatabase } = await import('../db.js')
const vf = await import('../project-vfolders.js')

beforeEach(() => {
  initDatabase(':memory:')
  vf._resetVFolderTablesForTests()
  askAiJson.mockReset()
})

describe('project virtual folders', () => {
  it('creates, renames and keeps names unique per project and tab', () => {
    const a = vf.createVFolder('p1', 'idea', '  Tőzsdei   fejlesztési ötletek ')
    expect(a.ok && a.folder.name).toBe('Tőzsdei fejlesztési ötletek')
    expect(vf.createVFolder('p1', 'idea', 'tőzsdei FEJLESZTÉSI ötletek')).toEqual({ ok: false, code: 'vfolder_exists' })
    expect(vf.createVFolder('p1', 'debate', 'Tőzsdei fejlesztési ötletek').ok).toBe(true)
    expect(vf.createVFolder('p2', 'idea', 'Tőzsdei fejlesztési ötletek').ok).toBe(true)
    expect(vf.createVFolder('p1', 'idea', '   ')).toEqual({ ok: false, code: 'vfolder_name_required' })
    const b = vf.createVFolder('p1', 'idea', 'Marvin')
    if (!a.ok || !b.ok) throw new Error('setup')
    expect(vf.renameVFolder('p1', 'idea', b.folder.id, 'tőzsdei fejlesztési ötletek')).toEqual({ ok: false, code: 'vfolder_exists' })
    expect(vf.renameVFolder('p1', 'idea', b.folder.id, 'Marvin fejlesztési ötletek').ok).toBe(true)
    expect(vf.renameVFolder('p2', 'idea', b.folder.id, 'x')).toEqual({ ok: false, code: 'vfolder_missing' })
    expect(vf.listVFolders('p1', 'idea').folders.map((f) => f.name)).toEqual(['Marvin fejlesztési ötletek', 'Tőzsdei fejlesztési ötletek'])
  })

  it('moves items and releases them when the folder is deleted', () => {
    const a = vf.createVFolder('p1', 'debate', 'Büntető')
    const b = vf.createVFolder('p1', 'debate', 'Válóper')
    if (!a.ok || !b.ok) throw new Error('setup')
    expect(vf.assignVFolder('p1', 'debate', 's1', a.folder.id).ok).toBe(true)
    expect(vf.assignVFolder('p1', 'debate', 's2', a.folder.id).ok).toBe(true)
    expect(vf.assignVFolder('p1', 'debate', 's2', b.folder.id).ok).toBe(true)
    expect(vf.assignVFolder('p1', 'idea', 's3', a.folder.id)).toEqual({ ok: false, code: 'vfolder_missing' })
    expect(vf.listVFolders('p1', 'debate').items).toEqual({ s1: a.folder.id, s2: b.folder.id })
    expect(vf.deleteVFolder('p1', 'debate', a.folder.id)).toEqual({ ok: true, released: 1 })
    expect(vf.listVFolders('p1', 'debate')).toMatchObject({ items: { s2: b.folder.id } })
    expect(vf.assignVFolder('p1', 'debate', 's2', null).ok).toBe(true)
    expect(vf.listVFolders('p1', 'debate').items).toEqual({})
  })

  it('suggests only for unsorted items and never saves', async () => {
    const a = vf.createVFolder('p1', 'idea', 'Marvin fejlesztési ötletek')
    if (!a.ok) throw new Error('setup')
    vf.assignVFolder('p1', 'idea', 'i0', a.folder.id)
    askAiJson.mockImplementation(async (_s: string, prompt: string, parse: (j: any) => unknown) => {
      expect(prompt).not.toContain('id i0')
      expect(prompt).toContain('Marvin fejlesztési ötletek')
      return { engine: 'claude', model: 'm', reason: '', value: parse({ items: [
        { id: 'i1', folder: 'marvin FEJLESZTÉSI ötletek', reason: 'r' },
        { id: 'i2', folder: 'Tőzsdei ötletek' },
        { id: 'i3', folder: null },
        { id: 'ghost', folder: 'X' },
      ] }) }
    })
    const out = await vf.suggestVFolders('p1', 'P', 'idea', [
      { id: 'i0', title: 'már mappában' }, { id: 'i1', title: 'a' }, { id: 'i2', title: 'b' }, { id: 'i3', title: 'c' },
    ], 'hu')
    expect(out).toEqual({ ok: true, engine: 'claude:m', plan: [
      { id: 'i1', folder: 'Marvin fejlesztési ötletek', isNew: false, reason: 'r' },
      { id: 'i2', folder: 'Tőzsdei ötletek', isNew: true, reason: '' },
    ] })
    expect(vf.listVFolders('p1', 'idea').folders).toHaveLength(1)
  })

  it('reports nothing to sort and a missing AI in human codes', async () => {
    expect(await vf.suggestVFolders('p1', 'P', 'idea', [], 'hu')).toEqual({ ok: false, code: 'nothing_to_sort' })
    askAiJson.mockResolvedValue({ engine: 'none', model: '', value: null, reason: 'no_ai' })
    expect(await vf.suggestVFolders('p1', 'P', 'idea', [{ id: 'i1', title: 'a' }], 'hu')).toEqual({ ok: false, code: 'no_ai' })
  })

  it('applies the ticked rows, creating missing folders once', () => {
    const out = vf.applyVFolderPlan('p1', 'research', [
      { id: 'a/x.md', folder: 'Jog' }, { id: 'a/y.md', folder: 'jog' }, { id: '', folder: 'Z' }, { id: 'a/z.md', folder: '' },
    ])
    expect(out).toEqual({ ok: true, moved: 2, created: 1 })
    const st = vf.listVFolders('p1', 'research')
    expect(st.folders.map((f) => f.name)).toEqual(['Jog'])
    expect(Object.keys(st.items).sort()).toEqual(['a/x.md', 'a/y.md'])
  })

  it('forgets a deleted project folders only', () => {
    vf.applyVFolderPlan('p1', 'idea', [{ id: 'i1', folder: 'A' }])
    vf.applyVFolderPlan('p2', 'idea', [{ id: 'i1', folder: 'A' }])
    vf.forgetProjectVFolders('p1')
    expect(vf.listVFolders('p1', 'idea')).toEqual({ folders: [], items: {} })
    expect(vf.listVFolders('p2', 'idea').folders).toHaveLength(1)
  })
})

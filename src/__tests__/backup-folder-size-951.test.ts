// #951: the backup map's folder-size column. Measured in the background, cached, never "0" for an unreadable folder,
// symlinks not followed; the column and its polling exist on the page.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderSize, measureFolder, resetFolderSizes } from '../backup-folder-size.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)) }

describe('measureFolder / folderSize (#951)', () => {
  it('sums files in sub-folders, ignores symlinks', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bfs951-'))
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    writeFileSync(join(d, 'x'), '12345'); writeFileSync(join(d, 'a', 'b', 'y'), '123')
    const out = mkdtempSync(join(tmpdir(), 'bfs951o-')); writeFileSync(join(out, 'big'), 'x'.repeat(1000))
    symlinkSync(out, join(d, 'link'))
    expect(await measureFolder(d)).toEqual({ bytes: 8, files: 2 })
    rmSync(d, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true })
  })
  it('first ask answers "measuring" at once, then the cached number; an unreadable folder is failed, not zero', async () => {
    resetFolderSizes()
    const d = mkdtempSync(join(tmpdir(), 'bfs951-'))
    writeFileSync(join(d, 'x'), '1234')
    expect(folderSize('k', d).state).toBe('measuring')
    await until(() => folderSize('k', d).state === 'done')
    expect(folderSize('k', d)).toMatchObject({ state: 'done', bytes: 4, files: 1 })
    expect(folderSize('none', null)).toMatchObject({ state: 'failed', bytes: null })
    folderSize('gone', join(d, 'nope'))
    await until(() => folderSize('gone', join(d, 'nope')).state === 'failed')
    expect(folderSize('gone', join(d, 'nope'))).toMatchObject({ state: 'failed', bytes: null })
    rmSync(d, { recursive: true, force: true })
  })
})

describe('the column is wired (#951)', () => {
  it('route, page column, polling and both languages', () => {
    expect(src('../web/routes/backup-rules.ts')).toContain("path === '/api/backup-rules/sizes'")
    const app = src('../../web/app.js')
    expect(app).toContain('data-bk-size')
    expect(app).toContain('_bkLoadSizes(tbl)')
    for (const f of ['hu', 'en']) {
      const l = src(`../../web/lang/${f}.js`)
      for (const k of ['backup.map_col_size', 'backup.size_measuring', 'backup.size_failed', 'backup.size_at']) expect(l).toContain(`'${k}'`)
    }
  })
  it('no sync fs in the size module', () => {
    expect(src('../backup-folder-size.ts')).not.toMatch(/Sync\(/)
  })
})

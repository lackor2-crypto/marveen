import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// #918 (owner reports TG 6269/6273/6292): the dashboard froze for 3.2 s inside POST /api/workbench/files-delete. The stall
// sampler's stack was deleteLooseFiles -> listWorkFolders -> drainSteps -> statSync: the file actions walked the whole folder
// tree SYNCHRONOUSLY inside the request. The handler must list with the yielding walk and pass the listing in.
describe('#918 file actions do not walk the folder tree synchronously in a request', () => {
  const assets = readFileSync(join(process.cwd(), 'src/workbench-assets.ts'), 'utf-8')
  const routes = readFileSync(join(process.cwd(), 'src/web/routes/workbench.ts'), 'utf-8')

  const body = (name: string): string => {
    const i = assets.search(new RegExp(`export (async )?function ${name}\\(`))
    expect(i, name).toBeGreaterThan(-1)
    const next = assets.slice(i + 10).search(/\nexport (async )?function /)
    return assets.slice(i, next < 0 ? undefined : i + 10 + next)
  }

  for (const fn of ['moveLooseFiles', 'deleteLooseFiles', 'renameLooseFile', 'adviseUploadPlaces']) {
    it(`${fn} uses the listing it is given and only falls back to the synchronous walk without one`, () => {
      const b = body(fn)
      expect(b).toContain('listed?: WorkFoldersListing')
      expect(b).toContain('listed ?? listWorkFolders(project, { outside: false })')
      expect(b.replace('listed ?? listWorkFolders(project, { outside: false })', '')).not.toContain('listWorkFolders(project')
    })
  }

  it('copyLooseFiles (already async) lists with the yielding walk', () => {
    const b = body('copyLooseFiles')
    expect(b).toContain('await listWorkFoldersYielding(project, { outside: false })')
    expect(b).not.toMatch(/[^g]listWorkFolders\(project/)
  })

  it('the request handlers hand the yielding listing to every one of these actions', () => {
    const Y = 'await listWorkFoldersYielding(project, { outside: false })'
    for (const call of ['moveLooseFiles(project', 'deleteLooseFiles(project', 'renameLooseFile(project', 'adviseUploadPlaces(project']) {
      const i = routes.indexOf(call)
      expect(i, call).toBeGreaterThan(-1)
      const line = routes.slice(i, routes.indexOf('\n', i))
      expect(line, call).toContain(Y)
    }
  })
})

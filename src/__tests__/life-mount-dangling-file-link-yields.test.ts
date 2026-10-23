// #716: a file moved to the Life tree leaves a link at its old place. When the Life-tree copy is gone later (trashed)
// and a NEW file with the same name is put at the old place, the dangling link must not hide the real file.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-dangling-link-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-dangling-link-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot, resolveLifePath } = await import('../life-explorer.js')
const { addMount } = await import('../life-mounts.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temporary depot')

describe('a dangling file link', () => {
  mkdirSync(join(root, 'Old'), { recursive: true })
  mkdirSync(join(root, 'Life'), { recursive: true })
  writeFileSync(join(root, 'Life', 'a.txt'), 'x')
  const added = addMount({ rel: 'Old/a.txt', target: 'Life/a.txt', kind: 'local', label: 'a.txt', file: true })

  it('was linked', () => { expect(added.ok).toBe(true) })
  it('still resolves to the Life-tree copy while that exists', () => {
    expect(resolveLifePath('Old/a.txt')).toMatch(/Life\/a\.txt$/)
  })
  it('lets a real file at the old place win once the Life-tree copy is gone', () => {
    writeFileSync(join(root, 'Old', 'a.txt'), 'new')
    require_unlink(join(root, 'Life', 'a.txt'))
    expect(resolveLifePath('Old/a.txt')).toMatch(/Old\/a\.txt$/)
  })
})

import { unlinkSync } from 'node:fs'
function require_unlink(p: string): void { unlinkSync(p) }

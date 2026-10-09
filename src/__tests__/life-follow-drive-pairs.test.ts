// Drive backup pairs follow a folder rename (#510): the hook must not rot silently.
//
// life-follow.ts reaches moveSyncPairsPrefix through a lazy import and treats a
// missing export as "nothing to move". That keeps the module light, but a typo
// or a rename of the export would then skip the Drive pairs with no error at
// all. This pins both ends of the wire: the export exists and is a function,
// and life-follow.ts asks for exactly that name from exactly that module.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('life-follow -> drive-sync hook', () => {
  it('drive-sync exports moveSyncPairsPrefix as a function', async () => {
    const mod = await import('../web/routes/drive-sync.js')
    expect(typeof (mod as Record<string, unknown>).moveSyncPairsPrefix).toBe('function')
  })

  it('life-follow.ts loads that module and calls that export by name', () => {
    const src = readFileSync(join(__dirname, '..', 'life-follow.ts'), 'utf8')
    expect(src).toContain("import('./web/routes/drive-sync.js')")
    expect(src).toContain('moveSyncPairsPrefix')
  })
})

import { describe, it, expect } from 'vitest'
import { which, warmWhich, resetToolCache } from '../life-inbox-systools.js'

describe('#894 warmWhich: async PATH probe fills the cache the sync which() reads', () => {
  it('finds a real tool and records a missing one as null, same as the sync lookup', async () => {
    resetToolCache()
    await warmWhich(['node', 'definitely-not-a-tool-894'])
    const p = which('node')
    expect(p).toBeTruthy()
    expect(which('definitely-not-a-tool-894')).toBeNull()
  })
})

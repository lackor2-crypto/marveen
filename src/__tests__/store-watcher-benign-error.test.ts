import { describe, expect, it } from 'vitest'
import { isBenignWatchError } from '../store-watcher.js'

describe('isBenignWatchError', () => {
  it('accepts the unwatchable-entry errors of the recursive watcher', () => {
    const e = Object.assign(new Error("EACCES: permission denied, watch '/x'"), { syscall: 'watch', code: 'EACCES' })
    expect(isBenignWatchError(e)).toBe(true)
    expect(isBenignWatchError({ syscall: 'watch', code: 'ENOENT' })).toBe(true)
  })
  it('does not swallow other errors', () => {
    expect(isBenignWatchError({ syscall: 'open', code: 'EACCES' })).toBe(false)
    expect(isBenignWatchError({ syscall: 'watch', code: 'EMFILE' })).toBe(false)
    expect(isBenignWatchError(new Error('boom'))).toBe(false)
    expect(isBenignWatchError(null)).toBe(false)
  })
})

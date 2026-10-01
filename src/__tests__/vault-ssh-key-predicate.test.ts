// #456 (rebuilt from upstream 82a403bf): ssh-key-<id> is never a generic vault value.
import { describe, it, expect } from 'vitest'
import { isSshPrivateKeyId } from '../web/vault-acl.js'

describe('isSshPrivateKeyId', () => {
  it('matches the ssh-key- prefix, also with surrounding spaces', () => {
    expect(isSshPrivateKeyId('ssh-key-abc')).toBe(true)
    expect(isSshPrivateKeyId('  ssh-key-abc')).toBe(true)
  })
  it('does not match ordinary secrets or the sub-resource names', () => {
    expect(isSshPrivateKeyId('github-token')).toBe(false)
    expect(isSshPrivateKeyId('ssh-keys')).toBe(false)
    expect(isSshPrivateKeyId('my-ssh-key-x')).toBe(false)
    expect(isSshPrivateKeyId('')).toBe(false)
  })
})

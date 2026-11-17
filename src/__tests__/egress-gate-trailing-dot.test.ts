// #932 (upstream egress-gate-internal-names, the parts that apply here): an internal target spelled with a
// trailing dot is the same host for the resolver, so the egress gate must refuse it like the dotless spelling.
// Before the fix the last label was empty, matched no internal suffix, and `http://localhost./` went through.
// Every case has a public control, so a gate that refuses everything cannot pass. (This fork already refuses
// every IPv6 literal, so the mapped-address cases of the upstream test are not asserted.)
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { isEgressBlocked, isInternalHost } from '../../scripts/hooks/egress-gate.mjs'

const blocked = (url: string) => isEgressBlocked('WebFetch', { url })

describe('egress gate: trailing-dot internal names', () => {
  it('refuses a trailing-dot internal name the same as without the dot', () => {
    expect(blocked('http://localhost/')).toBe(true)
    expect(blocked('http://localhost./')).toBe(true)
    expect(blocked('http://printer.local/')).toBe(true)
    expect(blocked('http://printer.local./')).toBe(true)
    expect(blocked('http://metadata.internal./latest')).toBe(true)
  })

  it('refuses a trailing-dot IPv4 literal in a private or loopback range', () => {
    expect(blocked('http://127.0.0.1./')).toBe(true)
    expect(blocked('http://10.1.2.3./x')).toBe(true)
    expect(blocked('http://169.254.169.254./latest/meta-data')).toBe(true)
  })

  it('refuses a dotless name and a bare dot', () => {
    expect(blocked('http://intranet/')).toBe(true)
    expect(isInternalHost('.')).toBe(true)
    expect(isInternalHost('')).toBe(true)
  })

  it('lets a public name through with or without the trailing dot (control)', () => {
    expect(blocked('https://example.com/')).toBe(false)
    expect(blocked('https://example.com./')).toBe(false)
    expect(blocked('https://93.184.216.34./')).toBe(false)
  })
})

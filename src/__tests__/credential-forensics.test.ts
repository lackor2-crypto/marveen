import { describe, it, expect } from 'vitest'
import { summarizeCredentials, describeChange, pastSunset, SUNSET_MS } from '../web/credential-forensics.js'

const file = (a: string, r: string, exp = 1, rexp = 2) =>
  JSON.stringify({ claudeAiOauth: { accessToken: a, refreshToken: r, expiresAt: exp, refreshTokenExpiresAt: rexp } })

describe('credential forensics (temporary, sunset 2027-01-16)', () => {
  it('summarizes shape without ever carrying token values', () => {
    const s = summarizeCredentials(file('secret-access', 'secret-refresh'))
    expect(s).toEqual({ state: 'present', accessLen: 13, refreshLen: 14, expiresAt: 1, refreshExpiresAt: 2 })
    expect(JSON.stringify(s)).not.toContain('secret')
  })
  it('tells the emptied file from a missing and a broken one', () => {
    expect(summarizeCredentials(file('', '', 0, 5)).state).toBe('empty')
    expect(summarizeCredentials(null).state).toBe('missing')
    expect(summarizeCredentials('{nope').state).toBe('unreadable')
    expect(summarizeCredentials('{}').state).toBe('empty')
  })
  it('names the transition into the emptied state', () => {
    const good = summarizeCredentials(file('a', 'b'))
    const bad = summarizeCredentials(file('', ''))
    expect(describeChange(undefined, good)).toBe('baseline')
    expect(describeChange(good, bad)).toBe('present -> empty')
    expect(describeChange(good, good)).toBeNull()
    expect(describeChange(good, summarizeCredentials(file('a', 'b', 9)))).toBe('access token rotated')
  })
  it('stops itself at the sunset date', () => {
    expect(pastSunset(SUNSET_MS - 1)).toBe(false)
    expect(pastSunset(SUNSET_MS)).toBe(true)
  })
})

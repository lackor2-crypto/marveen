// Card #683: the Overview "WSL swap" item is only green when a readable
// .wslconfig really sets a swap size (owner decision: swap=2GB, memory left to
// the owner / WSL default).
import { describe, it, expect } from 'vitest'
import { parseSizeGb, parseWslConfig, classifyWslConfig } from '../wsl-memory.js'

describe('wsl-memory', () => {
  it('parses sizes with units', () => {
    expect(parseSizeGb('2GB')).toBe(2)
    expect(parseSizeGb('8192MB')).toBe(8)
    expect(parseSizeGb('4G')).toBe(4)
    expect(parseSizeGb('lots')).toBeUndefined()
  })

  it('reads only the [wsl2] section and ignores comments', () => {
    const c = parseWslConfig('[boot]\nswap=99GB\n[wsl2]\n# memory=1GB\nswap=2GB ; x\nmemory=10GB\n')
    expect(c).toEqual({ swapGb: 2, memoryGb: 10 })
  })

  it('is ok with a swap line alone, missing without one, and missing when the file is absent', () => {
    expect(classifyWslConfig('[wsl2]\nswap=2GB\n')).toBe('ok')
    expect(classifyWslConfig('[wsl2]\nmemory=10GB\n')).toBe('missing')
    expect(classifyWslConfig('[wsl2]\nmemory=10GB\nswap=8GB\n')).toBe('risky')
    expect(classifyWslConfig('[wsl2]\nswap=4GB\n')).toBe('ok')
    expect(classifyWslConfig(null)).toBe('missing')
  })
})

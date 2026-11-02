// #823 (C): a failing key function (PDF creation, finalizing) is told to the owner on the channel, throttled, 5xx only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertKeyFunctionFailure, KEY_ALERT_COOLDOWN_MS, _resetKeyFunctionAlert } from '../key-function-alert.js'

describe('key function failure alert (#823 C)', () => {
  beforeEach(() => _resetKeyFunctionAlert())

  it('tells a system failure (5xx) with the function, the code and the real detail', async () => {
    const send = vi.fn(async (_t: string) => 'sent')
    expect(await alertKeyFunctionFailure('finalize', 'docpdf_failed', 500, 'soffice exited 1', send, 1000)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    const text = String(send.mock.calls[0][0])
    expect(text).toContain('docpdf_failed')
    expect(text).toContain('soffice exited 1')
  })

  it('stays silent for the owner\'s own content state (4xx)', async () => {
    const send = vi.fn(async (_t: string) => 'sent')
    expect(await alertKeyFunctionFailure('pdf', 'docpdf_annex_missing', 409, null, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('one message per function+code in the cooldown, a different code or a later time sends again', async () => {
    const send = vi.fn(async (_t: string) => 'sent')
    expect(await alertKeyFunctionFailure('pdf', 'docpdf_timeout', 504, null, send, 10_000)).toBe(true)
    expect(await alertKeyFunctionFailure('pdf', 'docpdf_timeout', 504, null, send, 20_000)).toBe(false)
    expect(await alertKeyFunctionFailure('pdf', 'docpdf_failed', 500, null, send, 20_000)).toBe(true)
    expect(await alertKeyFunctionFailure('pdf', 'docpdf_timeout', 504, null, send, 10_000 + KEY_ALERT_COOLDOWN_MS)).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('a failing channel does not break the request (returns false)', async () => {
    const send = vi.fn(async (_t: string) => { throw new Error('telegram down') })
    expect(await alertKeyFunctionFailure('table_finalize', 'table_final_failed', 500, null, send)).toBe(false)
  })

  it('the shared failure gate and the table finalize call it (source contract)', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf-8')
    expect(src).toMatch(/function docPdfFail[\s\S]{0,900}alertKeyFunctionFailure\(isFinalize \? 'finalize' : 'pdf'/)
    expect(src).toMatch(/alertKeyFunctionFailure\('table_finalize'/)
    expect(src).toMatch(/docPdfFail\([^\n]*outline: outlineOut\(item\.id\) \}, true\)/)
  })
})

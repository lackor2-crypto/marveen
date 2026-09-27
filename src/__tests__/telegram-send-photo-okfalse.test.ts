// #413 rebuild of TSOKFALSE827 (upstream 1abd56ab): the provider's own
// sendPhoto (fetch path) keeps the honest-send contract too. The upstream
// telegram-send-okfalse test (kept byte-identical) covers only the https path.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getProvider } = await import('../channel-provider.js')

describe('telegramProvider.sendPhoto: HTTP 200 + ok:false rejects', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('rejects ok:false, resolves ok:true and a malformed 200 body', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const img = join(mkdtempSync(join(tmpdir(), 'okfalse-')), 'a.png')
    writeFileSync(img, Buffer.from([0x89, 0x50]))
    const reply = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
    reply(200, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')
    await expect(getProvider('telegram').sendPhoto('tok', '1', img, 'c')).rejects.toThrow(/Telegram API 400: ok:false/)
    reply(200, '{"ok":true}')
    await expect(getProvider('telegram').sendPhoto('tok', '1', img, 'c')).resolves.toBeUndefined()
    reply(200, 'not json')
    await expect(getProvider('telegram').sendPhoto('tok', '1', img, 'c')).resolves.toBeUndefined()
  })
})

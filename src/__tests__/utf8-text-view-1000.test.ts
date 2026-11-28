// A utf-8 text file opened from a blob: address showed broken accented letters (Chromium reads a text/markdown blob as
// windows-1252). The view path adds a byte order mark; a download keeps the file's bytes. The real-browser proof is
// tests/browser/utf8-text-view.spec.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const app = readFileSync(join(root, 'web/app.js'), 'utf8')
const workbench = readFileSync(join(root, 'web/workbench.js'), 'utf8')

function viewBlob(): (b: Blob) => Promise<Blob> {
  const src = /const utf8ViewBlob = (async \(blob\) => \{[\s\S]*?\n  \})\n/.exec(app)
  expect(src, 'utf8ViewBlob is missing from web/app.js').not.toBeNull()
  return new Function('return ' + src![1])() as (b: Blob) => Promise<Blob>
}
const bytes = async (b: Blob) => Array.from(new Uint8Array(await b.arrayBuffer()))

describe('viewing a utf-8 text blob', () => {
  it('puts a byte order mark in front of a utf-8 text file, also when the type carries no charset', async () => {
    const out = await viewBlob()(new Blob(['é'], { type: 'text/markdown' }))
    expect(await bytes(out)).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9])
    expect(out.type).toBe('text/markdown;charset=utf-8')
  })
  it('leaves other files and non utf-8 text untouched', async () => {
    for (const src of [new Blob(['x'], { type: 'application/pdf' }), new Blob(['x'], { type: 'image/png' }), new Blob([new Uint8Array([0xe9])], { type: 'text/plain' })]) {
      expect(await viewBlob()(src)).toBe(src)
    }
  })
  it('is used by every place that opens a fetched file in a tab, and not for downloads', () => {
    expect(app).toContain('URL.createObjectURL(download ? blob : await utf8ViewBlob(blob))')
    expect(app).toContain('URL.createObjectURL(await window._utf8ViewBlob(await res.blob()))')
    expect(workbench).toContain('return view ? window._utf8ViewBlob(raw) : raw')
  })
})

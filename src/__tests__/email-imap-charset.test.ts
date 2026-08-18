import { describe, it, expect } from 'vitest'
import { simpleParser } from 'mailparser'
import { declareSniffedHtmlCharset } from '../web/email-imap.js'

// Shapes modelled on the real-world message that exposed this (an Outlook /
// Exchange-generated multipart/alternative, 8bit text/html part with no
// charset= and a windows-1250 <meta http-equiv>), never captured verbatim.

const CRLF = '\r\n'
function msg(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'latin1')
}

describe('declareSniffedHtmlCharset', () => {
  it('writes the sniffed charset into a text/html part that declares none', () => {
    const out = declareSniffedHtmlCharset(msg([
      'Content-Type: text/html',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1250"/></head>',
      '<body>\xC9rtes\xEDt\xE9s</body></html>',
      '',
    ])).toString('latin1')
    expect(out).toContain('Content-Type: text/html; charset="windows-1250"')
    // Byte-for-byte untouched outside the header it repaired.
    expect(out).toContain('<body>\xC9rtes\xEDt\xE9s</body>')
  })

  it('makes mailparser decode the part correctly end to end', async () => {
    const raw = msg([
      'Content-Type: text/html',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1250"/></head>',
      '<body>\xC9rtes\xEDt\xE9s \xF5r</body></html>',
      '',
    ])
    const before = await simpleParser(raw, { skipHtmlToText: true })
    expect(before.html).toContain('�') // today's damage, for the record
    const after = await simpleParser(declareSniffedHtmlCharset(raw), { skipHtmlToText: true })
    expect(after.html).toContain('Értesítés őr')
  })

  it('repairs only the mislabelled part of a multipart message', () => {
    const out = declareSniffedHtmlCharset(msg([
      'Content-Type: multipart/alternative;',
      '\tboundary="----=_NextPart_000"',
      '',
      '------=_NextPart_000',
      'Content-Type: text/plain;',
      '\tcharset="iso-8859-2"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '\xC9rtes\xEDt\xE9s',
      '------=_NextPart_000',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<html><meta charset="windows-1250"><body>\xC9rtes\xEDt\xE9s</body></html>',
      '------=_NextPart_000--',
      '',
    ])).toString('latin1')
    expect(out).toContain('Content-Type: text/html; charset="windows-1250"')
    expect(out).toContain('Content-Type: multipart/alternative;')
    expect(out).toContain('charset="iso-8859-2"' + CRLF + 'Content-Transfer-Encoding')
  })

  it('leaves a part that already declares a charset alone, folded header included', () => {
    const folded = msg([
      'Content-Type: text/html;',
      '\tcharset="iso-8859-2"',
      '',
      '<html><meta charset="windows-1250"></html>',
      '',
    ])
    expect(declareSniffedHtmlCharset(folded).equals(folded)).toBe(true)
  })

  it('leaves a part alone when nothing can be sniffed', () => {
    const base64 = msg([
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      'PGh0bWw+PGJvZHk+w4lydGVzw610w6lzPC9ib2R5PjwvaHRtbD4=',
      '',
    ])
    expect(declareSniffedHtmlCharset(base64).equals(base64)).toBe(true)

    const plain = msg(['Content-Type: text/plain; charset="utf-8"', '', 'szia', ''])
    expect(declareSniffedHtmlCharset(plain).equals(plain)).toBe(true)
  })

  it('ignores a Content-Type line that only appears inside body text', () => {
    const decoy = msg([
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Content-Type: text/html',
      '',
      '<meta charset="windows-1250">',
      '',
    ])
    expect(declareSniffedHtmlCharset(decoy).equals(decoy)).toBe(true)
  })
})

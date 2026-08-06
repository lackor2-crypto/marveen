import { describe, it, expect } from 'vitest'
import { selectBodyParts, enumerateAttachments } from '../web/email-imap.js'
import type { MessageStructureObject } from 'imapflow'

// Synthetic BODYSTRUCTURE trees modelled on real-world shapes (per the
// implementation plan), never captured from a real mailbox.

describe('selectBodyParts', () => {
  it('single-part text/plain message: itself is the body', () => {
    const root: MessageStructureObject = { part: '1', type: 'text/plain', size: 120 }
    expect(selectBodyParts(root)).toEqual({ textPart: '1', htmlPart: null })
  })

  it('multipart/alternative: picks best text/plain and text/html children', () => {
    const root: MessageStructureObject = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', size: 80 },
        { part: '2', type: 'text/html', size: 400 },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: '1', htmlPart: '2' })
  })

  it('multipart/related: first child is the body root (alternative text+html), rest are inline resources', () => {
    const root: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 80 },
            { part: '1.2', type: 'text/html', size: 500 },
          ],
        },
        { part: '2', type: 'image/png', disposition: 'inline', id: '<logo>', size: 5000 },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: '1.1', htmlPart: '1.2' })
  })

  it('multipart/mixed with a leading alternative body and a trailing PDF attachment', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 80 },
            { part: '1.2', type: 'text/html', size: 500 },
          ],
        },
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' }, size: 90_000 },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: '1.1', htmlPart: '1.2' })
  })

  it('a text/plain part WITH a filename/attachment disposition is not treated as the body', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' }, size: 200 },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: null, htmlPart: null })
  })

  it('never descends into a message/rfc822 node (forwarded mail as attachment)', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 50 },
        {
          part: '2',
          type: 'message/rfc822',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [{ part: '2.1', type: 'text/plain', size: 999 }],
        },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: '1', htmlPart: null })
  })

  it('multipart/signed (PGP/SMIME): first child subtree is the body, signature part ignored', () => {
    const root: MessageStructureObject = {
      type: 'multipart/signed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 300 },
        { part: '2', type: 'application/pgp-signature', dispositionParameters: { filename: 'signature.asc' }, size: 800 },
      ],
    }
    expect(selectBodyParts(root)).toEqual({ textPart: '1', htmlPart: null })
  })
})

describe('enumerateAttachments', () => {
  it('body-part leaves are excluded from the id sequence entirely', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 80 },
            { part: '1.2', type: 'text/html', size: 500 },
          ],
        },
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' }, size: 90_000 },
      ],
    }
    const body = selectBodyParts(root)
    const attachments = enumerateAttachments(root, body)
    expect(attachments).toEqual([
      { id: '1', filename: 'invoice.pdf', mime: 'application/pdf', size: 90_000, inline: false },
    ])
  })

  it('matches the himalaya example: 1=attachment, 2=attachment, 3=inline, 4=attachment -- ids stable, inline included', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 }, // body, excluded from numbering
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, size: 1000 },
        { part: '3', type: 'application/zip', disposition: 'attachment', dispositionParameters: { filename: 'b.zip' }, size: 2000 },
        { part: '4', type: 'image/png', disposition: 'inline', id: '<sig>', size: 3000 },
        { part: '5', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'c.pdf' }, size: 4000 },
      ],
    }
    const body = selectBodyParts(root)
    const attachments = enumerateAttachments(root, body)
    expect(attachments.map(a => a.id)).toEqual(['1', '2', '3', '4'])
    expect(attachments.map(a => a.inline)).toEqual([false, false, true, false])
    const visibleOnly = attachments.filter(a => !a.inline)
    expect(visibleOnly.map(a => a.id)).toEqual(['1', '2', '4'])
  })

  it('a forwarded message/rfc822 is one opaque attachment leaf, its internals are not separately numbered', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 50 },
        {
          part: '2',
          type: 'message/rfc822',
          dispositionParameters: { filename: 'forwarded.eml' },
          size: 12_000,
          childNodes: [
            { part: '2.1', type: 'text/plain', size: 999 },
            { part: '2.2', type: 'application/pdf', dispositionParameters: { filename: 'nested.pdf' }, size: 5000 },
          ],
        },
      ],
    }
    const body = selectBodyParts(root)
    const attachments = enumerateAttachments(root, body)
    expect(attachments).toEqual([
      { id: '1', filename: 'forwarded.eml', mime: 'message/rfc822', size: 12_000, inline: false },
    ])
  })

  it('base64-encoded attachment size is corrected down from the encoded (BODYSTRUCTURE) size', () => {
    const root: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'video/mp4', disposition: 'attachment', dispositionParameters: { filename: 'clip.mp4' }, encoding: 'base64', size: 27_000_000 },
      ],
    }
    const body = selectBodyParts(root)
    const [attachment] = enumerateAttachments(root, body)
    // 27,000,000 * 57/78 ~= 19,730,769 -- decoded is meaningfully smaller than encoded
    expect(attachment!.size).toBeLessThan(27_000_000)
    expect(attachment!.size).toBeGreaterThan(19_000_000)
    expect(attachment!.size).toBeLessThan(20_500_000)
  })

  it('no attachments: empty array, not an error', () => {
    const root: MessageStructureObject = { part: '1', type: 'text/plain', size: 40 }
    const body = selectBodyParts(root)
    expect(enumerateAttachments(root, body)).toEqual([])
  })
})

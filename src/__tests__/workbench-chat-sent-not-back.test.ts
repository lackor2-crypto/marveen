// Boss TG 4006 (second time after TG 3608): a message that was sent must not stay in, or come back into, the chat field.
// Whatever writes it back (dictation, a phone keyboard's composition, autofill), one shared gate empties it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchHarness } from './helpers/workbench-harness.js'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const strip = (value: string, sent: string, programmatic = false) => {
  const h = workbenchHarness()
  return (h.win as unknown as { _wbChatEchoStrip: (v: string, s: string, p: boolean) => string | null })._wbChatEchoStrip(value, sent, programmatic)
}

describe('chat: the sent text is an echo only when it is exactly the sent text', () => {
  it('the same text written back empties the field', () => {
    expect(strip('Szia, ez egy uzenet', 'Szia, ez egy uzenet')).toBe('')
    expect(strip('Szia, ez egy uzenet\n', 'Szia, ez egy uzenet')).toBe('')
  })
  it('the sent text with new typing after it keeps only the new typing', () => {
    expect(strip('Szia, ez egy uzenet uj', 'Szia, ez egy uzenet')).toBe('uj')
  })
  it('a different text is never touched', () => {
    expect(strip('Teljesen mas', 'Szia, ez egy uzenet')).toBeNull()
    expect(strip('', 'Szia')).toBeNull()
    expect(strip('Szia', '')).toBeNull()
  })
  it('a fragment of the sent text is an echo only when a script wrote it (dictation), never typing', () => {
    expect(strip('ez egy', 'Szia, ez egy uzenet', true)).toBe('')
    expect(strip('ez egy', 'Szia, ez egy uzenet', false)).toBeNull()
  })
})

describe('chat: the gate sits on every send and on the field', () => {
  it('sendChat records the sent text before it clears the field, on both the queued and the direct path', () => {
    const send = js.slice(js.indexOf('function sendChat()'), js.indexOf('function injectChatMessage'))
    expect(send.indexOf('chatNoteSent(text)')).toBeGreaterThan(0)
    expect(send.indexOf('chatNoteSent(text)')).toBeLessThan(send.indexOf("el.value = ''"))
    expect(send.indexOf('chatNoteSent(text)')).toBeLessThan(send.indexOf('withAttachedLine('))
  })
  it('the input listener runs the guard before the draft is copied from the field', () => {
    expect(js).toContain("if (e.target.id === 'wbChatInput') { chatGuardInput(e); WB.chatDraft = e.target.value }")
  })
  it('real typing, pasting or deleting switches the guard off, so the same text can be sent again (no hidden limit)', () => {
    expect(js).toContain('insertText|insertFromPaste|insertFromDrop|insertLineBreak|insertParagraph|delete')
  })
  it('a late writer without an input event is caught by the timed re-check', () => {
    expect(js).toContain('[60, 300, 900, 2200].forEach(function (ms) { setTimeout(chatDropEcho, ms) })')
  })
})

describe('chat: sending ends a running dictation of the field (the screenshot of TG 4006 shows the mic still on)', () => {
  it('both send paths (Enter, the Send button) abort the recognizer instead of stop(), which would deliver late words', () => {
    expect(js).toContain('function dictAbortForSend()')
    expect(js).toContain('d.rec.abort()')
    expect(js).toContain("else if (a === 'chat-send') { dictAbortForSend(); sendChat() }")
    expect(js).toContain('      dictAbortForSend()\n      sendChat()')
    expect(js).not.toContain('if (WB.dict) dictStop(); sendChat()')
  })
  it('an aborted session writes nothing on end', () => {
    expect(js).toContain('if (d.aborted) return\n      dictApply(d, d.finals)')
  })
})

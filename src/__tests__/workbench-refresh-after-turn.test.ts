// Owner law (2026-11-22): when the assistant finishes an answer in the chat, the open work item is re-read from the server
// (the whole item including its outline), so the owner never has to press F5 / Ctrl+Shift+R to see the change.
// Bug: refreshSelectedAfterTurn() only reloaded the PREVIEW for an item with a file, so a document the agent changed
// through the outline API stayed on the old text in the editor.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const body = (name: string): string => {
  const at = js.indexOf('function ' + name + '(')
  expect(at).toBeGreaterThan(-1)
  return js.slice(at, js.indexOf('\n  }\n', at))
}

describe('the open work item is refreshed after every chat turn', () => {
  it('an item with a file is refreshed through the live refresh (item + outline), not the preview alone', () => {
    const b = body('refreshSelectedAfterTurn')
    expect(b).toContain('scheduleLiveRefresh()')
    expect(b).not.toMatch(/else loadPreview\(/)
  })
  it('the live refresh redraws the item it just read, so the new outline shows at once', () => {
    const b = body('scheduleLiveRefresh')
    expect(b.indexOf('WB.detail = r.data')).toBeGreaterThan(-1)
    expect(b.indexOf('render()')).toBeGreaterThan(b.indexOf('WB.detail = r.data'))
    expect(b.indexOf('render()')).toBeLessThan(b.indexOf('loadPreview('))
  })
  it('both paths that end a turn (finished stream and the watched answer) call the refresh', () => {
    expect(body('finishChatTurn')).toContain('refreshSelectedAfterTurn()')
    expect(body('reloadChatHistory')).toContain('refreshSelectedAfterTurn()')
  })
})

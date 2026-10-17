// #687: the side and account dropdowns of the chat are remembered per project on the server, also after F5.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')
const route = readFileSync(join(__dirname, '../web/routes/workbench-agent.ts'), 'utf8')

describe('chat dropdown memory', () => {
  it('saves a pick at once (not only on send), for both dropdowns', () => {
    expect(js).toMatch(/WB\.chatSide = sideSel\.value; saveChatPrefs\(\{ side: sideSel\.value \}\)/)
    expect(js).toMatch(/saveChatPrefs\(\{ account: sel\.value \}\)/)
    expect(js).toContain("'/api/workbench/agent/chat-prefs'")
  })
  it('starts from the project\'s saved account and never carries the previous project\'s', () => {
    expect(js).toMatch(/WB\.chatAccount = ''[^\n]*\n/)
    expect(js).toContain('r.data.account_pref')
  })
  it('the server returns the saved account and has the save route', () => {
    expect(route).toContain('account_pref:')
    expect(route).toContain("'/api/workbench/agent/chat-prefs' && method === 'POST'")
  })
})

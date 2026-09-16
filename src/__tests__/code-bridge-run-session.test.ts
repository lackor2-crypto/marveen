// Kartya 15e9476a (#276): a dashboard futas KOZBEN azt a chat-fult jelolje
// zolden, amiben a VS Code TENYLEGESEN dolgozik. Egy friss (startFresh) futas
// uj beszelgetest nyit, a `session_id` viszont a claim-kori regi fult nevezi
// meg -- a jelzes eddig igy egy idegen fulre esett. A worker a heartbeatben
// jelenti a futas fulet (`runSessionId`); ez a keszlet ezt a szerzodest vedi.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  heartbeatCodeTask, getCodeTask, lastAgentRunSession, codeBridgeActivity, effectiveRunSessionId,
} from '../web/code-bridge-store.js'

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const NEW = 'dddddddd-0000-4000-8000-000000000009'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  upsertCodeSession({ project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: OLD })
})

function claimFresh() {
  enqueueCodeTask({ project: 'marvin', prompt: 'csinald meg' })
  const t = claimNextCodeTask('w')!
  expect(t.startFresh).toBe(true)
  return t
}

describe('futas kozbeni ful (#276)', () => {
  it('friss futas jelentes nelkul: NEM a regi fult nevezi meg (nulla = nem latjuk)', () => {
    claimFresh()
    expect(codeBridgeActivity().running[0]!.sessionId).toBeNull()
    const run = lastAgentRunSession('marvin')
    expect(run?.running ?? false).toBe(false)
  })

  it('a heartbeatben jelentett ful lesz a zold "most itt dolgozik"', () => {
    const t = claimFresh()
    expect(heartbeatCodeTask(t.id, 'w', Date.now(), NEW)).toBe(true)
    expect(getCodeTask(t.id)!.runSessionId).toBe(NEW)
    expect(getCodeTask(t.id)!.sessionId).toBe(OLD) // a lezaro atallitas ehhez hasonlit
    expect(codeBridgeActivity().running[0]!.sessionId).toBe(NEW)
    expect(lastAgentRunSession('marvin')).toMatchObject({ sessionId: NEW, running: true })
  })

  it('ervenytelen vagy hianyzo azonosito nem ir felul semmit', () => {
    const t = claimFresh()
    heartbeatCodeTask(t.id, 'w', Date.now(), NEW)
    heartbeatCodeTask(t.id, 'w', Date.now(), 'nem-uuid; drop table')
    heartbeatCodeTask(t.id, 'w', Date.now())
    expect(getCodeTask(t.id)!.runSessionId).toBe(NEW)
  })

  it('folytatasnal a claim-kori ful maga a futas helye', () => {
    expect(effectiveRunSessionId({ sessionId: OLD, runSessionId: null, startFresh: false })).toBe(OLD)
    expect(effectiveRunSessionId({ sessionId: OLD, runSessionId: null, startFresh: true })).toBeNull()
    expect(effectiveRunSessionId({ sessionId: OLD, runSessionId: NEW, startFresh: true })).toBe(NEW)
  })
})

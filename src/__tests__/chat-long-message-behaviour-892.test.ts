// #892 -- behaviour test (the source-text test in chat-message-limit-100k.test.ts only greps the constants).
//
// Boss, TG 5799: a project chat message of 12 916 characters was answered with
// "prompt too long (12916 > 12000)". Here the REAL path is run: a long message goes
// through buildCodeBridgePrompt (what the Workbench chat sends) and then through
// enqueueCodeTask (what refuses it), at the reported size and at the new limit.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const tmpStore = vi.hoisted(() => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'marveen-892-')) as string)
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: tmpStore }))

import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, PROMPT_MAX_CHARS,
} from '../web/code-bridge-store.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
  upsertCodeSession({ project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
  recordCodeWorkerSeen('windows', 'discovery', 1)
  recordCodeCandidates('windows', [])
})

const chatPrompt = (message: string, history: { role: string; content: string }[] = []) =>
  buildCodeBridgePrompt({ projectName: 'marveen', projectFolder: '/tmp/p', workItem: null, history, message, lang: 'hu' })

describe('#892: a long project-chat message is accepted end to end', () => {
  it('the reported 12 916-character message is queued (was refused: 12916 > 12000)', () => {
    const r = enqueueCodeTask({ project: 'marveen', prompt: 'x'.repeat(12_916), origin: 'api' })
    expect('task' in r).toBe(true)
  })

  it('a 12 916-character chat message built by the Workbench prompt builder is queued, whole text kept in a file', () => {
    const message = 'á'.repeat(12_916)
    const prompt = chatPrompt(message)
    const r = enqueueCodeTask({ project: 'marveen', prompt, origin: 'workbench', chatId: 'c1' })
    expect('task' in r).toBe(true)
    const file = /saved in the file (\S+\.txt)/.exec(prompt)?.[1]
    expect(file).toBeTruthy()
    expect(readFileSync(file!, 'utf8')).toBe(message)
  })

  it('a message at the 100 000 limit with a full history still builds a prompt the bridge accepts', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'ő'.repeat(20_000) }))
    const prompt = chatPrompt('é'.repeat(PROMPT_MAX_CHARS), history)
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS)
    expect('task' in enqueueCodeTask({ project: 'marveen', prompt, origin: 'workbench', chatId: 'c2' })).toBe(true)
  })

  it('the bridge takes exactly 100 000 characters and refuses one more, telling the real limit', () => {
    expect('task' in enqueueCodeTask({ project: 'marveen', prompt: 'y'.repeat(100_000), origin: 'api' })).toBe(true)
    const over = enqueueCodeTask({ project: 'marveen', prompt: 'y'.repeat(100_001), origin: 'api' })
    expect(over).toMatchObject({ errorKey: 'cb.err.prompt_too_long', errorParams: { len: 100_001, max: 100_000 } })
  })
})

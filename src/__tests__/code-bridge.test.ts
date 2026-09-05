// Contract tests for the VS Code Claude Code bridge.
//
// The failure this suite exists to prevent is a task running in the WRONG
// session: a refactor meant for the trading project landing in Marvin's own
// conversation, or a fresh session being spun up that knows nothing about the
// project. Everything else here (leases, summaries, command parsing) protects
// the second failure mode -- a dispatched task that silently never comes back.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createApproval, createKanbanCard,
  createOrResetApprovalVerification, resolveApprovalVerification,
} from '../db.js'
import {
  resetCodeBridgeTablesForTests,
  normalizeAlias, aliasFromWorkspacePath,
  upsertCodeSession, listCodeSessions, getCodeSession, deleteCodeSession, resolveProject,
  enqueueCodeTask, claimNextCodeTask, completeCodeTask, heartbeatCodeTask,
  getCodeTask, getCodeTaskByPrefix, listCodeTasks, latestCodeTaskForProject, cancelCodeTask,
  reapExpiredCodeLeases, failOrphanedCodeTasks, matchesExcluded, summarizeResult, formatDuration,
  LEASE_MS, MAX_ATTEMPTS, PROMPT_MAX_CHARS, ORPHAN_GRACE_MS,
} from '../web/code-bridge-store.js'
import { parseCommand, splitProjectAndPrompt, isAllowedChat, chunkMessage, handleCodeCommand } from '../web/code-bridge-telegram.js'
import { buildCompletionMessage, shortId } from '../web/code-bridge-notify.js'

const MARVIN = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const TRADING = { project: 'tradingbot', workspacePath: 'D:\\Tozsde_telepitesi_mappa', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }
const FREE = { project: 'freeberischeaper', workspacePath: 'C:\\ws\\freeber', sessionId: 'cccccccc-0000-4000-8000-000000000003' }

function seedThree(): void {
  upsertCodeSession(MARVIN)
  upsertCodeSession(TRADING)
  upsertCodeSession(FREE)
}

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('project aliases', () => {
  it('folds what a phone keyboard produces onto one alias', () => {
    expect(normalizeAlias('  TradingBot ')).toBe('tradingbot')
    expect(normalizeAlias('Trading Bot!')).toBe('tradingbot')
    expect(normalizeAlias('my-proj_2')).toBe('my-proj_2')
  })

  it('derives a default alias from the workspace folder name', () => {
    expect(aliasFromWorkspacePath('d:\\Tozsde_telepitesi_mappa')).toBe('tozsde_telepitesi_mappa')
    expect(aliasFromWorkspacePath('/home/boss/marveen/')).toBe('marveen')
  })
})

describe('session map', () => {
  it('addresses several sessions at once -- there is no single current session', () => {
    seedThree()
    expect(listCodeSessions().map((s) => s.project)).toEqual(['freeberischeaper', 'marvin', 'tradingbot'])
    expect(getCodeSession('tradingbot')!.sessionId).toBe(TRADING.sessionId)
    expect(getCodeSession('marvin')!.sessionId).toBe(MARVIN.sessionId)
  })

  it('resolves a unique prefix but refuses an ambiguous one', () => {
    seedThree()
    upsertCodeSession({ project: 'tradingdesk', workspacePath: 'C:\\ws\\desk', sessionId: 'dddd' })
    const ok = resolveProject('freeb')
    expect('session' in ok && ok.session.project).toBe('freeberischeaper')
    const bad = resolveProject('trading')
    expect('error' in bad).toBe(true)
    if ('error' in bad) expect(bad.candidates).toEqual(['tradingbot', 'tradingdesk'])
  })

  // A tu ALAPBOL feltetlen: a felderites nem irhatja felul. Az EGYETLEN kivetel
  // a `repointStale` engedely, amit a route szamol ki merve (lasd lentebb) --
  // ez a teszt szandekosan NEM adja meg, ezert itt a regi viselkedes az igaz.
  it('discovery refreshes a session id but a PIN is never overwritten', () => {
    upsertCodeSession({ ...TRADING, pinned: true })
    upsertCodeSession(
      { project: 'tradingbot', workspacePath: TRADING.workspacePath, sessionId: 'newer-session', transcriptMtime: 999 },
      { fromDiscovery: true },
    )
    expect(getCodeSession('tradingbot')!.sessionId).toBe(TRADING.sessionId)

    upsertCodeSession({ ...MARVIN, pinned: false })
    upsertCodeSession(
      { project: 'marvin', workspacePath: MARVIN.workspacePath, sessionId: 'newer-session', transcriptMtime: 999 },
      { fromDiscovery: true },
    )
    expect(getCodeSession('marvin')!.sessionId).toBe('newer-session')
  })

  it('discovery never moves an alias onto a different workspace', () => {
    upsertCodeSession(TRADING)
    upsertCodeSession(
      { project: 'tradingbot', workspacePath: 'C:\\somewhere\\else', sessionId: 'other', transcriptMtime: 999 },
      { fromDiscovery: true },
    )
    const row = getCodeSession('tradingbot')!
    expect(row.workspacePath).toBe(TRADING.workspacePath)
    expect(row.sessionId).toBe(TRADING.sessionId)
  })

  it('ignores an out-of-order (older) discovery report', () => {
    upsertCodeSession({ ...MARVIN, transcriptMtime: 500 }, { fromDiscovery: true })
    upsertCodeSession({ ...MARVIN, sessionId: 'stale', transcriptMtime: 100 }, { fromDiscovery: true })
    expect(getCodeSession('marvin')!.sessionId).toBe(MARVIN.sessionId)
  })
})

describe('excluded projects', () => {
  it('matches the fenced-off alias however the owner spelled it', () => {
    expect(matchesExcluded('tozsde_telepitesi_mappa', ['Tozsde_Telepitesi_Mappa'])).toBe(true)
    expect(matchesExcluded('TradingBot', [' tradingbot '])).toBe(true)
    expect(matchesExcluded('tradingbot', ['marvin'])).toBe(false)
    // An empty list must not fence off everything -- that would silently kill
    // the whole bridge on a default install.
    expect(matchesExcluded('tradingbot', [])).toBe(false)
    expect(matchesExcluded('', ['tradingbot'])).toBe(false)
  })
})

describe('dispatch routing', () => {
  it('a task claimed for one project carries THAT project session, never another', () => {
    seedThree()
    const queued = enqueueCodeTask({ project: 'tradingbot', prompt: 'fix the SL rounding' })
    expect('task' in queued).toBe(true)
    const claimed = claimNextCodeTask('win-host')!
    expect(claimed.project).toBe('tradingbot')
    expect(claimed.sessionId).toBe(TRADING.sessionId)
    expect(claimed.workspacePath).toBe(TRADING.workspacePath)
    expect(claimed.status).toBe('running')
  })

  it('serves the queue in order, one claim at a time', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'first' })
    enqueueCodeTask({ project: 'freeberischeaper', prompt: 'second' })
    expect(claimNextCodeTask('w')!.project).toBe('marvin')
    expect(claimNextCodeTask('w')!.project).toBe('freeberischeaper')
    expect(claimNextCodeTask('w')).toBeNull()
  })

  it('refuses an unknown project instead of guessing one', () => {
    seedThree()
    const out = enqueueCodeTask({ project: 'nosuchthing', prompt: 'do it' })
    expect('error' in out).toBe(true)
    if ('error' in out) expect(out.candidates).toContain('marvin')
  })

  it('refuses an empty or oversized prompt', () => {
    seedThree()
    expect('error' in enqueueCodeTask({ project: 'marvin', prompt: '   ' })).toBe(true)
    expect('error' in enqueueCodeTask({ project: 'marvin', prompt: 'x'.repeat(PROMPT_MAX_CHARS + 1) })).toBe(true)
  })

  it('stamps the session at CLAIM time, so a repin between queue and start wins', () => {
    seedThree()
    enqueueCodeTask({ project: 'tradingbot', prompt: 'later' })
    upsertCodeSession({ ...TRADING, sessionId: 'repinned-session', pinned: true })
    expect(claimNextCodeTask('w')!.sessionId).toBe('repinned-session')
  })

  it('fails a task loudly when its project lost its mapping -- but only after the grace period', () => {
    seedThree()
    const q = enqueueCodeTask({ project: 'marvin', prompt: 'orphan me' })
    const id = 'task' in q ? q.task.id : ''
    deleteCodeSession('marvin')

    // No worker can run it, but it is not failed on the spot: discovery
    // re-registers sessions every 60s and a restart must not kill the queue.
    expect(claimNextCodeTask('w')).toBeNull()
    expect(getCodeTask(id)!.status).toBe('queued')
    expect(failOrphanedCodeTasks(Date.now())).toHaveLength(0)

    const failed = failOrphanedCodeTasks(Date.now() + ORPHAN_GRACE_MS + 1000)
    expect(failed.map((t) => t.id)).toEqual([id])
    const after = getCodeTask(id)!
    expect(after.status).toBe('error')
    expect(after.error).toMatch(/no registered session/)
  })

  it('never hands out a second task for a session that is already running', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'first' })
    enqueueCodeTask({ project: 'marvin', prompt: 'second' })
    enqueueCodeTask({ project: 'tradingbot', prompt: 'other project' })

    const first = claimNextCodeTask('w1')!
    expect(first.prompt).toBe('first')
    // A second worker asking now must NOT get marvin's next task -- two
    // `--resume` runs on one session would interleave in the same transcript.
    expect(claimNextCodeTask('w2')!.project).toBe('tradingbot')
    expect(claimNextCodeTask('w3')).toBeNull()

    completeCodeTask(first.id, { ok: true, result: 'done' })
    expect(claimNextCodeTask('w1')!.prompt).toBe('second')
  })

  it('an unmappable task does not block the runnable ones behind it', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'orphan me' })
    enqueueCodeTask({ project: 'tradingbot', prompt: 'still runnable' })
    deleteCodeSession('marvin')
    const claimed = claimNextCodeTask('w')
    expect(claimed?.project).toBe('tradingbot')
  })
})

describe('lease / liveness', () => {
  it('re-queues a task whose worker stopped heartbeating', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'long one' })
    const claimed = claimNextCodeTask('w', 1000)!
    const { requeued, failed } = reapExpiredCodeLeases(1000 + LEASE_MS + 1)
    expect(requeued).toEqual([claimed.id])
    expect(failed).toHaveLength(0)
    expect(getCodeTask(claimed.id)!.status).toBe('queued')
  })

  it('a heartbeat keeps the lease alive', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'long one' })
    const claimed = claimNextCodeTask('w', 1000)!
    expect(heartbeatCodeTask(claimed.id, 'w', 1000 + LEASE_MS - 10)).toBe(true)
    expect(reapExpiredCodeLeases(1000 + LEASE_MS + 1).requeued).toEqual([])
  })

  it('a heartbeat from a DIFFERENT host is refused', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'x' })
    const claimed = claimNextCodeTask('host-a')!
    expect(heartbeatCodeTask(claimed.id, 'host-b')).toBe(false)
  })

  it('gives up after MAX_ATTEMPTS instead of looping forever', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'poison' })
    let t = 1000
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      claimNextCodeTask('w', t)
      const reaped = reapExpiredCodeLeases(t + LEASE_MS + 1)
      t += LEASE_MS + 2
      if (i === MAX_ATTEMPTS - 1) {
        expect(reaped.failed).toHaveLength(1)
        expect(reaped.failed[0]!.status).toBe('error')
      }
    }
  })
})

describe('results', () => {
  it('records the result and derives a summary without calling a model', () => {
    seedThree()
    enqueueCodeTask({ project: 'tradingbot', prompt: 'what is the codeword' })
    const claimed = claimNextCodeTask('w')!
    const done = completeCodeTask(claimed.id, { ok: true, result: 'TRADING-BRAVO-42', durationMs: 8099, numTurns: 1, costUsd: 0.0034 })!
    expect(done.status).toBe('done')
    expect(done.summary).toBe('TRADING-BRAVO-42')
    expect(latestCodeTaskForProject('tradingbot')!.id).toBe(claimed.id)
  })

  it('an error result keeps the message and marks the task failed', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'boom' })
    const claimed = claimNextCodeTask('w')!
    const failed = completeCodeTask(claimed.id, { ok: false, error: 'claude.exe produced no output (exit 1)' })!
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/exit 1/)
  })

  it('finds a task by the short id the notification shows', () => {
    seedThree()
    const q = enqueueCodeTask({ project: 'marvin', prompt: 'x' })
    const id = 'task' in q ? q.task.id : ''
    expect(getCodeTaskByPrefix(id.slice(0, 8))!.id).toBe(id)
    expect(getCodeTaskByPrefix('zzzz')).toBeNull()
  })

  it('cancels a queued task but never claims a cancelled one', () => {
    seedThree()
    const q = enqueueCodeTask({ project: 'marvin', prompt: 'nevermind' })
    const id = 'task' in q ? q.task.id : ''
    expect(cancelCodeTask(id)!.status).toBe('cancelled')
    expect(claimNextCodeTask('w')).toBeNull()
  })

  it('lists per project', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'a' })
    enqueueCodeTask({ project: 'tradingbot', prompt: 'b' })
    expect(listCodeTasks({ project: 'tradingbot' })).toHaveLength(1)
    expect(listCodeTasks({})).toHaveLength(2)
  })
})

describe('summarizeResult', () => {
  it('prefers the closing lines -- a run ends with its conclusion', () => {
    const text = ['Let me look at the file.', 'Reading src/app.ts...', 'Fixed the off-by-one in the loop bound.'].join('\n')
    expect(summarizeResult(text)).toContain('off-by-one')
  })

  it('strips markdown scaffolding so the line reads as a sentence', () => {
    expect(summarizeResult('## Done\n- fixed it')).not.toContain('#')
    expect(summarizeResult('## Done\n- fixed it')).not.toContain('- ')
  })

  it('never returns an empty string', () => {
    expect(summarizeResult('   \n\n  ')).toBe('(empty result)')
  })

  it('caps the length', () => {
    expect(summarizeResult('y'.repeat(5000)).length).toBeLessThanOrEqual(280)
  })
})

describe('telegram command surface', () => {
  it('parses a group-suffixed command', () => {
    expect(parseCommand('/code@MarvinCodeBot tradingbot fix it')).toEqual({ command: 'code', args: 'tradingbot fix it' })
    expect(parseCommand('hello')).toBeNull()
  })

  it('splits project from prompt and passes the prompt through verbatim', () => {
    const split = splitProjectAndPrompt('tradingbot  fix   the   SL  rounding')
    expect(split).toEqual({ project: 'tradingbot', tab: null, prompt: 'fix   the   SL  rounding' })
    expect(splitProjectAndPrompt('tradingbot')).toBeNull()
  })

  // A ful-cimzes a projekt UTAN all. A ket hatareset szandekos:
  //  - `#152 kartya` egy VALODI feladat kezdete, nem cimzes (nem hexa/rovid),
  //  - ful-azonosito UTAN kell feladat is, kulonben nincs mit vegrehajtani.
  it('reads an optional #tab id after the project, and only when it looks like one', () => {
    expect(splitProjectAndPrompt('tradingbot #3cfe9212 nezd meg a stopot')).toEqual({
      project: 'tradingbot', tab: '3cfe9212', prompt: 'nezd meg a stopot',
    })
    expect(splitProjectAndPrompt('tradingbot #152 kartya lezarasa')).toEqual({
      project: 'tradingbot', tab: null, prompt: '#152 kartya lezarasa',
    })
    expect(splitProjectAndPrompt('tradingbot #3cfe9212')).toBeNull()
  })

  it('only the allowlisted chat may command a bot that can run code', () => {
    expect(isAllowedChat('123', ['123', '456'], null)).toBe(true)
    expect(isAllowedChat('999', ['123'], '999')).toBe(false)
    expect(isAllowedChat('999', [], '999')).toBe(true)
    expect(isAllowedChat('999', [], null)).toBe(false)
  })

  it('splits a long result instead of truncating it', () => {
    const parts = chunkMessage('x'.repeat(9000), 3800)
    expect(parts.length).toBe(3)
    expect(parts.join('').length).toBe(9000)
  })

  it('never reports a finished task as cancelled', () => {
    seedThree()
    const q = enqueueCodeTask({ project: 'tradingbot', prompt: 'x' })
    const id = 'task' in q ? q.task.id : ''
    const claimed = claimNextCodeTask('w')!
    completeCodeTask(claimed.id, { ok: true, result: 'ready' })

    const answer = handleCodeCommand({ command: 'cancel', args: shortId(id) }, '1', 'owner')!
    expect(answer).not.toMatch(/Torolve/)
    expect(answer).toMatch(/lezarult/)
    expect(getCodeTask(id)!.status).toBe('done')
  })

  it('finds a project in /status however it was typed', () => {
    seedThree()
    enqueueCodeTask({ project: 'tradingbot', prompt: 'running long' })
    claimNextCodeTask('w')
    expect(handleCodeCommand({ command: 'status', args: 'TradingBot' }, '1', 'owner')).toMatch(/tradingbot/)
    expect(handleCodeCommand({ command: 'status', args: 'trading' }, '1', 'owner')).toMatch(/tradingbot/)
  })

  it('says nothing at all to a command that is not ours', () => {
    expect(handleCodeCommand({ command: 'kanban', args: '' }, '1', 'owner')).toBeNull()
  })
})

describe('completion notification', () => {
  it('is programmatic, carries the id needed for /result, and opens with the subject', () => {
    seedThree()
    enqueueCodeTask({ project: 'tradingbot', prompt: 'x' })
    const claimed = claimNextCodeTask('w')!
    const done = completeCodeTask(claimed.id, { ok: true, result: 'Fixed the rounding.', durationMs: 72_000, numTurns: 3 })!
    const msg = buildCompletionMessage(done)
    expect(msg.split('\n')[0]).toContain('Feladat: x')
    expect(msg).toContain('tradingbot')
    expect(msg).toContain('1m 12s')
    expect(msg).toContain('Fixed the rounding.')
    expect(msg).toContain(`/result ${shortId(done.id)}`)
    expect(msg.split('\n').length).toBeLessThanOrEqual(5)
  })

  it('shows the error instead of a summary when the task failed', () => {
    seedThree()
    enqueueCodeTask({ project: 'marvin', prompt: 'x' })
    const claimed = claimNextCodeTask('w')!
    const failed = completeCodeTask(claimed.id, { ok: false, error: 'workspace not found' })!
    expect(buildCompletionMessage(failed)).toContain('workspace not found')
  })

  it('does not print a bare checkmark when the linked approval verification failed', () => {
    seedThree()
    createKanbanCard({ id: 'deadbeef', title: 'Valami javitasa', status: 'waiting' })
    const approvalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    createApproval({
      id: approvalId,
      agent_id: 'code:tradingbot',
      category: 'kanban_done',
      action_description: 'Kartya: Valami javitasa',
      action_payload: JSON.stringify({ kanban_card_id: 'deadbeef' }),
    })
    createOrResetApprovalVerification(approvalId, 'code:tradingbot', 'verify')
    resolveApprovalVerification(approvalId, 'code:tradingbot', 'fail', 'nem jo')

    const prompt = `report back with:\ncurl -s -X POST http://localhost:3420/api/approvals/${approvalId}/verify-result`
    enqueueCodeTask({ project: 'tradingbot', prompt, requestedBy: 'code:tradingbot' })
    const claimed = claimNextCodeTask('w')!
    const done = completeCodeTask(claimed.id, { ok: true, result: 'Megneztem, hibas.' })!
    const msg = buildCompletionMessage(done)
    expect(msg.split('\n')[0]).toContain('Kartya #')
    expect(msg.split('\n')[0]).toContain('Valami javitasa')
    expect(msg).not.toMatch(/^✅/m)
    expect(msg).toContain('FAIL')
  })
})

describe('formatDuration', () => {
  it('reads like a human wrote it', () => {
    expect(formatDuration(8_099)).toBe('8s')
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(null)).toBe('?')
  })
})

/**
 * ELAVULT BEKOTES: a tu tullelte a beszelgetest.
 *
 * A MERT ESET (2026-08-26). A `fejlesztes` projekt a
 * `d34fac5b-523b-4d3e-8c8d-0e4df9ab0ea1` beszelgeteshez volt szogezve; a sora 31
 * oraja nem frissult, mikozben a VS Code-ban ket EGESZEN MAS ful volt nyitva.
 * Minden odakuldott feladat egy bezart beszelgetesbe ment volna. Boss: "a
 * marveen ba beallitott chat fulek nem azonosak a vscode ban levo chat
 * fulekkel. az gaz."
 *
 * A tulaj dontese: atalljon, DE csak ha a bekotott ful tenyleg bezarult. A
 * harom teszt a harom hatart rogziti -- ha barmelyik eldol, vagy a feladat megy
 * megint halott fulbe, vagy a rendszer elhuzza a tulajt a sajat valasztasarol.
 */
describe('elavult bekotes: a tu tulelte a beszelgetest', () => {
  const WS = 'C:\\ws\\TradingBot'

  it('a bezart fulrol ATALL a nyitottra -- ez a javitas lenyege', () => {
    upsertCodeSession({ project: 'p', workspacePath: WS, sessionId: 'bezart', pinned: true })
    upsertCodeSession(
      { project: 'p', workspacePath: WS, sessionId: 'nyitott' },
      { fromDiscovery: true, repointStale: true },
    )
    expect(getCodeSession('p')!.sessionId).toBe('nyitott')
  })

  it('a TU MEGMARAD az atallas utan is -- nem szedjuk le nemaan', () => {
    // Ha az atallas mellekesen leszedne a tut, a kovetkezo felderites mar
    // szabadon rangatna a projektet. Az atallas EGY dontes, nem a zar vege.
    upsertCodeSession({ project: 'p', workspacePath: WS, sessionId: 'bezart', pinned: true })
    upsertCodeSession(
      { project: 'p', workspacePath: WS, sessionId: 'nyitott' },
      { fromDiscovery: true, repointStale: true },
    )
    expect(getCodeSession('p')!.pinned).toBe(true)
  })

  it('MASIK MAPPARA meg engedellyel sem all at -- a mappa-zar erosebb', () => {
    // Az engedely arrol szol, hogy a BESZELGETES halott, nem arrol, hogy a
    // mappa rossz. Egy alias-utkozest tovabbra is a tulaj rendez el.
    upsertCodeSession({ project: 'p', workspacePath: WS, sessionId: 'bezart', pinned: true })
    upsertCodeSession(
      { project: 'p', workspacePath: 'C:\\ws\\Masik', sessionId: 'idegen' },
      { fromDiscovery: true, repointStale: true },
    )
    expect(getCodeSession('p')!.sessionId).toBe('bezart')
    expect(getCodeSession('p')!.workspacePath).toBe(WS)
  })
})

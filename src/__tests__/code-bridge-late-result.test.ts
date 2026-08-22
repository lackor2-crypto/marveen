// Regression tests for the deep/wide bug hunt of 2026-08-22.
//
// The common thread in these findings is that the bridge crosses a machine
// boundary it cannot control: `claude.exe` is already running on Windows when
// the owner cancels, a lease can be reaped while the CLI is still working, and
// the URL/body arriving from the network is whatever someone typed. Every test
// below pins a case where the old code let one of those produce a CONFIDENT
// wrong answer -- a "finished" ping for cancelled work, a stale project count,
// a 500 that blames the server for a bad request.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask,
  claimNextCodeTask, completeCodeTask, completeCodeTaskDetailed, cancelCodeTask,
  getCodeTask, recordCodeWorkerSeen, listCodeWorkers,
} from '../web/code-bridge-store.js'
import { nextBackoffMs } from '../web/code-bridge-telegram.js'
import { buildCompletionMessage } from '../web/code-bridge-notify.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WS = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

function queueOne(prompt = 'do the thing'): string {
  upsertCodeSession(WS)
  const out = enqueueCodeTask({ project: 'marvin', prompt, origin: 'telegram' })
  if ('error' in out) throw new Error(out.error)
  return out.task.id
}

// ---------------------------------------------------------------------------
// F1 -- a result must never rewrite a status the owner has already been told
// ---------------------------------------------------------------------------

describe('late result', () => {
  it('does NOT resurrect a task the owner cancelled', () => {
    // The CLI has no remote stop. Cancel while it runs, and the answer still
    // arrives minutes later. The old code flipped the row to `done` and fired a
    // "finished" ping -- for work the owner had explicitly called off.
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    cancelCodeTask(id)

    const { task, outcome } = completeCodeTaskDetailed(id, { ok: true, result: 'kesz' }, Date.now(), 'DESKTOP-A')
    expect(outcome).toBe('cancelled')
    expect(task!.status).toBe('cancelled')
  })

  it('still KEEPS the cancelled run output, so /result can show it', () => {
    // Suppressing the status change must not throw away real work: the owner
    // may well want to see what the CLI managed to do before being called off.
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    cancelCodeTask(id)
    completeCodeTaskDetailed(id, { ok: true, result: 'felig kesz lett' }, Date.now(), 'DESKTOP-A')
    expect(getCodeTask(id)!.result).toBe('felig kesz lett')
  })

  it('is idempotent: a re-POSTed result does not overwrite the first answer', () => {
    // A worker whose response is lost retries. Without the guard the second
    // POST rewrote the row -- and sent a SECOND "finished" notification.
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    completeCodeTaskDetailed(id, { ok: true, result: 'first' }, Date.now(), 'DESKTOP-A')
    const second = completeCodeTaskDetailed(id, { ok: true, result: 'second' }, Date.now(), 'DESKTOP-A')
    expect(second.outcome).toBe('already-final')
    expect(getCodeTask(id)!.result).toBe('first')
  })

  it('refuses a result from a host that no longer holds the task', () => {
    // Lease reaped -> another machine took the job over. Accepting the old
    // worker's answer would report the WRONG run's output as this task result.
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    // The successor claims it after the reaper re-queued it.
    const db = getCodeTask(id)!
    expect(db.host).toBe('DESKTOP-A')
    const { outcome } = completeCodeTaskDetailed(id, { ok: true, result: 'stale' }, Date.now(), 'LAPTOP-B')
    expect(outcome).toBe('foreign-host')
    expect(getCodeTask(id)!.status).toBe('running')
  })

  it('accepts the normal case unchanged -- the guard must not block real work', () => {
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    const { task, outcome } = completeCodeTaskDetailed(id, { ok: true, result: 'kesz' }, Date.now(), 'DESKTOP-A')
    expect(outcome).toBe('accepted')
    expect(task!.status).toBe('done')
  })

  it('keeps the old single-return signature working for existing callers', () => {
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    expect(completeCodeTask(id, { ok: true, result: 'kesz' })!.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// F3 -- a bad bot token must not flood the log
// ---------------------------------------------------------------------------

describe('code-bot poll backoff', () => {
  it('backs off while the API keeps refusing, and caps out', () => {
    // A revoked or mistyped token answers INSTANTLY, so a fixed 1s retry writes
    // ~86 000 WARN lines a day into a log that is already megabytes long -- and
    // buries every other warning in it.
    let d = 1000
    const seen: number[] = []
    for (let i = 0; i < 10; i++) { d = nextBackoffMs(d, false); seen.push(d) }
    expect(seen[0]).toBe(2000)
    expect(seen[1]).toBe(4000)
    expect(Math.max(...seen)).toBe(60_000)
  })

  it('snaps back to one second the moment a poll succeeds', () => {
    // Backoff must not punish a bot that recovers: a 60s delay after the token
    // is fixed would look exactly like "still broken".
    expect(nextBackoffMs(60_000, true)).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// F7 -- the notification has to say what it is about
// ---------------------------------------------------------------------------

describe('completion ping', () => {
  it('names its sender and labels the /result line', () => {
    // Boss, verbatim, 2026-08-20 12:18 about these messages: "Ezek mit
    // jelentenek???" They arrive in a chat that also carries Marvin's own
    // traffic, and without a subject there is nothing to tell them apart.
    const id = queueOne()
    claimNextCodeTask('DESKTOP-A')
    completeCodeTask(id, { ok: true, result: 'kesz', durationMs: 4000 })
    const msg = buildCompletionMessage(getCodeTask(id)!)
    expect(msg).toContain('Kod-hid')
    expect(msg).toContain('marvin')
    expect(msg).toContain('/result')
    // Short stays short: this is the whole point of the direct ping.
    expect(msg.split('\n').length).toBeLessThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// F2 -- reporting a result is a sign of life
// ---------------------------------------------------------------------------

describe('worker presence on result', () => {
  it('stamps the presence row when a worker reports a result', () => {
    recordCodeWorkerSeen('DESKTOP-A', 'result')
    const w = listCodeWorkers()
    expect(w).toHaveLength(1)
    expect(w[0]!.lastAction).toBe('result')
  })
})

// ---------------------------------------------------------------------------
// F9 / F10 -- the Windows executor's own guards
// ---------------------------------------------------------------------------

describe('windows worker script', () => {
  const ps1 = readFileSync(join(process.cwd(), 'scripts/windows/marvin-code-worker.ps1'), 'utf8')

  it('reports an EMPTY session list instead of staying silent', () => {
    // Returning early left the server presence row holding the session count of
    // the last good pass (COALESCE keeps it), so the page would still claim
    // "3 projects" while the executor found none -- the exact misdiagnosis this
    // whole presence signal exists to prevent.
    expect(ps1).toContain('"sessions":[]')
    expect(ps1).toContain('reporting empty list')
  })

  it('validates the permission mode before putting it on a command line', () => {
    // CODE_PERMISSION_MODE is checked by the settings registry, but config.ts
    // reads it raw and a hand-edited .env is checked nowhere -- and this value
    // lands directly in the process arguments.
    expect(ps1).toContain('$script:ALLOWED_MODES')
    expect(ps1).toContain("'acceptEdits', 'bypassPermissions', 'default', 'plan'")
    expect(ps1).toContain('falling back to acceptEdits')
  })

  it('names itself in the result POST', () => {
    expect(ps1).toContain("$result['host'] = $script:HostId")
  })
})

// ---------------------------------------------------------------------------
// F5 / F6 -- a malformed request is a CLIENT error
// ---------------------------------------------------------------------------

describe('malformed input', () => {
  const code = readFileSync(join(process.cwd(), 'src/web/routes/code.ts'), 'utf8')
  const messages = readFileSync(join(process.cwd(), 'src/web/routes/messages.ts'), 'utf8')

  it('never lets decodeURIComponent throw out of a route', () => {
    // `DELETE /api/code/projects/%` used to return 500 "Szerver hiba" -- which
    // reads as "the server broke" and sends the caller looking in the wrong
    // place. Every decode of a URL segment goes through the guard.
    expect(code).toContain('function safeDecode')
    expect(code).not.toMatch(/decodeURIComponent\((projectMatch|taskMatch|latestMatch)/)
  })

  it('answers 400, not 500, for an unparseable message body', () => {
    expect(messages).toContain("json(res, { error: 'invalid JSON body' }, 400)")
  })

  it('refuses to cancel a task whose CLI is already running', () => {
    // Flipping a running task to `cancelled` would make the dashboard lie: the
    // process on Windows carries on regardless. The Telegram bot has always
    // answered this honestly; the REST surface now says the same thing.
    expect(code).toContain('the CLI cannot be stopped remotely')
  })
})

// ---------------------------------------------------------------------------
// F4 -- a saved setting has to be reachable from the page alone
// ---------------------------------------------------------------------------

describe('restart control on the code bridge page', () => {
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const code = readFileSync(join(process.cwd(), 'src/web/routes/code.ts'), 'utf8')

  it('has a restart slot at BOTH places that print "takes effect after restart"', () => {
    // Boss (2026-08-16): "tegyel egy gombot oda a beallitasokba illetve minden
    // ilyen helyre ahol ezt irjatok ki hogy ujrainditas utan lep eletbe."
    // Without it a fresh install can save a bot token from the browser and then
    // needs a terminal to make it do anything.
    expect(html).toContain('id="cbBotRestart"')
    expect(html).toContain('id="cbOpsRestart"')
    expect(app).toContain("cbMountRestart('cbBotRestart'")
    expect(app).toContain("cbMountRestart('cbOpsRestart'")
    expect(app).toContain('mountRestartButton(slot, note)')
  })

  it('reports every live value the page needs to detect a pending restart', () => {
    // The button only shows when the stored value actually differs from the
    // running one. Two fields were missing from `live`, so changing them could
    // never raise the flag.
    expect(code).toContain('allowedChatIds: CODE_BOT_ALLOWED_CHAT_IDS,\n        excluded: CODE_BRIDGE_EXCLUDE,')
  })
})


// ---------------------------------------------------------------------------
// F4b -- the restart button must not become decoration
// ---------------------------------------------------------------------------

describe('restart-pending detection', () => {
  // The page compares a SAVED string against a LIVE value -- but config.ts has
  // already parsed the live side into an array (split, trim, drop empties) and
  // lowercased the exclusion list. Compared raw, a single space or capital
  // letter leaves the button standing after the restart that was supposed to
  // clear it. Boss, 2026-08-18, about exactly that symptom elsewhere:
  // "ujraindtottam es megis kiirja hogy ujrainditasra var!!?"
  //
  // The page's OWN function is lifted out of app.js here, so this measures the
  // shipped code rather than a re-typed copy of it.
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')
  const m = app.match(/function cbNormList\(value, lower\) \{[\s\S]*?\n  \}/)
  const cbNormList = new Function('return (' + (m ? m[0] : 'function () { throw new Error("cbNormList missing") }') + ')')() as
    (v: unknown, lower: boolean) => string

  function pending(cfg: Record<string, unknown>): { bot: boolean; ops: boolean } {
    const live = (cfg['live'] ?? {}) as Record<string, unknown>
    return {
      bot:
        Boolean(cfg['botConfigured']) !== Boolean(live['botConfigured']) ||
        cbNormList(cfg['CODE_BOT_ALLOWED_CHAT_IDS'], false) !== cbNormList(live['allowedChatIds'], false),
      ops:
        (String(cfg['CODE_BRIDGE_ENABLED']) === '1') !== Boolean(live['enabled']) ||
        String(cfg['CODE_PERMISSION_MODE'] ?? '') !== String(live['permissionMode'] ?? '') ||
        cbNormList(cfg['CODE_BRIDGE_EXCLUDE'], true) !== cbNormList(live['excluded'], true),
    }
  }

  const base = {
    CODE_BRIDGE_ENABLED: '1',
    CODE_PERMISSION_MODE: 'acceptEdits',
    CODE_BRIDGE_EXCLUDE: '',
    CODE_BOT_ALLOWED_CHAT_IDS: '',
    botConfigured: false,
    live: { enabled: true, permissionMode: 'acceptEdits', botConfigured: false, allowedChatIds: [], excluded: [] },
  }

  it('the page actually contains the normaliser it relies on', () => {
    expect(m).not.toBeNull()
  })

  it('shows NO button when nothing changed', () => {
    expect(pending(base)).toEqual({ bot: false, ops: false })
  })

  it('is not fooled by spacing, capitals, or empty list elements', () => {
    expect(pending({ ...base,
      CODE_BRIDGE_EXCLUDE: 'a, b', CODE_BOT_ALLOWED_CHAT_IDS: '1, 2',
      live: { ...base.live, excluded: ['a', 'b'], allowedChatIds: ['1', '2'] },
    })).toEqual({ bot: false, ops: false })

    // config.ts lowercases the exclusion list; the saved value keeps whatever
    // the owner typed. Raw comparison made this button permanent.
    expect(pending({ ...base,
      CODE_BRIDGE_EXCLUDE: 'Tozsde_Telepitesi_Mappa',
      live: { ...base.live, excluded: ['tozsde_telepitesi_mappa'] },
    }).ops).toBe(false)

    expect(pending({ ...base,
      CODE_BRIDGE_EXCLUDE: 'a,,b,',
      live: { ...base.live, excluded: ['a', 'b'] },
    }).ops).toBe(false)
  })

  it('DOES show the button for every real change, on the right card', () => {
    expect(pending({ ...base, botConfigured: true }))
      .toEqual({ bot: true, ops: false })
    expect(pending({ ...base, CODE_BOT_ALLOWED_CHAT_IDS: '999' }))
      .toEqual({ bot: true, ops: false })
    expect(pending({ ...base, CODE_PERMISSION_MODE: 'plan' }))
      .toEqual({ bot: false, ops: true })
    expect(pending({ ...base, CODE_BRIDGE_ENABLED: '0' }))
      .toEqual({ bot: false, ops: true })
    expect(pending({ ...base, CODE_BRIDGE_EXCLUDE: 'uj' }))
      .toEqual({ bot: false, ops: true })
  })
})

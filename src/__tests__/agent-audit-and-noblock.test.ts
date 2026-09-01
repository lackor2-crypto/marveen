// Rule #13 removal + fleet audit trail (Boss, 2026-08-25).
//
// Two requests landed together:
//   #13 (Telegram): the file-claim gate must STOP refusing Edit/Write -- an
//   online agent may never sit idle because a rule blocks its edit.
//   voice 479: since the brakes are off, log EVERYTHING each agent does,
//   especially deletes/edits/moves, so who-did-what is always traceable.
//
// These tests lock both: the gate can no longer exit 2 (deny), and the audit
// hook records every change-making tool call, classifying deletes and moves.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'file-claim-gate.py')
const AUDIT = join(ROOT, 'scripts', 'hooks', 'agent-audit-log.py')
const AUDIT_LOG = join(ROOT, 'store', 'agent-audit.jsonl')
const TEMPLATE = join(ROOT, 'templates', 'settings.json.template')

function run(hook: string, payload: unknown, env: Record<string, string> = {}) {
  return spawnSync('python3', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

function lastAuditLine(match: string): Record<string, unknown> | undefined {
  const log = existsSync(AUDIT_LOG) ? readFileSync(AUDIT_LOG, 'utf-8') : ''
  const line = log.trim().split('\n').reverse().find((l) => l.includes(match))
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined
}

describe('rule #13 removed: the file-claim gate never blocks', () => {
  it('exits 0 (allow) on a guarded Edit, even inside the install root', () => {
    const r = run(GATE, { tool_name: 'Edit', cwd: join(ROOT, 'src'), tool_input: { file_path: 'src/web/app.js' } })
    expect(r.status).toBe(0)
  })

  it('has no deny / exit-2 path left in the script at all', () => {
    const src = readFileSync(GATE, 'utf-8')
    expect(src).not.toMatch(/sys\.exit\(2\)/)
    expect(src).not.toMatch(/def deny\(/)
  })
})

describe('agent-audit-log hook records every change and never blocks', () => {
  const sentinel = `SENTINEL-${Date.now()}-${Math.random().toString(36).slice(2)}`

  it('logs an Edit as op=edit and exits 0', () => {
    const r = run(AUDIT, { tool_name: 'Edit', cwd: ROOT, tool_input: { file_path: sentinel } })
    expect(r.status).toBe(0)
    const e = lastAuditLine(sentinel)
    expect(e, 'an audit line for the edit').toBeTruthy()
    expect(e!.op).toBe('edit')
    expect(e!.tool).toBe('Edit')
  })

  it('classifies a Bash rm as op=delete', () => {
    const cmd = `rm -rf /tmp/${sentinel}-del`
    const r = run(AUDIT, { tool_name: 'Bash', cwd: ROOT, tool_input: { command: cmd } })
    expect(r.status).toBe(0)
    const e = lastAuditLine(`${sentinel}-del`)
    expect(e!.op).toBe('delete')
  })

  it('classifies a Bash mv as op=move', () => {
    const cmd = `mv /tmp/${sentinel}-a /tmp/${sentinel}-b`
    const r = run(AUDIT, { tool_name: 'Bash', cwd: ROOT, tool_input: { command: cmd } })
    expect(r.status).toBe(0)
    const e = lastAuditLine(`${sentinel}-a /tmp/${sentinel}-b`)
    expect(e!.op).toBe('move')
  })

  it('ignores read-only tools (no Read spam)', () => {
    const r = run(AUDIT, { tool_name: 'Read', cwd: ROOT, tool_input: { file_path: `${sentinel}-read` } })
    expect(r.status).toBe(0)
    expect(lastAuditLine(`${sentinel}-read`)).toBeUndefined()
  })

  it('honours the MARVEEN_AUDIT_LOG=0 kill switch', () => {
    const marker = `${sentinel}-off`
    const r = run(AUDIT, { tool_name: 'Edit', cwd: ROOT, tool_input: { file_path: marker } }, { MARVEEN_AUDIT_LOG: '0' })
    expect(r.status).toBe(0)
    expect(lastAuditLine(marker)).toBeUndefined()
  })
})

describe('template wiring', () => {
  it('registers agent-audit-log.py on a Bash-matching PreToolUse matcher', () => {
    const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf-8')) as {
      hooks: { PreToolUse: Array<{ matcher?: string }> }
    }
    const entry = tpl.hooks.PreToolUse.find(
      (e) => String(e.matcher || '').includes('Bash') && JSON.stringify(e).includes('agent-audit-log.py'),
    )
    expect(entry, 'audit hook must match Bash so deletes and moves are logged').toBeTruthy()
  })
})

// A #13-as szabaly a KODBAN mar le van zarva (fent). Ez a blokk a SZALLITOTT
// DOKUMENTACIOT zarja le. 2026-08-25-en a templates/CLAUDE.md.template helyesen
// frissult, a seed-skills/ viszont kimaradt, es tovabbra is azt allitotta, hogy a
// kapu "megtagadja a felulirast". A helyi CLAUDE.md gitignore-olt (a sablonbol
// generalodik), ezert egy FRISS telepites a szabalyt csak a sablonbol es a
// seed-skills/-bol tanulja meg -- ott egy elavult mondat pont azt a vedelmet igeri,
// ami nincs, es az agens ratamaszkodik sajat worktree helyett.
describe('rule #13 removed: the shipped docs must not promise a block', () => {
  const DOC_DIRS = ['seed-skills', 'templates', 'docs']
  const STALE = /megtagadja a fel[uü]l[ií]r[aá]st|refuses the overwrite|denies the overwrite/i
  const NO_BLOCK = /(m[aá]r )?nem tagadja meg|nem blokkol|a BLOKK kiv[eé]ve|no longer (block|den)/i

  function docs(): string[] {
    const out: string[] = []
    for (const d of DOC_DIRS) {
      const base = join(ROOT, d)
      if (!existsSync(base)) continue
      for (const rel of readdirSync(base, { recursive: true, encoding: 'utf-8' })) {
        const p = join(base, String(rel))
        if (!/\.(md|template)$/.test(p)) continue
        if (!statSync(p).isFile()) continue
        out.push(p)
      }
    }
    return out
  }

  // A prozat sorra tordeljuk, igy a keresett mondat AT IS LOGHAT a sortoresen
  // ("MAR NEM tagadja\n  meg az Edit/Write-ot"). Nyers szovegen keresve ez nema
  // hamis riasztas lenne -- pontosan az a fajta, amitol a teszt hasznalhatatlan.
  const flat = (p: string) => readFileSync(p, 'utf-8').replace(/\s+/g, ' ')

  // A "magyarazza is el" kovetelmeny csak PROZAra all: a settings.json.template
  // parancssorban hivatkozik a hookra, nem szabalyt ismertet.
  const isProse = (p: string) => p.endsWith('.md') || p.endsWith('CLAUDE.md.template')

  it('finds the docs to check at all (a zero here would hide every drift)', () => {
    expect(docs().length).toBeGreaterThan(0)
    expect(docs().filter(isProse).length).toBeGreaterThan(0)
  })

  it('no shipped doc claims the gate refuses an overwrite', () => {
    const offenders = docs().filter((p) => STALE.test(flat(p)))
    expect(offenders.map((p) => p.slice(ROOT.length + 1)), 'rule #13 removed the deny path').toEqual([])
  })

  it('every prose doc that names the gate also says it no longer blocks', () => {
    const named = docs().filter((p) => isProse(p) && flat(p).includes('file-claim-gate'))
    expect(named.length, 'the rule must be documented somewhere a fresh install can read').toBeGreaterThan(0)
    const silent = named.filter((p) => !NO_BLOCK.test(flat(p)))
    expect(
      silent.map((p) => p.slice(ROOT.length + 1)),
      'a doc naming the gate must state that it only logs, so nobody relies on a block that is gone',
    ).toEqual([])
  })
})

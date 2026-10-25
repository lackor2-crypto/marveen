// #799: a session start has a hard token ceiling. Guarded here: the ceiling resolves env > Settings override > .env >
// default (empty store), the conversation block gets what the fixed part leaves, the OLDEST turns fall off first, the
// freshest always survives, a fixed part that is alone over the ceiling is REPORTED (not silently cut), and a broken
// config never disables the guard. Tokens are chars / 3.5 -- an estimate, and the report says so.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { startupTokenCeiling, STARTUP_TOKEN_CEILING_DEFAULT } from '../config.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const LIB = join(__dirname, '..', '..', 'scripts', 'hooks')
let tmp = ''
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'startup-ceiling-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function py(code: string, env: Record<string, string> = {}): any {
  const out = execFileSync('python3', ['-I', '-c', `import sys,json; sys.path.insert(0, ${JSON.stringify(LIB)}); import startup_budget_lib as L\n${code}`], {
    env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8',
  })
  return JSON.parse(out)
}

/** A fake install: <root>/store, <home>/.claude/CLAUDE.md of `userChars`, <root>/agents/a/CLAUDE.md of `agentChars`. */
function fake(userChars: number, agentChars: number) {
  const root = join(tmp, 'root'), home = join(tmp, 'home'), cwd = join(root, 'agents', 'a')
  mkdirSync(join(root, 'store'), { recursive: true }); mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(cwd, { recursive: true })
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'u'.repeat(userChars))
  writeFileSync(join(cwd, 'CLAUDE.md'), 'a'.repeat(agentChars))
  return { root, home, cwd }
}

describe('ceiling resolution (python side)', () => {
  it('is 50000 on an empty install, with no store file and no .env', () => {
    const f = fake(0, 0)
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`)).toBe(50000)
  })
  it('env beats the Settings override, which beats .env', () => {
    const f = fake(0, 0)
    writeFileSync(join(f.root, '.env'), 'STARTUP_TOKEN_CEILING=111\n')
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`)).toBe(111)
    writeFileSync(join(f.root, 'store', 'config-overrides.json'), JSON.stringify({ STARTUP_TOKEN_CEILING: 222 }))
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`)).toBe(222)
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`, { STARTUP_TOKEN_CEILING: '333' })).toBe(333)
  })
  it('0 means no ceiling; garbage falls back to the default instead of disabling the guard', () => {
    const f = fake(0, 0)
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`, { STARTUP_TOKEN_CEILING: '0' })).toBe(0)
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`, { STARTUP_TOKEN_CEILING: 'many' })).toBe(50000)
    expect(py(`print(json.dumps(L.ceiling_tokens(${JSON.stringify(f.root)})))`, { STARTUP_TOKEN_CEILING: '-5' })).toBe(50000)
  })
})

describe('conversation budget', () => {
  const budget = (f: ReturnType<typeof fake>, def: number, env: Record<string, string> = {}) =>
    py(`print(json.dumps(L.conversation_budget_bytes(${JSON.stringify(f.cwd)}, ${def}, root=${JSON.stringify(f.root)}, home=${JSON.stringify(f.home)})))`, env)

  it('never loosens the existing budget when there is room', () => {
    expect(budget(fake(1000, 1000), 8192)).toBe(8192)
  })
  it('shrinks to what the fixed part leaves under the ceiling', () => {
    // ceiling 1000 tokens = 3500 chars; fixed 2000 + 1000 = 3000 -> 500 chars room -> floored at 1500
    const f = fake(2000, 1000)
    expect(budget(f, 8192, { STARTUP_TOKEN_CEILING: '1000' })).toBe(1500)
    // ceiling 2000 tokens = 7000 chars; fixed 3000 -> 4000 room
    expect(budget(f, 8192, { STARTUP_TOKEN_CEILING: '2000' })).toBe(4000)
  })
  it('keeps the freshest turn even when the fixed part alone is over the ceiling', () => {
    expect(budget(fake(50_000, 50_000), 8192, { STARTUP_TOKEN_CEILING: '1000' })).toBe(1500)
  })
  it('ceiling 0 leaves the old budget untouched', () => {
    expect(budget(fake(50_000, 50_000), 8192, { STARTUP_TOKEN_CEILING: '0' })).toBe(8192)
  })
  it('a missing cwd never throws', () => {
    expect(py(`print(json.dumps(L.conversation_budget_bytes('/nonexistent/x', 8192, root='/nonexistent', home='/nonexistent')))`)).toBeGreaterThanOrEqual(1500)
  })
})

describe('report', () => {
  it('flags an estimate, splits fixed from conversation, and says when the fixed part alone is over', () => {
    const f = fake(35_000, 35_000)
    const r = py(`print(json.dumps(L.report(${JSON.stringify(f.cwd)}, conversation_chars=3500, root=${JSON.stringify(f.root)}, home=${JSON.stringify(f.home)})))`, { STARTUP_TOKEN_CEILING: '15000' })
    expect(r.estimate).toBe(true)
    expect(r.fixed_tokens).toBe(20_000)
    expect(r.conversation_tokens).toBe(1000)
    expect(r.fixed_alone_over_ceiling).toBe(true)
    expect(r.over_ceiling).toBe(true)
    expect(r.not_counted).toMatch(/system prompt/)
  })
  it('counts a symlinked agent skills dir once', () => {
    const f = fake(0, 0)
    const skills = join(f.home, '.claude', 'skills', 's1'); mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, 'SKILL.md'), '---\nname: s1\ndescription: hello world\n---\nbody')
    mkdirSync(join(f.cwd, '.claude'), { recursive: true })
    require('node:fs').symlinkSync(join(f.home, '.claude', 'skills'), join(f.cwd, '.claude', 'skills'))
    const n = py(`print(json.dumps(L.skill_list_chars(${JSON.stringify(f.cwd)}, home=${JSON.stringify(f.home)})))`)
    expect(n).toBe('s1'.length + 'hello world'.length + 4)
  })
})

describe('measurer summary', () => {
  it('derives harness = measured - controllable and never invents it without a measured figure', () => {
    const f = fake(35_000, 35_000)
    const env = { STARTUP_TOKEN_CEILING: '50000' }
    const args = `${JSON.stringify(f.cwd)}, root=${JSON.stringify(f.root)}, home=${JSON.stringify(f.home)}`
    const none = py(`print(json.dumps(L.summary(L.report(${args}))))`, env)
    expect(none).toMatchObject({ total: null, harness: null, controllable: 20_000, ceiling: 50_000 })
    const withMeasured = py(`r = L.report(${args}); r['measured_total_tokens'] = 90000; print(json.dumps(L.summary(r)))`, env)
    expect(withMeasured).toMatchObject({ total: 90_000, harness: 70_000, controllable: 20_000, controllable_over_ceiling: false })
  })
  it('renders the four numbers in both languages and flags an over-ceiling controllable part', () => {
    const f = fake(35_000, 35_000)
    const args = `${JSON.stringify(f.cwd)}, root=${JSON.stringify(f.root)}, home=${JSON.stringify(f.home)}`
    const out = execFileSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(LIB)}); import startup_budget_lib as L; r = L.report(${args}); r['measured_total_tokens'] = 90000; print(L.render(r))`], {
      env: { PATH: process.env.PATH ?? '', STARTUP_TOKEN_CEILING: '15000' }, encoding: 'utf8',
    })
    expect(out).toContain('harness')
    expect(out).toContain('70 000')
    expect(out).toContain('Plafon / Ceiling')
    expect(out).toContain('WARNING')
    expect(out).toContain('ESTIMATES')
  })
})

describe('TS side', () => {
  it('has a safe default and a Settings entry with HU+EN texts', () => {
    expect(STARTUP_TOKEN_CEILING_DEFAULT).toBe(50_000)
    expect(typeof startupTokenCeiling()).toBe('number')
    const e = SETTINGS_REGISTRY.find((x) => x.key === 'STARTUP_TOKEN_CEILING')
    expect(e?.default).toBe(50000)
    const hu = require('node:fs').readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
    const en = require('node:fs').readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
    expect(hu).toContain("'settings.desc.STARTUP_TOKEN_CEILING'")
    expect(en).toContain("'settings.desc.STARTUP_TOKEN_CEILING'")
  })
})

describe('ledger-replay under a tight ceiling', () => {
  it('drops the oldest turns first and keeps the freshest', () => {
    const h = join(LIB, 'startup_budget_lib.py')
    expect(h).toContain('startup_budget_lib')
    const f = fake(20_000, 20_000) // fixed 40k chars; ceiling 12000 tokens = 42000 chars -> 2000 room
    const out = py(`
import importlib.util, os
spec = importlib.util.spec_from_file_location('lr', ${JSON.stringify(join(LIB, 'ledger-replay.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
turns = ['  [t%02d] X: "%s"' % (i, 'x' * 300) for i in range(12)]
b = L.conversation_budget_bytes(${JSON.stringify(f.cwd)}, 8192, root=${JSON.stringify(f.root)}, home=${JSON.stringify(f.home)})
out = m._fit_output(turns, None, 'X', b)
ctx = out['hookSpecificOutput']['additionalContext']
print(json.dumps({'b': b, 'has_new': '[t11]' in ctx, 'has_old': '[t00]' in ctx, 'bytes': m._payload_bytes(out)}))`, { STARTUP_TOKEN_CEILING: '12000' })
    expect(out.b).toBe(2000)
    expect(out.has_new).toBe(true)
    expect(out.has_old).toBe(false)
  })
})

// #908: every web search / page read is saved into the Research by the system (hook + endpoint), on every agent.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildWebResearchSaveBody, ensureWebResearchSaveSection } from '../web/agent-scaffold.js'
import { saveWebResearch } from '../web/routes/research.js'

const dirs: string[] = []
const THROWAWAY = 'zz-web-research-probe'
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
})
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'webres-')); dirs.push(d); return join(d, 'research') }

describe('saveWebResearch', () => {
  it('writes a listable file (safe name, title line, source, whole text)', () => {
    const dir = tmp()
    const text = 'x'.repeat(300_000) + '\nvége'
    const r = saveWebResearch(dir, { tool: 'WebSearch', query: 'Árvíztűrő tükörfúrógép 2026', url: '', text })
    expect(r).toEqual({ ok: true, name: 'web-arvizturo-tukorfurogep-2026.md', duplicate: false })
    const body = readFileSync(join(dir, (r as { name: string }).name), 'utf-8')
    expect(body.startsWith('# Web keresés: Árvíztűrő tükörfúrógép 2026')).toBe(true)
    expect(body).toContain('forrás: WebSearch | keresés: Árvíztűrő tükörfúrógép 2026')
    expect(body).toContain(text) // no hidden size limit
    expect(readdirSync(dir)[0]).toMatch(/^[A-Za-z0-9._-]+\.md$/)
  })
  it('never overwrites, and does not save the same text twice', () => {
    const dir = tmp()
    const a = saveWebResearch(dir, { tool: 'WebFetch', query: '', url: 'https://example.org/a', text: 'first' })
    const b = saveWebResearch(dir, { tool: 'WebFetch', query: '', url: 'https://example.org/a', text: 'second' })
    const c = saveWebResearch(dir, { tool: 'WebFetch', query: '', url: 'https://example.org/a', text: 'second' })
    expect(a).toMatchObject({ ok: true, name: 'web-example-org-a.md', duplicate: false })
    expect(b).toMatchObject({ ok: true, name: 'web-example-org-a-2.md', duplicate: false })
    expect(c).toMatchObject({ ok: true, name: 'web-example-org-a-2.md', duplicate: true })
    expect(readdirSync(dir).length).toBe(2)
  })
  it('adds the project line only when a project is given; rejects empty input', () => {
    const dir = tmp()
    const r = saveWebResearch(dir, { tool: 'WebSearch', query: 'q', url: '', text: 't', project: 'abc123' })
    expect(readFileSync(join(dir, (r as { name: string }).name), 'utf-8')).toContain('\nproject: abc123\n')
    expect(saveWebResearch(dir, { tool: 'WebSearch', query: 'q', url: '', text: '   ' }).ok).toBe(false)
    expect(saveWebResearch(dir, { tool: 'WebSearch', query: '', url: '', text: 't' }).ok).toBe(false)
  })
})

describe('web-research-save.py (the hook)', () => {
  const run = (payload: unknown) => spawnSync('python3', ['-I', '-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(PROJECT_ROOT, 'scripts/hooks'))})
import importlib.util
spec = importlib.util.spec_from_file_location('h', ${JSON.stringify(join(PROJECT_ROOT, 'scripts/hooks/web-research-save.py'))})
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
print(json.dumps(h.build_body(json.loads(sys.stdin.read()))))
`], { input: JSON.stringify(payload), encoding: 'utf-8' })
  it('takes the query and the text the agent read, for WebSearch and WebFetch', () => {
    const s = JSON.parse(run({ tool_name: 'WebSearch', cwd: PROJECT_ROOT, tool_input: { query: 'abc' }, tool_response: 'results here' }).stdout)
    expect(s).toMatchObject({ tool: 'WebSearch', query: 'abc', text: 'results here' })
    const f = JSON.parse(run({ tool_name: 'WebFetch', cwd: PROJECT_ROOT, tool_input: { url: 'https://e.org', prompt: 'p' }, tool_response: { result: 'page text' } }).stdout)
    expect(f).toMatchObject({ tool: 'WebFetch', url: 'https://e.org', text: 'page text' })
  })
  it('skips other tools, errors and empty results', () => {
    expect(JSON.parse(run({ tool_name: 'Read', tool_input: { query: 'x' }, tool_response: 'y' }).stdout)).toBeNull()
    expect(JSON.parse(run({ tool_name: 'WebSearch', tool_input: { query: 'x' }, tool_response: { is_error: true, content: 'boom' } }).stdout)).toBeNull()
    expect(JSON.parse(run({ tool_name: 'WebSearch', tool_input: { query: 'x' }, tool_response: '' }).stdout)).toBeNull()
  })
  it('is registered once in the fleet template (every agent gets it), guarded and never blocking', () => {
    const t = readFileSync(join(PROJECT_ROOT, 'templates/settings.json.template'), 'utf-8')
    expect(t).toContain('"matcher": "WebSearch|WebFetch"')
    expect(t).toContain('scripts/hooks/web-research-save.py ] && exec python3')
    expect(t.split('web-research-save.py').length - 1).toBe(2) // test -f and exec, in ONE entry
  })
})

describe('the rule on every agent', () => {
  it('is host-agnostic and names the hook and the skill', () => {
    const b = buildWebResearchSaveBody()
    expect(b).toContain('web-research-save.py')
    expect(b).toContain('Kontextus')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })
  it('is appended once, idempotently; skips the main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureWebResearchSaveSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n')
    expect(ensureWebResearchSaveSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(ensureWebResearchSaveSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureWebResearchSaveSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })
  it('is in the template, the web.ts / agent-process wiring and the global skill (scope: global)', () => {
    expect(readFileSync(join(PROJECT_ROOT, 'templates/CLAUDE.md.template'), 'utf-8')).toContain('ensureWebResearchSaveSection')
    expect(readFileSync(join(PROJECT_ROOT, 'src/web.ts'), 'utf-8')).toContain('ensureGlobalWebResearchSaveRule()')
    expect(readFileSync(join(PROJECT_ROOT, 'src/web/agent-process.ts'), 'utf-8')).toContain('ensureWebResearchSaveSection(name)')
    const sk = readFileSync(join(PROJECT_ROOT, 'seed-skills/web-research-saved/SKILL.md'), 'utf-8')
    expect(sk).toContain('scope: global')
  })
})

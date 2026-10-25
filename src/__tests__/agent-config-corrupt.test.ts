// #801: an agent's config file that is there but is not JSON used to read as {} -- and the one-field write that followed
// (model, display name, team, an MCP server, the main agent's model in .claude/settings.json) silently replaced every
// other setting. Now the file is copied aside and the update refused; nothing is overwritten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfigForUpdate, CorruptConfigError } from '../web/agent-config.js'

const ROOT = join(__dirname, '..', '..')

describe('#801 reading a config for an update', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-cfg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a missing or empty file is an empty config; a good one is read as it is', () => {
    expect(readConfigForUpdate(join(dir, 'nincs.json'))).toEqual({})
    writeFileSync(join(dir, 'ures.json'), '  \n')
    expect(readConfigForUpdate(join(dir, 'ures.json'))).toEqual({})
    writeFileSync(join(dir, 'jo.json'), JSON.stringify({ model: 'opus', team: { a: 1 } }))
    expect(readConfigForUpdate(join(dir, 'jo.json'))).toEqual({ model: 'opus', team: { a: 1 } })
  })

  it('a corrupt file is NOT read as {}: the update is refused, the file untouched, a copy kept beside it', () => {
    const f = join(dir, 'agent-config.json')
    const broken = '{ "model": "opus", "telegram": { "token": "x" }, '
    writeFileSync(f, broken)
    let err: unknown = null
    try { readConfigForUpdate(f) } catch (e) { err = e }
    expect(err).toBeInstanceOf(CorruptConfigError)
    expect((err as CorruptConfigError).message).toMatch(/not overwritten/)
    expect(readFileSync(f, 'utf8')).toBe(broken)
    const copies = readdirSync(dir).filter((n) => n.startsWith('agent-config.json.corrupt-'))
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe(broken)
  })

  it('a JSON value that is not an object (an array, a number) is refused too', () => {
    writeFileSync(join(dir, 'a.json'), '[1,2]')
    expect(() => readConfigForUpdate(join(dir, 'a.json'))).toThrow(CorruptConfigError)
  })

  it('no config writer reads its file the old way (a parse error swallowed into {}, then written back)', () => {
    const offenders: string[] = []
    for (const f of ['src/web/agent-config.ts', 'src/web/agent-team.ts', 'src/web/routes/connectors.ts', 'src/web/model-fallback-runner.ts']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      if (/=\s*JSON\.parse\(read\w*\([^)]*\)\)\s*\}\s*catch\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})

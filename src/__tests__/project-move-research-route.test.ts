// #507 (Boss TG 2827): the Move button on a project's Research / Debate tab said
// "nothing to move" and the item stayed. A research file or debate belongs to its
// project through the file's `project:` mark / the debate log, not a link row.
//
// This runs the REAL route (POST /api/projects/:id/move) against real research
// files in a sandbox, so the id the Research tab sends (`<agent>/<name>`, where the
// name may sit in a subfolder) is resolved exactly as in production:
//   - a marked research file and a logged debate move, and the tab lists follow;
//   - a research file in a subfolder moves too (and can be linked by hand);
//   - a path that escapes the research folder is never resolved.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'prj-move-research-'))
const AGENTS_TMP = join(tmpRoot, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return {
    ...actual,
    AGENTS_BASE_DIR: AGENTS_TMP,
    agentDir: (name: string) => join(AGENTS_TMP, name),
    agentConfigRoot: (name: string) => (name === MAIN_AGENT_ID ? tmpRoot : join(AGENTS_TMP, name)),
    listAgentNames: () =>
      existsSync(AGENTS_TMP)
        ? readdirSync(AGENTS_TMP).filter((f) => statSync(join(AGENTS_TMP, f)).isDirectory())
        : [],
  }
})

const { initDatabase } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { linkedDebates, setDebateLogPathForTests } = await import('../project-context.js')
const { tryHandleProjects } = await import('../web/routes/projects.js')
const { tryHandleResearch } = await import('../web/routes/research.js')
const { MAIN_AGENT_ID } = await import('../config.js')

const SUB = 'zz-move-sub'
const SUB_RESEARCH = join(AGENTS_TMP, SUB, 'research')
const MAIN_RESEARCH = join(tmpRoot, 'research')

function call(method: string, pathAndQuery: string, body?: unknown, handler: (c: RouteContext) => Promise<boolean> = tryHandleProjects) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420' + pathAndQuery)
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req: any = {
    headers: { 'content-length': String(buf.length) },
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && buf.length) cb(buf)
      if (event === 'end') cb()
      return req
    },
    destroy() { /* no socket */ },
  }
  return handler({ req, res, path: url.pathname, method, url } as RouteContext).then(() => out)
}

function project(name: string): string {
  const r = createProject({ name })
  if (!r.ok) throw new Error(r.code)
  return r.project.id
}

/** The ids the project's Research tab shows (the same `<agent>/<name>` the Move button sends). */
async function researchTab(pid: string): Promise<string[]> {
  const r = await call('GET', '/api/research?project=' + encodeURIComponent(pid), undefined, tryHandleResearch)
  return (r.body as { agent: string; docs: { name: string }[] }[]).flatMap((a) => a.docs.map((d) => `${a.agent}/${d.name}`)).sort()
}

let a: string, b: string

beforeEach(() => {
  initDatabase(':memory:')
  a = project('Alfa')
  b = project('Beta')
  mkdirSync(join(SUB_RESEARCH, 'nightly'), { recursive: true })
  mkdirSync(MAIN_RESEARCH, { recursive: true })
  writeFileSync(join(SUB_RESEARCH, 'flat.md'), `# Flat\nproject: ${a}\n\nbody\n`)
  writeFileSync(join(SUB_RESEARCH, 'nightly', 'deep.md'), `# Deep\nproject: ${a}\n\nbody\n`)
  writeFileSync(join(MAIN_RESEARCH, 'main.md'), `# Main\n**Projekt:** Alfa\n`)
  writeFileSync(join(tmpRoot, 'secret.md'), `# Outside\nproject: ${a}\n`)
  const log = join(tmpRoot, 'debate-log.jsonl')
  writeFileSync(log, JSON.stringify({ session: 's1', type: 'round', round: 1, prompt: 'Q?', project: a, ts: 1 }) + '\n')
  setDebateLogPathForTests(log)
})

afterEach(() => {
  setDebateLogPathForTests(null)
  rmSync(AGENTS_TMP, { recursive: true, force: true })
  rmSync(MAIN_RESEARCH, { recursive: true, force: true })
})

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('#507 Move on the Research / Debate tab', () => {
  it('moves research that belongs through its file mark, also from a subfolder, and the tabs follow', async () => {
    const ids = [`${SUB}/flat.md`, `${SUB}/nightly/deep.md`, `${MAIN_AGENT_ID}/main.md`]
    expect(await researchTab(a)).toEqual([...ids].sort())
    const r = await call('POST', `/api/projects/${a}/move`, { target: b, items: ids.map((id) => ({ type: 'research', id })) })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, moved: 3, skipped: 0 })
    expect(await researchTab(a)).toEqual([])
    expect(await researchTab(b)).toEqual([...ids].sort())
  })

  it('moves a debate that belongs through the debate log', async () => {
    expect(linkedDebates(a).map((d) => d.id)).toEqual(['s1'])
    const r = await call('POST', `/api/projects/${a}/move`, { target: b, items: [{ type: 'debate', id: 's1' }] })
    expect(r.body).toEqual({ ok: true, moved: 1, skipped: 0 })
    expect(linkedDebates(a)).toEqual([])
    expect(linkedDebates(b).map((d) => d.id)).toEqual(['s1'])
  })

  it('a research file in a subfolder can be linked by hand too', async () => {
    const r = await call('POST', `/api/projects/${b}/links`, { type: 'research', id: `${SUB}/nightly/deep.md` })
    expect(r.status).toBe(200)
    expect(await researchTab(b)).toEqual([`${SUB}/nightly/deep.md`])
  })

  it('never resolves a path outside the research folder, an unknown agent or a missing file', async () => {
    const bad = [`${MAIN_AGENT_ID}/../secret.md`, `${MAIN_AGENT_ID}/nightly/../../secret.md`, `nobody/flat.md`, `${SUB}/missing.md`, `${SUB}/`]
    const r = await call('POST', `/api/projects/${a}/move`, { target: b, items: bad.map((id) => ({ type: 'research', id })) })
    expect(r.body).toEqual({ ok: true, moved: 0, skipped: bad.length })
    for (const id of bad) {
      expect((await call('POST', `/api/projects/${b}/links`, { type: 'research', id })).status).toBe(404)
    }
  })
})

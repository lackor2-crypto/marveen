import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentConfigRoot, listAgentNames } from '../agent-config.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { researchProject } from '../../project-scope.js'

// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable, and names are
// allowlisted to block path traversal.
//
// The listing recurses into subfolders, so a doc name is a RELATIVE PATH
// ("endgame2-hermes/nightly/foo.md"), not a bare filename. That breaks both of
// the flat-namespace defenses this file used to rely on -- a single NAME_RE
// over the whole name, and basename(name) === name -- because a legal name now
// contains "/". They are replaced by two independent layers:
//
//   1. isSafeRelPath(): every segment allowlisted separately, "." and ".."
//      rejected outright (note: they PASS the character allowlist, dots are in
//      it), only the last segment may be the .md file, bounded depth.
//   2. resolveInside(): realpath containment, which also covers symlinks that
//      point out of the tree.
//
// Layer 2 is measured against the RESOLVED research root, never against
// PROJECT_ROOT: in production marveen/research is itself a symlink to
// ~/research, so a repo-path containment check would resolve every real file
// as "outside" and silently serve an empty page.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const FILE_RE = /^[A-Za-z0-9._-]+\.md$/
const MAX_SEGMENTS = 4

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

/** A fajl projektje -- a lista a projekt-adatbazis nelkul is mukodjon (pl. egy
 *  meg nem inicializalt DB mellett), ilyenkor egyszeruen nincs projekt. */
function projectOf(agent: string, name: string, content: string): string | null {
  try { return researchProject(agent, name, content) } catch { return null }
}

function researchDir(agent: string): string {
  return join(agentConfigRoot(agent), 'research')
}

function isSafeSegment(name: string): boolean {
  return name !== '.' && name !== '..' && SEGMENT_RE.test(name)
}

function isSafeRelPath(name: string): boolean {
  const parts = name.split('/')
  if (parts.length < 1 || parts.length > MAX_SEGMENTS) return false
  const last = parts.length - 1
  return parts.every((p, i) =>
    i === last ? p !== '.' && p !== '..' && FILE_RE.test(p) : isSafeSegment(p),
  )
}

// Resolved absolute path of `target`, or null if it does not exist or escapes
// `realRoot` (already-resolved research root).
function resolveInside(realRoot: string, target: string): string | null {
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return null
  }
  const rel = relative(realRoot, real)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return real
}

function realResearchRoot(agent: string): string | null {
  try {
    return realpathSync(researchDir(agent))
  } catch {
    return null
  }
}

/**
 * The real path of an agent's research doc, or null if the agent is unknown, the
 * name is unsafe or the file is missing. `name` is the same relative path the
 * listing returns, so a doc in a subfolder ("nightly/foo.md") is found too.
 */
export function researchFilePath(agent: string, name: string): string | null {
  if (!isSafeRelPath(name) || ![MAIN_AGENT_ID, ...listAgentNames()].includes(agent)) return null
  const realRoot = realResearchRoot(agent)
  const file = realRoot ? resolveInside(realRoot, join(realRoot, name)) : null
  try {
    return file && statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function walk(realRoot: string, rel: string, depth: number, out: string[]): void {
  if (depth > MAX_SEGMENTS) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rel ? join(realRoot, rel) : realRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!isSafeSegment(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const real = resolveInside(realRoot, join(realRoot, childRel))
    if (!real) continue
    let st: import('node:fs').Stats
    try {
      st = statSync(real)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(realRoot, childRel, depth + 1, out)
    else if (st.isFile() && FILE_RE.test(e.name)) out.push(childRel)
  }
}

export interface ResearchDoc { name: string; title: string; project: string | null; updated: string; ms: number }

/**
 * Every agent's research docs, newest first. `pf` filters by project: '' = all,
 * 'none' = no project, otherwise a project id. A file's project: an explicit
 * link, else the `project: ...` line at its top (src/project-scope.ts). The
 * Research page and the Workbench (#757: the work item's Research panel and its
 * assistant) read the SAME list, so they never disagree.
 */
export function listResearchDocs(pf = ''): { agent: string; docs: ResearchDoc[] }[] {
  const agents = [MAIN_AGENT_ID, ...listAgentNames()]
  return agents.map(agent => {
    const realRoot = realResearchRoot(agent)
    const names: string[] = []
    if (realRoot) walk(realRoot, '', 1, names)
    const docs = names
      .map(name => {
        let title = name
        let ms = 0
        let content = ''
        try {
          const file = join(realRoot!, name)
          content = readFileSync(file, 'utf-8')
          title = titleOf(content, name)
          ms = statSync(file).mtimeMs
        } catch {
          /* keep filename as title */
        }
        return { name, title, ms, project: projectOf(agent, name, content) }
      })
      .filter(d => !pf || (pf === 'none' ? !d.project : d.project === pf))
      .sort((a, b) => (b.ms - a.ms) || a.name.localeCompare(b.name))
      .map(({ name, title, ms, project }) => ({ name, title, project, updated: new Date(ms).toISOString().slice(0, 10), ms }))
    return { agent, docs }
  }).filter(a => a.docs.length > 0)
    // Newest first everywhere: the agent group holding the freshest document comes first.
    .sort((a, b) => (b.docs[0].ms - a.docs[0].ms) || a.agent.localeCompare(b.agent))
}

/** Lowercase letters, digits, hyphen: the Research page lists only files named like that. */
function webSlug(text: string): string {
  const base = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  return base || 'kereses'
}

export interface WebCaptureInput { tool: string; query: string; url: string; text: string; project?: string; at?: Date }
export type WebCaptureResult = { ok: true; name: string; duplicate: boolean } | { ok: false; code: 'bad_input' | 'unreachable'; detail: string }

/**
 * #908: whatever an agent found on the web is saved into ITS research folder, by the system, not by the agent's
 * memory of a rule. Never overwrites: a taken name gets -2, -3; the same text under the same name is not saved
 * twice. No size limit: the page shows what the agent read, whole.
 */
export function saveWebResearch(dir: string, input: WebCaptureInput): WebCaptureResult {
  const tool = String(input.tool || '').trim()
  const query = String(input.query || '').trim()
  const urlText = String(input.url || '').trim()
  const text = String(input.text || '')
  if (!text.trim()) return { ok: false, code: 'bad_input', detail: 'text is empty' }
  if (!query && !urlText) return { ok: false, code: 'bad_input', detail: 'query or url is required' }
  const title = (query || urlText).replace(/\s+/g, ' ').slice(0, 120)
  const slug = 'web-' + webSlug(query || urlText)
  try { mkdirSync(dir, { recursive: true }) } catch (err) {
    return { ok: false, code: 'unreachable', detail: `the research folder cannot be created: ${(err as Error).message}` }
  }
  const proj = String(input.project || '').trim()
  const body = text.trim()
  let name = `${slug}.md`
  for (let i = 2; existsSync(join(dir, name)); i++) {
    try { if (readFileSync(join(dir, name), 'utf-8').includes(body)) return { ok: true, name, duplicate: true } } catch { /* keep going */ }
    name = `${slug}-${i}.md`
  }
  const head = [`# ${tool === 'WebFetch' ? 'Web oldal' : 'Web keresés'}: ${title}`, '']
  if (proj) head.push(`project: ${proj}`, '')
  head.push(`forrás: ${tool || 'web'}${query ? ` | keresés: ${query}` : ''}${urlText ? ` | cím: ${urlText}` : ''}`, `mentve: ${(input.at ?? new Date()).toISOString()}`, '')
  try { writeFileSync(join(dir, name), head.join('\n') + '\n' + body + '\n', { flag: 'wx' }) } catch (err) {
    return { ok: false, code: 'unreachable', detail: (err as Error).message }
  }
  return { ok: true, name, duplicate: false }
}

export async function tryHandleResearch(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // #908: the PostToolUse hook (scripts/hooks/web-research-save.py) posts every web search / page read here.
  if (path === '/api/research/capture' && method === 'POST') {
    let data: Record<string, unknown>
    try { data = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 * 1024 })).toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const agent = String(data.agent_id || '')
    if (![MAIN_AGENT_ID, ...listAgentNames()].includes(agent)) { json(res, { error: 'Unknown agent' }, 404); return true }
    const r = saveWebResearch(researchDir(agent), {
      tool: String(data.tool || ''), query: String(data.query || ''), url: String(data.url || ''),
      text: String(data.text || ''), project: String(data.project || ''),
    })
    if (!r.ok) { json(res, { ok: false, code: r.code, error: r.detail }, r.code === 'bad_input' ? 400 : 500); return true }
    json(res, { ok: true, agent, name: r.name, duplicate: r.duplicate })
    return true
  }

  if (path === '/api/research' && method === 'GET') {
    // ?project=<id> / ?project=none -- the Research page filtered to a project.
    json(res, listResearchDocs(url.searchParams.get('project') || ''))
    return true
  }

  // The doc segment may carry "/" (percent-encoded by the client, raw if a
  // proxy normalized it), so it is matched greedily and validated after
  // decoding rather than constrained by the route pattern.
  const match = path.match(/^\/api\/research\/([^/]+)\/(.+)$/)
  if (match && method === 'GET') {
    let agent: string
    let name: string
    try {
      agent = decodeURIComponent(match[1])
      name = decodeURIComponent(match[2])
    } catch {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    if (!isSafeRelPath(name)) {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    if (!agents.includes(agent)) {
      json(res, { error: 'Unknown agent' }, 404)
      return true
    }
    const realRoot = realResearchRoot(agent)
    const file = realRoot ? resolveInside(realRoot, join(realRoot, name)) : null
    // Containment failure is reported as 404, not 403: whether the escaping
    // target exists is not something this endpoint should confirm.
    let isFile = false
    try {
      isFile = file !== null && statSync(file).isFile()
    } catch {
      isFile = false
    }
    if (!file || !isFile) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    const content = readFileSync(file, 'utf-8')
    json(res, { agent, name, title: titleOf(content, name), content, project: projectOf(agent, name, content) })
    return true
  }

  return false
}

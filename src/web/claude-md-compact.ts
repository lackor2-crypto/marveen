// Startup-context diet (#799): shrink a hand-written CLAUDE.md without losing a
// single rule. Every `## ` section above the threshold is moved, byte for byte,
// to <details-dir>/<slug>.md and replaced by its heading, a short digest (the
// opening of the section) and a pointer to the full text. Generated marker
// blocks (<!-- BEGIN GENERATED ... --> ... <!-- END GENERATED ... -->) are left
// alone: their generators already write digests (rule-digests.ts).
//
// Idempotent: a section that already carries the pointer is skipped, so running
// it on every dashboard start is safe.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import { ruleDetailsDir } from './rule-digests.js'

export const POINTER = 'Teljes szoveg (olvasd el, ha kell): '

export function slugify(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section'
}

/** Opening of a section body, cut at a sentence end below `max` chars. */
export function digestOf(bodyLines: string[], max: number): string {
  const text = bodyLines.join('\n').trim()
  const first = text.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').trim()
  if (first.length <= max) return first
  const cut = first.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(': '))
  if (stop > max * 0.5) return cut.slice(0, stop + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > 0 ? cut.slice(0, sp) : cut) + ' ...'
}

/** Splits the text into units: the preamble, generated blocks (kept verbatim)
 *  and `## ` sections. Fenced code and generated blocks never start a section. */
export function splitSections(text: string): Array<{ kind: 'pre' | 'generated' | 'section'; lines: string[] }> {
  const lines = text.split('\n')
  const units: Array<{ kind: 'pre' | 'generated' | 'section'; lines: string[] }> = []
  let cur: { kind: 'pre' | 'generated' | 'section'; lines: string[] } = { kind: 'pre', lines: [] }
  let inFence = false
  let inGenerated = false
  const push = () => { if (cur.lines.length) units.push(cur) }
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence
    if (/<!-- BEGIN GENERATED/.test(line) && !inFence) {
      push(); cur = { kind: 'generated', lines: [line] }; inGenerated = true; continue
    }
    if (inGenerated) {
      cur.lines.push(line)
      if (/<!-- END GENERATED/.test(line)) { push(); cur = { kind: 'pre', lines: [] }; inGenerated = false }
      continue
    }
    if (/^## /.test(line) && !inFence) {
      push(); cur = { kind: 'section', lines: [line] }; continue
    }
    cur.lines.push(line)
  }
  push()
  return units
}

export interface CompactOptions { threshold?: number; digest?: number; prefix?: string; detailsDir: string }
export interface MovedSection { slug: string; file: string; text: string }

export function compactText(text: string, opts: CompactOptions): { text: string; moved: MovedSection[] } {
  const { threshold = 700, digest = 240, prefix = 'main', detailsDir } = opts
  const out = []
  const moved: MovedSection[] = []
  const used = new Set<string>()
  for (const u of splitSections(text)) {
    const body = u.lines.join('\n')
    if (u.kind !== 'section' || body.length <= threshold || body.includes(POINTER)) { out.push(body); continue }
    const heading = u.lines[0]
    let slug = `${prefix}-${slugify(heading)}`
    for (let i = 2; used.has(slug); i++) slug = `${prefix}-${slugify(heading)}-${i}`
    used.add(slug)
    const file = join(detailsDir, `${slug}.md`)
    moved.push({ slug, file, text: body.replace(/\s+$/, '') + '\n' })
    out.push([heading, '', digestOf(u.lines.slice(1), digest), '', POINTER + file, ''].join('\n'))
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), moved }
}

/** Compacts one CLAUDE.md in place. Returns the byte sizes, or null when the
 *  file is missing/unreadable. Details are written BEFORE the file is shortened,
 *  so a crash in between can only leave a duplicate, never a lost rule. */
export function compactClaudeMdFile(
  file: string,
  prefix: string,
  opts: { threshold?: number; digest?: number; detailsDir?: string; dryRun?: boolean } = {},
): { before: number; after: number; moved: number } | null {
  let original: string
  try {
    original = readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  const detailsDir = opts.detailsDir ?? ruleDetailsDir()
  const { text, moved } = compactText(original, { threshold: opts.threshold, digest: opts.digest, prefix, detailsDir })
  if (!opts.dryRun && moved.length) {
    mkdirSync(detailsDir, { recursive: true })
    for (const m of moved) atomicWriteFileSync(m.file, m.text)
    atomicWriteFileSync(file, text)
  }
  return { before: original.length, after: text.length, moved: moved.length }
}

/** Every agent's own CLAUDE.md under agentsRoot (hand-written sections only). */
export function compactAgentClaudeMds(agentsRoot: string, opts: Parameters<typeof compactClaudeMdFile>[2] = {}): void {
  if (!existsSync(agentsRoot)) return
  for (const name of readdirSync(agentsRoot)) {
    const file = join(agentsRoot, name, 'CLAUDE.md')
    if (existsSync(file)) compactClaudeMdFile(file, name, opts)
  }
}

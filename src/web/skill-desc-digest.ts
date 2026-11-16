// Startup-context diet (#799): the harness lists every skill's name + description at
// each start (~10k tokens for ~100 skills). A description above the limit is shortened
// in the front matter and its ORIGINAL full text is kept, byte for byte, as the first line of
// the skill body -- nothing is lost, the skill still shows it in full when it is opened.
//
// Idempotent: a description at or below the limit is never touched, and a shortened one
// already is.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

export const SKILL_DESC_MAX = 220
export const FULL_DESC_MARKER = '> Teljes leírás / Full description: '

/** Shortens one description to at most `max` chars: at a sentence end when one falls in the
 *  second half, else at a word, then " ...". No ": " cut (a trailing colon is not a safe plain YAML scalar). */
export function shortenDescription(desc: string, max = SKILL_DESC_MAX): string {
  const one = desc.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const cut = one.slice(0, max - 4)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (stop > cut.length * 0.5) return cut.slice(0, stop + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[:,;\s]+$/, '') + ' ...'
}

/** Rewrites the text of one SKILL.md, or returns null when nothing is to be done. */
export function compactSkillText(text: string, max = SKILL_DESC_MAX): string | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const lines = m[1].split('\n')
  const i = lines.findIndex((l) => l.startsWith('description:'))
  if (i < 0) return null
  const raw = lines[i].slice('description:'.length).trim()
  // Only the plain one-line form is rewritten; quoted and block scalars are left alone.
  if (!raw || /^["'>|]/.test(raw) || (lines[i + 1] !== undefined && /^\s+\S/.test(lines[i + 1]))) return null
  if (raw.length <= max) return null
  lines[i] = 'description: ' + shortenDescription(raw, max)
  const head = '---\n' + lines.join('\n') + '\n---\n'
  const body = text.slice(m[0].length)
  return head + '\n' + FULL_DESC_MARKER + raw + '\n' + (body.startsWith('\n') ? body : '\n' + body)
}

/** Compacts every <dir>/<skill>/SKILL.md. Returns how many files were changed. */
export function compactSkillsDir(dir: string, opts: { max?: number; dryRun?: boolean } = {}): { changed: number; saved: number } {
  let changed = 0
  let saved = 0
  if (!existsSync(dir)) return { changed, saved }
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'SKILL.md')
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const next = compactSkillText(text, opts.max)
    if (next === null) continue
    const before = (text.match(/^description:(.*)$/m)?.[1] ?? '').length
    const after = (next.match(/^description:(.*)$/m)?.[1] ?? '').length
    saved += before - after
    changed++
    if (!opts.dryRun) atomicWriteFileSync(file, next)
  }
  return { changed, saved }
}

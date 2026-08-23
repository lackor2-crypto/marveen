/**
 * Legyártja a "Mi változott az upstreamben?" tételes listát.
 *
 *   npx tsx scripts/upstream-changelog.ts            # csak a hiányzó fordítások
 *   npx tsx scripts/upstream-changelog.ts --no-llm   # fordítás nélkül, csak git
 *
 * Kimenet: store/upstream-changes.json (atomikusan). A magyar szövegek sha-ra
 * gyorsítótárazódnak ugyanabban a fájlban, tehát egy második futás csak az ÚJ
 * commitokért hív modellt. Százhúsz tétel újrafordítása se pénzben, se időben
 * nem indokolt, és a szöveg sem lenne jobb tőle.
 *
 * A git-oldal ugyanaz a mérés, mint a scripts/upstream-divergence-check.sh-ban:
 * merge-base, majd base..upstream. A munkakönyvtárhoz nem nyúlunk (csak log és
 * show), így akkor is biztonságos, amikor ügynökök dolgoznak a repóban.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSecret } from '../src/web/vault.js'
import {
  classifySubject, mergeHungarian, missingSummaryCount,
  buildSummaryPrompt, parseSummaryResponse, buildFileIndex, fileCounts,
  type UpstreamCommit, type UpstreamChangelog,
} from '../src/upstream-changelog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'store', 'upstream-changes.json')
const STATUS = join(ROOT, 'store', 'upstream-sync-status.json')
const MODEL = 'openai/gpt-4o-mini'
const BATCH = 8

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function localRef(): string {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  return r === 'HEAD' ? 'main' : r
}

function upstreamRef(): string {
  try {
    const sym = git(['symbolic-ref', '-q', 'refs/remotes/upstream/HEAD']).trim()
    if (sym) return sym.replace(/^refs\/remotes\//, '')
  } catch { /* nincs beallitva -- lentebb esunk vissza */ }
  return 'upstream/develop'
}

/**
 * Honnan nezzuk az elterest.
 *
 * A `git revert -m 1` a TARTALMAT adja vissza, a historiat nem: a visszavont
 * behuzas merge commitja elozmeny marad, ezert a git ugy latja, hogy azokat a
 * commitokat mar behuztuk. Merve 2026-08-23-an: a lista 137 commit helyett
 * 1-et mutatott volna. A viszonyitasi pont ilyenkor a behuzas ELOTTI allapot.
 *
 * Nem talalgatunk: a `git revert` altal irt "This reverts commit <sha>" sorbol
 * olvassuk ki a celt, es csak akkor lepunk vissza, ha az valoban MERGE (ket
 * szulo), aminek a masodik szuloje az upstream aganak elozmenye. Egyszeru
 * commit visszavonasa nem mozditja a viszonyitasi pontot.
 *
 * Ugyanez a logika all a scripts/upstream-divergence-check.sh-ban -- a ket
 * mérésnek ugyanabbol a pontbol kell neznie, kulonben a kartya es a lista
 * mashogy szamolna ugyanazt.
 */
function compareFrom(local: string, upstream: string): string {
  let from = local
  // A --grep csak ELO-SZURO, szandekosan horgony nelkul: a kalap-horgony mukodne (merve
  // 2026-08-23, a git soronkent horgonyoz), de finom szemantikara epulne --
  // ha az valaha megvaltozik, a kereses NEMAN ures lesz. A valodi feltetel a
  // soralapu /m regex es a merge-ellenorzes alabb.
  const revs = git(['log', local, '--format=%H', '--grep=This reverts commit']).split('\n')
  for (const rev of revs) {
    if (!rev.trim()) continue
    const body = git(['log', '-1', '--format=%B', rev.trim()])
    const m = body.match(/^This reverts commit ([0-9a-f]{7,40})/m)
    if (!m) continue
    let parents: string[]
    try {
      parents = git(['log', '-1', '--format=%P', m[1]]).trim().split(/\s+/).filter(Boolean)
    } catch { continue }
    if (parents.length !== 2) continue          // nem merge -> nem erdekel
    try {
      git(['merge-base', '--is-ancestor', parents[1], upstream])
    } catch { continue }                        // nem az upstreambol jott
    from = git(['rev-parse', `${m[1]}^1`]).trim()
    // A legREGEBBI ilyen visszavonas a helyes kiindulopont, ezert nem allunk meg.
  }
  return from
}

function conflictingFiles(): Set<string> {
  if (!existsSync(STATUS)) return new Set()
  try {
    const o = JSON.parse(readFileSync(STATUS, 'utf8')) as { conflictingFiles?: unknown }
    return new Set(Array.isArray(o.conflictingFiles) ? o.conflictingFiles.filter((f): f is string => typeof f === 'string') : [])
  } catch {
    return new Set()
  }
}

const SEP = '\x1e'
const FS_ = '\x1f'

function collect(local: string, upstream: string, base: string, conflicts: Set<string>): UpstreamCommit[] {
  // Egy hivas, gepi elvalasztokkal: a commit-uzenetek tartalmaznak sortorest,
  // idezojelet es zarojelet is, tehat soralapu parszolas itt nem all meg.
  const raw = git(['log', '--reverse', `--format=${SEP}%H${FS_}%h${FS_}%cI${FS_}%s${FS_}%b${FS_}`,
                   '--name-only', `${base}..${upstream}`])
  const out: UpstreamCommit[] = []
  for (const chunk of raw.split(SEP)) {
    if (!chunk.trim()) continue
    const parts = chunk.split(FS_)
    if (parts.length < 5) continue
    const [sha, short, iso, subject, body] = parts
    const files = parts.slice(5).join(FS_).split('\n').map(l => l.trim()).filter(Boolean)
    const c = classifySubject(subject)
    out.push({
      sha, short, date: iso.slice(0, 10),
      type: c.type, scope: c.scope, pr: c.pr, title: c.title, subject,
      files,
      touchesConflict: files.some(f => conflicts.has(f)),
      hu: null,
      // a torzs csak a forditashoz kell, a kimenetbe nem irjuk ki
      ...(body ? { _body: body } as Record<string, never> : {}),
    })
  }
  return out
}

function apiKey(): string | null {
  // A szef az elsodleges forras (ugyanaz a kulcs, amit a flotta hasznal), a
  // kornyezeti valtozo csak tartalek. Az ERTEKET sehol nem irjuk ki -- a
  // naplokba szivargo titok mar egyszer megtortent ezen a gepen.
  try {
    const key = getSecret('openrouter-fleet-key')
    if (key) return key
  } catch { /* nincs szef vagy nincs kulcs -- megy tovabb */ }
  return process.env.OPENROUTER_API_KEY || null
}

async function translate(items: UpstreamCommit[], key: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const prompt = buildSummaryPrompt(batch.map(b => ({
      sha: b.sha, subject: b.subject,
      body: String((b as unknown as Record<string, unknown>)._body ?? ''),
      files: b.files,
    })))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://marveen.local',
          'X-Title': 'Marveen Upstream Changelog',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 2000,
        }),
      })
      if (!res.ok) {
        process.stderr.write(`  batch ${i / BATCH + 1}: HTTP ${res.status}\n`)
        continue
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = data.choices?.[0]?.message?.content ?? ''
      const got = parseSummaryResponse(text, batch.map(b => b.sha))
      Object.assign(result, got)
      process.stderr.write(`  ${Object.keys(result).length}/${items.length} kesz\n`)
    } catch (e) {
      process.stderr.write(`  batch ${i / BATCH + 1}: ${(e as Error).message}\n`)
    } finally {
      clearTimeout(timer)
    }
  }
  return result
}

async function main(): Promise<void> {
  const noLlm = process.argv.includes('--no-llm')
  const local = localRef()
  const upstream = upstreamRef()
  const base = git(['merge-base', compareFrom(local, upstream), upstream]).trim()
  const conflicts = conflictingFiles()
  let commits = collect(local, upstream, base, conflicts)

  const previous: UpstreamCommit[] = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, 'utf8')) as UpstreamChangelog).commits ?? []
    : []
  commits = mergeHungarian(commits, previous)

  const missing = commits.filter(c => !c.hu)
  process.stderr.write(`${commits.length} commit, ebbol ${missing.length} meg nincs magyarul\n`)
  if (!noLlm && missing.length > 0) {
    const key = apiKey()
    if (!key) {
      process.stderr.write('nincs OPENROUTER_API_KEY -- a lista forditas nelkul keszul el\n')
    } else {
      const got = await translate(missing, key)
      for (const c of commits) if (!c.hu && got[c.sha]) c.hu = got[c.sha]
    }
  }

  // A fajl-nezet a MERT elteresbol keszul (diff base..upstream), nem a commitok
  // fajljainak uniojabol: a merge commitok nem sorolnak fel fajlokat, tehat az
  // unio kevesebb (nalunk 190 a 191 helyett). Ha innen jonne, a kartya es a
  // lista MASHOGY szamolna ugyanazt -- pont az az ellentmondas, ami miatt az
  // egesz kerdes felmerult.
  const diffFiles = git(['diff', '--name-only', base, upstream])
    .split('\n').map(l => l.trim()).filter(Boolean)
  const files = buildFileIndex(diffFiles, Array.from(conflicts), commits)
  const fc = fileCounts(files)

  const payload: UpstreamChangelog = {
    generatedAt: new Date().toISOString(),
    localRef: local, upstreamRef: upstream, base,
    // a torzs csak a forditashoz kellett
    commits: commits.map(({ ...c }) => {
      delete (c as unknown as Record<string, unknown>)._body
      return c
    }),
    files,
  }
  const tmp = `${OUT}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2))
  renameSync(tmp, OUT)
  process.stderr.write(`kesz: ${OUT} (${missingSummaryCount(payload.commits)} tetel maradt magyar szoveg nelkul)\n`)
  process.stderr.write(`fajlok: ${fc.total} (${fc.conflict} utkozo + ${fc.clean} tiszta)\n`)
}

main().catch(e => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1) })

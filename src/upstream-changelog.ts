/**
 * "Mi változott az upstreamben?" -- emberi nyelven, tételesen.
 *
 * Boss, 2026-08-19: "csak ezzel az a baj hogy ebbol nem latok semmit sem. azt
 * kellene kiirnia hogy mit javitottak rajta!? erted? emberi nyelven. es hogy
 * ezek kellenek e nekunk. [...] mert lesz biztos olyan amit nem akarok hogy
 * bekeruljon."
 *
 * Addig a doboz négy fájlNEVET mutatott (az ütközőket), amiből tényleg nem
 * derül ki semmi. Ami eldönthető, az nem fájl és nem is "169 tisztán áthúzható
 * fájl": egy fájlt nem lehet külön behúzni, mert a változás egysége a COMMIT.
 * A 112 upstream commit érinti azt a 191 fájlt (22 ütköző + 169 tiszta) --
 * tehát a lista, amin végig lehet menni, 112 tételes, nem 169.
 *
 * Ez a modul a nyers git-adatot alakítja ilyen listává:
 *   - a conventional commit előtagból (fix/feat/docs...) DOBOZ lesz: a
 *     javítások külön, a fejlesztések külön, a többi a végén;
 *   - minden tételhez tartozik egy rövid magyar leírás (a fordítást a
 *     scripts/upstream-changelog.ts kéri le, és sha-ra gyorsítótárazza, hogy
 *     egy commit szövegéért soha ne fizessünk kétszer);
 *   - és az, hogy a commit hozzáér-e ütköző fájlhoz, mert azok azok, amiket
 *     nem lehet csak úgy áthúzni.
 *
 * Itt csak tiszta függvények vannak: se git, se hálózat. A tesztek emiatt a
 * valódi elágazásokat tudják hajtani, nem egy szerencsés gépállapotot.
 */

export type ChangeKind = 'javitas' | 'fejlesztes' | 'egyeb'

export interface UpstreamCommit {
  sha: string
  short: string
  /** ISO nap (YYYY-MM-DD), hogy látszódjon, mennyire friss a tétel. */
  date: string
  /** conventional előtag: fix, feat, docs, chore, refactor, test, perf, ci... */
  type: string
  /** a zárójeles hatókör, pl. "vault" -- lehet null. */
  scope: string | null
  /** a GitHub PR száma a tárgy végéről, ha van. */
  pr: number | null
  /** az eredeti angol tárgysor, előtag és PR-szám nélkül. */
  title: string
  /** a teljes eredeti tárgysor, ahogy a gitben áll. */
  subject: string
  files: string[]
  /** hozzáér-e olyan fájlhoz, ami nálunk ütközik. */
  touchesConflict: boolean
  /** rövid magyar leírás; null, amíg nem készült el hozzá. */
  hu: string | null
}

/** Egy eltérő fájl, és ami vele történt.
 *
 *  Boss, 2026-08-20: "hol vanak leirva mind a 169 tetel hogy azok mik?" A
 *  változás-lista egysége a commit (112 tétel), de a kérdés a MÁSIK oldalról
 *  jön: melyik az a 169 fájl, és mi történt bennük. Ez a nézet erre felel.
 *
 *  A `shas` üres is lehet: az összefésülő (merge) commitok nem sorolnak fel
 *  fájlokat, így egy-két fájl (nálunk a package.json és a package-lock.json)
 *  csak összefésüléskor változott. Ezt kiírjuk, nem elhallgatjuk -- különben a
 *  fájl ott állna magyarázat nélkül. */
export interface UpstreamFile {
  path: string
  /** Nálunk is módosult, tehát nem lehet csak úgy áthúzni. */
  conflict: boolean
  /** Mely commitok nyúltak hozzá (a lista sorrendjében). */
  shas: string[]
}

export interface UpstreamChangelog {
  generatedAt: string
  localRef: string
  upstreamRef: string
  base: string
  commits: UpstreamCommit[]
  files?: UpstreamFile[]
}

/** A fájl-nézet felépítése.
 *
 *  A fájlok listája a MÉRT eltérésből jön (git diff BASE..UPSTREAM), nem a
 *  commitok fájljainak uniójából -- különben a két szám (a kártyán 191, itt
 *  190) csendben szétcsúszna, és pont az a fajta ellentmondás keletkezne, ami
 *  miatt az egész kérdés felmerült.
 *
 *  Sorrend: előbb az ütközők (azokkal kell foglalkozni), utána a tiszták,
 *  mindkettőn belül ábécében -- egy 191 elemű listában a kereshetőség többet
 *  ér, mint bármilyen "fontossági" sorrend. */
export function buildFileIndex(
  diffFiles: string[],
  conflicting: string[],
  commits: UpstreamCommit[],
): UpstreamFile[] {
  const conflictSet = new Set(conflicting)
  const byFile = new Map<string, string[]>()
  for (const c of commits) {
    for (const f of c.files) {
      const list = byFile.get(f)
      if (list) list.push(c.sha)
      else byFile.set(f, [c.sha])
    }
  }
  // Set: ugyanaz a fájlnév kétszer nem kerülhet a listába, akkor sem, ha a
  // bemenetben duplán szerepel.
  const unique = Array.from(new Set(diffFiles))
  const out = unique.map(path => ({
    path,
    conflict: conflictSet.has(path),
    shas: byFile.get(path) ?? [],
  }))
  out.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  return out
}

/** A fájl-nézet számai. Ugyanabból a listából, amit a felület mutat, hogy a
 *  fejléc ne mondhasson mást, mint a sorok. */
export function fileCounts(files: UpstreamFile[]): { total: number; conflict: number; clean: number } {
  const conflict = files.filter(f => f.conflict).length
  return { total: files.length, conflict, clean: files.length - conflict }
}

/** Melyik előtag melyik dobozba tartozik.
 *
 *  A "javítás" doboz azért külön, mert a Boss szerint "azok valoszinu kellenek.
 *  mind" -- egy hibajavítást ritkán akar az ember kihagyni, egy új funkciót
 *  annál gyakrabban. A revert szándékosan javítás: az is elrontott dolgot vesz
 *  vissza. */
export function kindOfType(type: string): ChangeKind {
  const t = type.toLowerCase()
  if (t === 'fix' || t === 'hotfix' || t === 'bugfix' || t === 'revert') return 'javitas'
  if (t === 'feat' || t === 'feature') return 'fejlesztes'
  return 'egyeb'
}

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?:\s*(?<rest>.+)$/i
const PR_RE = /\s*\(#(\d+)\)\s*$/

/** Szétszedi a commit tárgysorát. Ami nem conventional formájú, az sem vész
 *  el: type = "egyeb", és a teljes sor lesz a cím -- egy fel nem ismert forma
 *  nem lehet ok arra, hogy egy változás lecsússzon a listáról. */
export function classifySubject(subject: string): {
  type: string; scope: string | null; pr: number | null; title: string; kind: ChangeKind
} {
  const s = subject.trim()
  const prMatch = s.match(PR_RE)
  const pr = prMatch ? Number(prMatch[1]) : null
  const withoutPr = prMatch ? s.slice(0, prMatch.index).trim() : s
  const m = withoutPr.match(HEADER_RE)
  if (!m || !m.groups) {
    return { type: 'egyeb', scope: null, pr, title: withoutPr, kind: 'egyeb' }
  }
  const type = m.groups.type.toLowerCase()
  const scope = m.groups.scope ? m.groups.scope.trim() : null
  return { type, scope, pr, title: m.groups.rest.trim(), kind: kindOfType(type) }
}

/** Dobozokba rendezés, dobozon belül a legfrissebb elöl. Egyetlen commit sem
 *  tűnhet el: a három csoport elemszámának összege = a bemenet hossza (ezt
 *  teszt is őrzi). */
export function groupCommits(commits: UpstreamCommit[]): Record<ChangeKind, UpstreamCommit[]> {
  const out: Record<ChangeKind, UpstreamCommit[]> = { javitas: [], fejlesztes: [], egyeb: [] }
  for (const c of commits) out[kindOfType(c.type)].push(c)
  for (const k of Object.keys(out) as ChangeKind[]) {
    out[k].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }
  return out
}

/** A modellnek adott feladat. Szándékosan szűk: a commit tárgya, a törzs eleje
 *  és a fájlnevek. Nem kérünk tőle véleményt arról, kell-e nekünk -- azt a
 *  Boss dönti el, és egy modell "hasznos/nem hasznos" címkéje pont azt a
 *  döntést venné el tőle, amiért az egész lista készül. */
export function buildSummaryPrompt(items: { sha: string; subject: string; body: string; files: string[] }[]): string {
  const blocks = items.map(it => {
    const files = it.files.slice(0, 8).join(', ')
    const body = it.body.replace(/\s+/g, ' ').trim().slice(0, 600)
    return `### ${it.sha}\nSUBJECT: ${it.subject}\nBODY: ${body || '(nincs)'}\nFILES: ${files}`
  }).join('\n\n')
  return `Egy magyar felhasználónak kell megértenie, mi változott egy nyílt forráskódú projektben. Minden alábbi commithoz írj EGY rövid, magyar összefoglalót: 1-2 mondat, legfeljebb 240 karakter. Mondd meg, MIT javítottak vagy MIT fejlesztettek és MIÉRT számít -- ne ismételd a fájlneveket, ne használj angol szakszavakat, ha van magyar megfelelőjük, és ne kezdd minden mondatot ugyanúgy. Ne írj bevezetőt.

A válasz KIZÁROLAG egy JSON tömb legyen, ebben a formában:
[{"sha":"<a fenti sha>","hu":"<a magyar összefoglaló>"}]

${blocks}`
}

/** A modell válaszának beolvasása. Csak azt fogadjuk el, ami sha szerint
 *  tényleg a kért tételekhez tartozik: egy elcsúszott sorrendű válasz
 *  különben csendben MÁS commithoz írná a leírást, és pont az a fajta hiba
 *  lenne, ami sose derül ki. */
export function parseSummaryResponse(raw: string, wantedShas: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const want = new Set(wantedShas)
  const text = raw.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let arr: unknown
  try {
    arr = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(arr)) return out
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const sha = typeof o.sha === 'string' ? o.sha : ''
    const hu = typeof o.hu === 'string' ? o.hu.trim() : ''
    if (!sha || !hu || !want.has(sha)) continue
    out[sha] = hu.length > 400 ? hu.slice(0, 400) : hu
  }
  return out
}

/** A friss git-lista + a korábban elkészült magyar szövegek összefésülése.
 *
 *  A gyorsítótár kulcsa a sha, ami egy commitnál soha nem változik, tehát egy
 *  már lefordított tételért nem fizetünk kétszer. Ami kiesett az upstreamből
 *  (visszavont ág, átírt előzmény), az a kimenetből is kiesik -- a lista
 *  mindig a MOSTANI eltérést mutatja, nem gyűjtemény. */
export function mergeHungarian(fresh: UpstreamCommit[], previous: UpstreamCommit[]): UpstreamCommit[] {
  const cache = new Map(previous.filter(p => p.hu).map(p => [p.sha, p.hu as string]))
  return fresh.map(c => (c.hu ? c : { ...c, hu: cache.get(c.sha) ?? null }))
}

/** Hány tételhez nincs még magyar szöveg. A felület ezt mondja ki, hogy egy
 *  félbemaradt fordítás ne látsszon kész listának. */
export function missingSummaryCount(commits: UpstreamCommit[]): number {
  return commits.filter(c => !c.hu).length
}

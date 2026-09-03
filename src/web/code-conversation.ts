// EGY VS CODE BESZELGETES TARTALMA, OLVASHATOAN.
//
// Boss, 2026-08-28: "hat ha me van a bekototte, akor miert nem jeleniti meg a
// chat beszelgetest a kartyan??? miert csk mondja hogy megvan de nem mutatja
// meg?"
//
// A kartya eddig TUDOTT a beszelgetesrol (nev, kontextus-tokenszam), de a
// tartalmat nem tudta megnyitni: a napló (`<sessionId>.jsonl`) azon a gepen
// van, ahol a Claude Code fut, es a projekt-mappa neve egy slug, amit
// kitalalni tippeles volna. Ezert a worker mostantol elkuldi a napló TELJES
// utjat (`transcriptPath`), es ez a modul abbol csinal idovonalat.
//
// Miert kulon modul, es miert nem az `agent-conversation.ts`: az az ugynokok
// TELEGRAM-forgalmara van szabva -- csak a `<channel>` burkolatu user-uzenetet
// veszi be, es minden mas beirast eldob. Egy VS Code chatben viszont a user
// uzenete SIMA SZOVEG, tehat ugyanaz a parser itt URES beszelgetest mutatna.
//
// ★ A NULLA KET DOLGOT JELENTHET. Az ures idovonal itt is ketfele lehet:
// "meg nincs benne semmi" vagy "nem latok oda" (nincs `transcriptPath`, mas
// gepen fut a Claude Code, lecsatolt meghajto). Ezert ad ez a modul mindig
// `reason`-t is, es a `reason` a TENYLEGES hibauzenet -- sosem tipp.

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { toLocalWorkspacePath } from './code-bridge-workspace.js'

/** Egy sor az idovonalon. */
export interface CodeConvEntry {
  ts: string | null
  /**
   *  - `user`      : amit TE irtal be a chatbe
   *  - `assistant` : amit a Claude valaszolt (szoveg)
   *  - `action`    : egy eszkoz, amit futtatott (Bash, Read, Edit, ...)
   */
  kind: 'user' | 'assistant' | 'action'
  text: string
  /** Emberi cimke a muveletekhez (`Bash`, `Read: file.ts`); mashol `null`. */
  label: string | null
  /**
   * ITT UJ AG KEZDODIK: ez a beiras nem a folotte allo valaszra epul, hanem egy
   * KORABBI pontra -- a beszelgetes ketteagazott.
   *
   * Enelkul a nezet hazudik: a napló fajlsorrendben olvasva ket parhuzamos agat
   * egyetlen folyamatos beszelgetesnek mutat. Merve (2026-09-03, a
   * 277f9773 napló): a Marveenbol kuldott utasitas es a VS Code panelbe irt
   * uzenet UGYANARRA a szulore (`9431bd96`) epult, egy ora kulonbseggel --
   * a ket ag nem latja egymast, es eddig semmi nem szolt errol.
   */
  branchStart?: true
}

export interface CodeConvResult {
  entries: CodeConvEntry[]
  /** Az OSSZES bejegyzes szama, nem csak a most visszaadott ablake. */
  total: number
  offset: number
  /** Van-e meg regebbi bejegyzes a betoltott ablak elott. */
  hasOlder: boolean
  /** A napló utja azon a gepen, ahol a Claude Code fut.
   *  (A dashboard NEM irja ki: az ugynok-API es a hibakereses hasznalja.) */
  transcriptPath: string | null
  /** Hany helyen agazik ketté a beszelgetes a betoltott ablakban. `0` = egy szal. */
  branchCount: number
  /** Mikor irt utoljara a beszelgetes (ms). `null` = nem tudtuk megnezni. */
  mtime: number | null
  /** MIERT nincs tartalom. `null` = van. Sosem tipp: vagy a mi mondatunk arrol,
   *  amit MERTUNK, vagy a rendszer szo szerinti hibauzenete. */
  reason: string | null
}

/** Egy bejegyzes szovegenek felso hatara -- egy 150 MB-os napló egyetlen
 *  beillesztett fajlja kulonben elvinne az egesz valaszt. */
const MAX_TEXT = 6000
/** Ennel nagyobb naplot nem olvasunk be egyben. Merve: ebben a mappaban van
 *  156 MB-os transcript is, azt egy `readFileSync` a szerverrel egyutt vinne. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} …` : s
}

/**
 * BIZTONSAGI KAPU a napló utjara.
 *
 * A `transcriptPath` KULSO bemenet: a worker HTTP-n kuldi, es egy megtevesztett
 * (vagy elrontott) worker barmilyen utat beirhatna. Ezert nem az szamit, hogy
 * "furcsan nez-e ki", hanem harom MERT feltetel:
 *   1. `.jsonl` kiterjesztes,
 *   2. a fajl NEVE maga a kert sessionId (tehat nem lehet mas fajlt kerni),
 *   3. az utban ott van a `.claude` + `projects` mappa (a Claude Code sajat
 *      naplo-konyvtara).
 * Barmelyik hianya eseten nem olvasunk -- nem azert, mert gyanus, hanem mert
 * ilyen utat a Claude Code sosem gyart.
 */
export function isSafeTranscriptPath(path: string, sessionId: string): boolean {
  if (!path || !sessionId || !UUID_RE.test(sessionId)) return false
  const norm = path.replace(/\\/g, '/')
  if (!norm.toLowerCase().endsWith('.jsonl')) return false
  if (norm.includes('..')) return false
  if (basename(norm) !== `${sessionId}.jsonl`) return false
  return /(^|\/)\.claude\/projects\//i.test(norm)
}

/** Egy eszkoz-hivas EGY SORBAN, emberi nyelven. Ugyanaz az elv, mint az
 *  ugynok-beszelgetesnel: a nyers JSON olvashatatlan, a puszta eszkoznev
 *  keves. */
function actionLabel(name: string, input: Record<string, unknown>): string {
  const base = name.includes('__') ? name.split('__').pop()! : name
  const pick = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (base === 'Bash') return `Bash: ${pick('description') || pick('command').slice(0, 120)}`
  if (base === 'Read') return `Read: ${pick('file_path')}`
  if (base === 'Write') return `Write: ${pick('file_path')}`
  if (base === 'Edit') return `Edit: ${pick('file_path')}`
  if (base === 'Glob') return `Glob: ${pick('pattern')}`
  if (base === 'Grep') return `Grep: ${pick('pattern')}`
  if (base === 'Task' || base === 'Agent') return `Ügynök: ${pick('description')}`
  if (base === 'WebSearch') return `Web keresés: ${pick('query')}`
  if (base === 'WebFetch') return `Web lekérés: ${pick('url')}`
  if (base === 'TodoWrite') return 'Teendőlista frissítése'
  return base
}

/**
 * Egy user-beiras SZOVEGE -- vagy `null`, ha ez nem tenyleges beiras volt.
 *
 * A napló `user` sorai kozott nem csak az van, amit TE irtal: ott ulnek az
 * eszkozok visszateresi ertekei, a rendszer-emlekeztetok es a slash-parancsok
 * kifejtett alakja is. Ezek beontese az idovonalba pont azt tenne
 * olvashatatlanna, amiert az egesz nezet keszult.
 */
function userText(content: unknown): string | null {
  // Regi naplokban a user-uzenet sima string.
  if (typeof content === 'string') {
    const t = content.trim()
    return t.length > 0 ? t : null
  }
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    // Az eszkoz-eredmeny is `user` sorban erkezik -- az nem beiras.
    if (block['type'] !== 'text') return null
    const t = typeof block['text'] === 'string' ? (block['text'] as string) : ''
    if (t.trim()) parts.push(t.trim())
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}

/** A gepi keretek, amiket a felhasznalo SOSEM irt be: ezek nem az o hangja. */
function isMachineNoise(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('Caveat: The messages below') ||
    t.startsWith('[Request interrupted')
  )
}

/** A napló egy sorabol legfeljebb egy-ket idovonal-bejegyzes. */
/**
 * HOL AGAZIK KETTE A BESZELGETES.
 *
 * A napló nem lista, hanem FA: minden rekord megmondja, melyikre epul
 * (`parentUuid`). Ha ket kulon BEIRAS epul ugyanarra a szulore, az ket
 * parhuzamos ag -- a ket oldal nem latja egymast.
 *
 * MIERT CSAK A BEIRASOK SZAMITANAK. Merve a 277f9773 naplón: 32 helyen volt
 * kozos szulo, de 31 ezek kozul `assistant` + `user` testverpar 0-3 masodpercen
 * belul -- ez MINDEN szerszamhivas normalis szerkezete. Ha azokat is jelolnenk,
 * a nezet tele lenne hamis "elagazas" csikkal, es a nezo leszokna roluk.
 * Egyetlen egy volt valodi: ket `user` beiras ugyanarrol a szulorol, egy ora
 * kulonbseggel. Ezert a szabaly a TIPUSRA epul, nem idokulonbsegre: az
 * idohatar onkenyes lenne, a "ket ember ket beirasa" nem az.
 *
 * A masodik es tovabbi beiras kap jelolest -- az ELSO a maga idejeben szabalyos
 * folytatas volt, nem az tert el.
 *
 * @param turns a BEGEPELT fordulók lanc-adatai, a napló sorrendjeben
 * @returns azoknak a beirasoknak az azonositoi, ahol uj ag kezdodik
 */
export function findConversationBranchStarts(
  turns: ReadonlyArray<{ uuid: string; parentUuid: string | null }>,
): Set<string> {
  const seenParent = new Set<string>()
  const starts = new Set<string>()
  for (const turn of turns) {
    // Gyokér-beiras (nincs szuloje): ez a beszelgetes/kompakt-szakasz eleje,
    // nem elagazas. Ket kulon gyokér nem egymas agai.
    if (!turn.parentUuid || !turn.uuid) continue
    if (seenParent.has(turn.parentUuid)) starts.add(turn.uuid)
    else seenParent.add(turn.parentUuid)
  }
  return starts
}

/** A napló-rekord lanc-adatai -- csak a begepelt fordulóknal kell. */
interface ChainInfo { uuid: string; parentUuid: string | null }

function parseLine(line: string, out: CodeConvEntry[]): ChainInfo | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const type = d['type']
  const ts = typeof d['timestamp'] === 'string' ? (d['timestamp'] as string) : null
  const msg = d['message'] as Record<string, unknown> | undefined
  if (!msg) return null

  if (type === 'user') {
    // A `isMeta`/`isCompactSummary` sorok nem beirasok, hanem a Claude Code
    // sajat konyvelese.
    if (d['isMeta'] === true || d['isCompactSummary'] === true) return null
    const text = userText(msg['content'])
    if (text === null || isMachineNoise(text)) return null
    out.push({ ts, kind: 'user', text: clip(text), label: null })
    // A lanc-adat CSAK innen mehet tovabb: ekkorra mar kiestek a szerszam-
    // valaszok es a gepi sorok, tehat ami marad, az valoban BEGEPELT forduló.
    const uuid = typeof d['uuid'] === 'string' ? (d['uuid'] as string) : ''
    const parentUuid = typeof d['parentUuid'] === 'string' ? (d['parentUuid'] as string) : null
    return uuid ? { uuid, parentUuid } : null
  }

  if (type === 'assistant') {
    const content = msg['content']
    if (!Array.isArray(content)) return null
    for (const block of content as Array<Record<string, unknown>>) {
      const bt = block['type']
      if (bt === 'text') {
        const txt = typeof block['text'] === 'string' ? (block['text'] as string).trim() : ''
        if (txt) out.push({ ts, kind: 'assistant', text: clip(txt), label: null })
      } else if (bt === 'tool_use') {
        const name = typeof block['name'] === 'string' ? (block['name'] as string) : ''
        const input = (block['input'] as Record<string, unknown>) ?? {}
        out.push({ ts, kind: 'action', text: actionLabel(name, input), label: name || null })
      }
    }
  }
  // Csak a begepelt fordulóknak van lanc-adata: az elagazast azok mutatjak meg.
  return null
}

/** A napló ELERHETOSEGE -- a tartalma NELKUL. */
export interface CodeConvMeta {
  transcriptPath: string | null
  /** Mikor irt utoljara a beszelgetes (ms). `null` = nem tudtuk megnezni. */
  mtime: number | null
  /** A napló merete bajtban. `null` = nem tudtuk megnezni. */
  size: number | null
  /** MIERT nem olvashato. `null` = olvashato. Sosem tipp. */
  reason: string | null
}

/**
 * A KAPU-LANC EGY HELYEN -- ezt hasznalja a teljes beolvasas ES a konnyu
 * (`meta=1`) lekerdezes is.
 *
 * MIERT KOZOS: az elo kovetes 2-3 masodpercenkent kerdez ra a naplora, es ha
 * ez a konnyu ut sajat kapu-lancot kapna, elobb-utobb MAS okot mondana, mint a
 * teljes beolvasas -- ugyanarra a fajlra ket kulonbozo valasz. A felhasznalo
 * ilyenkor azt latja, hogy a jelzo "elo", a lista meg azt irja, "nem latok
 * oda". A `local` mezot csak a beolvasas hasznalja; kifele nem megy.
 */
function statTranscript(
  transcriptPath: string | null,
  sessionId: string,
): CodeConvMeta & { local: string | null } {
  const no = (reason: string, path: string | null = null): CodeConvMeta & { local: null } =>
    ({ transcriptPath: path, mtime: null, size: null, reason, local: null })

  // 1. NEM LATUNK ODA: a worker meg nem kuldi az utat (regi peldany).
  if (!transcriptPath) return no('no-path')
  // 2. Az ut nem olyan, amilyet a Claude Code gyart -- ilyet nem nyitunk meg.
  if (!isSafeTranscriptPath(transcriptPath, sessionId)) return no('unsafe-path', transcriptPath)

  // 3. A Claude Code gepen ervenyes ut -> a MI gepunk szemevel. Ugyanaz a
  //    forditas, ami a workspace-eknel is fut (Windows `C:\...` -> `/mnt/c/...`).
  const local = toLocalWorkspacePath(transcriptPath)
  if (local === null) return no('unreachable: this path cannot be opened from here', transcriptPath)

  try {
    const st = statSync(local)
    // A "tul nagy" nem elerhetetlenseg: az mtime-ot MEGTUDTUK, tehat a
    // valtozast tovabbra is latjuk -- csak a tartalmat nem nyitjuk meg.
    return {
      transcriptPath, mtime: st.mtimeMs, size: st.size,
      reason: st.size > MAX_FILE_BYTES ? 'too-large' : null,
      local,
    }
  } catch (err) {
    // A TENYLEGES hibauzenet megy tovabb (ENOENT / EACCES / EIO): mindharomnal
    // MAS a kovetkezo lepes, es a tippelt ok rosszabb a semminel.
    return no(err instanceof Error ? err.message : String(err), transcriptPath)
  }
}

/**
 * CSAK AZ ALLAPOT: mikor irtak utoljara a naplot, es latunk-e ra egyaltalan.
 *
 * Ez az elo kovetes olcso kerdese. Egy `statSync`, semmi beolvasas -- ebben a
 * mappaban 156 MB-os transcript is van, azt 2-3 masodpercenkent beolvasni a
 * szervert vinne el. A felulet ebbol dont: ha az `mtime` nott, akkor -- es CSAK
 * akkor -- keri le a tartalmat.
 */
export function statCodeConversation(
  transcriptPath: string | null,
  sessionId: string,
): CodeConvMeta {
  const { local: _local, ...meta } = statTranscript(transcriptPath, sessionId)
  return meta
}

/**
 * A napló -> idovonal, lapozva.
 *
 * `offset` = hany LEGUJABB bejegyzest hagyjunk ki (0 = a legfrissebb lap),
 * `limit` = mekkora az ablak. Ugyanaz a lapozas, mint az ugynok-beszelgetesnel,
 * hogy a felulet ket helyen ne ketfelekeppen mukodjon.
 */
export function readCodeConversation(
  transcriptPath: string | null,
  sessionId: string,
  opts: { limit: number; offset: number },
): CodeConvResult {
  const empty = (
    reason: string | null, path: string | null = null, mtime: number | null = null,
  ): CodeConvResult => ({
    entries: [], total: 0, offset: 0, hasOlder: false, transcriptPath: path, mtime, reason,
    branchCount: 0,
  })

  const st = statTranscript(transcriptPath, sessionId)
  if (st.reason !== null || st.local === null) return empty(st.reason, st.transcriptPath, st.mtime)
  const { local, mtime } = st

  let raw: string
  try {
    raw = readFileSync(local, 'utf8')
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err), transcriptPath, mtime)
  }

  const all: CodeConvEntry[] = []
  // A begepelt fordulók lanc-adatai + az a hely, ahova a bejegyzesuk kerult.
  // Egy `user` rekord PONTOSAN egy bejegyzest ad, ezert az index stabil.
  const turns: Array<{ uuid: string; parentUuid: string | null; at: number }> = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const at = all.length
    const chain = parseLine(t, all)
    if (chain) turns.push({ ...chain, at })
  }
  const starts = findConversationBranchStarts(turns)
  for (const turn of turns) {
    if (starts.has(turn.uuid)) all[turn.at]!.branchStart = true
  }

  const total = all.length
  const end = Math.max(0, total - opts.offset)
  const start = Math.max(0, end - opts.limit)
  const window = all.slice(start, end)
  return {
    entries: window,
    branchCount: window.filter((e) => e.branchStart === true).length,
    total,
    offset: opts.offset,
    hasOlder: start > 0,
    transcriptPath,
    mtime,
    reason: null,
  }
}

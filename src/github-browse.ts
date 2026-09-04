// Kanban aa55180c / #14 (14-A, BACKEND): GitHub-repo bongeszo hatter.
//
// Ez a modul olvassa/irja a GitHub tartalmat a Contents API-n keresztul --
// repo-lista, agak, mappa-listazas, fajl beolvasas, es EGY meglevo fajl
// frissitese. A felulet (14-B) KULON kartyan epul, Boss dontesere var; ide
// nem tartozik.
//
// A KULCS SOSE HAGYJA EL A SZERVERT. Minden keres a git-accounts.ts
// `githubRequest(account, ...)` fuggvenyen megy at: az oldja fel belul a
// tokent, es csak a kesz valaszt adja vissza. Ez a modul TOKENT NEM LAT es nem
// is kerhet -- egy fioknevet ad at, semmi mast.
import { githubRequest } from './git-accounts.js'

/** Egy bejegyzes egy repo-mappa listajaban (a Contents API `dir`/`file` sora). */
export interface GhEntry {
  name: string
  /** A repo-gyokerhez kepesti teljes ut, pl. `src/index.ts`. */
  path: string
  type: 'file' | 'dir'
  sha: string
  /** Bajtban; mappanal 0. */
  size: number
}

/** Egy repo a fiok lathato repoi kozul. */
export interface GhRepo {
  /** Csak a repo neve, pl. `marveen`. */
  name: string
  /** `tulajdonos/nev`, pl. `lackor2-crypto/marveen` -- ez azonositja a repot. */
  fullName: string
  private: boolean
  /** Az alapertelmezett ag, pl. `main`. */
  defaultBranch: string
  updatedAt: string
}

/** Egy beolvasott fajl tartalma es a hozza tartozo sha (a frissiteshez kell). */
export interface GhFileContent {
  path: string
  /** A blob sha-ja: EZT kell visszaadni `ghPut`-nal, hogy ne irjunk vakon felul. */
  sha: string
  size: number
  encoding: string
  /** UTF-8 szoveg. Binaris/1 MB feletti fajlnal ures -- lasd `truncated`. */
  content: string
  /**
   * IGAZ, ha a tartalmat NEM tudtuk kibontani (1 MB folott a GitHub ures
   * content-et ad, vagy nem base64 a kodolas). Ilyenkor a `content` nem
   * megbizhato -- a hivo ne mentse vissza, mert ures fajlt irna a helyere.
   */
  truncated: boolean
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A repo-azonosito `tulajdonos/nev` alaku es csak biztonsagos karaktereket
 * tartalmaz. A Contents API utjaba SZOVEGKENT kerul, ezert amit nem ismerunk
 * fel, azt elutasitjuk (nem szurjuk ki): egy megcsonkitott azonosito amugy is
 * rossz repot nyitna.
 */
function assertRepo(repo: string): string {
  const r = String(repo || '').trim()
  if (!REPO_RE.test(r)) throw new Error('Érvénytelen repo azonosító (tulajdonos/név kell).')
  return r
}

/**
 * A repon BELULI ut tisztitasa: nincs vezeto/zaro `/`, es nincs `..` szegmens
 * -- egy Contents-ut nem szokhet ki a repobol.
 */
function cleanPath(path: string): string {
  const p = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (p.split('/').some((seg) => seg === '..')) throw new Error('Érvénytelen útvonal.')
  return p
}

/** Az ut minden szegmensét kulon kodoljuk -- a `/`-eket megtartva. */
function encPath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function ghError(status: number, what: string): Error {
  if (status === 401 || status === 403) return new Error(`A GitHub nem engedte a(z) ${what} műveletet (${status}) — lehet, hogy a kulcsnak nincs joga hozzá.`)
  if (status === 404) return new Error(`Nem található (${what}).`)
  return new Error(`A GitHub ${what} nem sikerült (${status}).`)
}

/**
 * A fiok lathato repoi: sajat, kozremukodoi es szervezeti egyben.
 *
 * A `/user/repos` a kulcs SZEMSZOGEBOL sorol fel mindent, amihez koze van --
 * igy egy szervezeti fiok kolcsonkulccsal is a sajat repoit latja.
 */
export async function ghRepos(account: string): Promise<GhRepo[]> {
  const r = await githubRequest(account, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')
  if (!r.ok) throw ghError(r.status, 'repók lekérése')
  const body = await r.json().catch(() => null)
  if (!Array.isArray(body)) return []
  return body
    .map((x: any): GhRepo => ({
      name: String(x?.name || ''),
      fullName: String(x?.full_name || ''),
      private: Boolean(x?.private),
      defaultBranch: String(x?.default_branch || ''),
      updatedAt: String(x?.updated_at || ''),
    }))
    .filter((x) => x.fullName)
}

/** Egy repo agai (nevek). */
export async function ghBranches(account: string, repo: string): Promise<string[]> {
  const full = assertRepo(repo)
  const r = await githubRequest(account, `/repos/${full}/branches?per_page=100`)
  if (!r.ok) throw ghError(r.status, 'ágak lekérése')
  const body = await r.json().catch(() => null)
  if (!Array.isArray(body)) return []
  return body.map((b: any) => String(b?.name || '')).filter(Boolean)
}

/**
 * Egy mappa tartalma egy adott agon. Ures `path` = a repo gyokere.
 *
 * A Contents API mappara TOMBOT, fajlra OBJEKTUMOT ad -- ha objektum jon,
 * akkor a hivo fajlt kert mappa helyett, ezt kimondjuk.
 */
export async function ghList(account: string, repo: string, ref: string, path = ''): Promise<GhEntry[]> {
  const full = assertRepo(repo)
  const p = cleanPath(path)
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const r = await githubRequest(account, `/repos/${full}/contents/${encPath(p)}${q}`)
  if (!r.ok) throw ghError(r.status, 'mappa listázása')
  const body = await r.json().catch(() => null)
  if (!Array.isArray(body)) throw new Error('Ez nem mappa, hanem fájl.')
  return body
    .map((x: any): GhEntry => ({
      name: String(x?.name || ''),
      path: String(x?.path || ''),
      type: x?.type === 'dir' ? 'dir' : 'file',
      sha: String(x?.sha || ''),
      size: Number(x?.size || 0),
    }))
    .filter((x) => x.name)
}

/** Egy fajl tartalma egy adott agon. A `sha` a frissiteshez kell (`ghPut`). */
export async function ghFile(account: string, repo: string, ref: string, path: string): Promise<GhFileContent> {
  const full = assertRepo(repo)
  const p = cleanPath(path)
  if (!p) throw new Error('Hiányzik a fájl útvonala.')
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const r = await githubRequest(account, `/repos/${full}/contents/${encPath(p)}${q}`)
  if (!r.ok) throw ghError(r.status, 'fájl beolvasása')
  const body = await r.json().catch(() => null)
  if (!body || Array.isArray(body) || body.type !== 'file') throw new Error('Ez nem fájl, hanem mappa.')
  const encoding = String(body.encoding || '')
  const raw = String(body.content || '')
  const size = Number(body.size || 0)
  // 1 MB felett a GitHub ures content-et ad `encoding: none`-nal -- ilyenkor a
  // Blob API kellene. Itt csak JELEZZUK, nem talalunk ki tartalmat.
  const truncated = encoding !== 'base64' || (!raw && size > 0)
  const content = encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf-8') : ''
  return { path: String(body.path || p), sha: String(body.sha || ''), size, encoding, content, truncated }
}

/**
 * EGY MEGLEVO fajl frissitese. A `sha` KOTELEZO -- ez a vedelem a nema
 * feluliras ellen.
 *
 * MIERT KOTELEZO A SHA: a GitHub PUT sha nelkul UJ fajlt hozna letre, sha-val
 * pedig csak akkor ir, ha a megadott sha a fajl JELENLEGI verzioja. A sha az a
 * "ezt a verziot lattam" pecsét: ha kozben mas irt bele, a GitHub 409-cel all
 * meg, nem tapossuk el a valtozast. Ezert itt sha nelkul NEM is inditunk kerest.
 */
export async function ghPut(
  account: string,
  repo: string,
  branch: string,
  path: string,
  contentBase64: string,
  sha: string,
  message: string,
): Promise<{ path: string; sha: string; commit: string }> {
  const full = assertRepo(repo)
  const p = cleanPath(path)
  if (!p) throw new Error('Hiányzik a fájl útvonala.')
  const cleanSha = String(sha || '').trim()
  if (!cleanSha) throw new Error('A sha kötelező: csak meglévő fájlt frissítünk, azt is csak az általad látott verzió fölé.')
  if (!String(branch || '').trim()) throw new Error('Hiányzik az ág (branch).')
  if (!String(message || '').trim()) throw new Error('Hiányzik a commit-üzenet.')
  const r = await githubRequest(account, `/repos/${full}/contents/${encPath(p)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: String(contentBase64 || ''), sha: cleanSha, branch }),
  })
  if (!r.ok) throw ghError(r.status, 'fájl mentése')
  const body = await r.json().catch(() => null)
  return {
    path: String(body?.content?.path || p),
    sha: String(body?.content?.sha || ''),
    commit: String(body?.commit?.sha || ''),
  }
}

/**
 * HOVA KERULJON AZ UJ FAJL A PROJEKTBEN (kanban #321, Boss 2026-09-19,
 * kommentek 1136-1138).
 *
 * A "+ Uj -> Fajl" ablak a fajl FAJTAJABOL (kiterjesztes / MIME) es NEVEBOL
 * elore kivalaszt egy helyet -- a projekt SAJAT almappai kozul. Semmilyen
 * projekt- vagy mappanev nincs a kodba egetve: csak altalanos szavak (foto,
 * video, marketing, jogi ...), amelyekhez a projekt mappainak NEVET
 * hasonlitjuk (ekezet- es kisbetu-fuggetlenul). Igy barmilyen almappa-
 * szerkezettel mukodik, es egy friss, ures projektmappaval is.
 *
 * Ha nincs illo almappa, NEM a fomappat javasoljuk csendben (Boss, 1138),
 * hanem egy UJ mappanevet ES azt, hogy melyik meglevo mappa ala keruljon.
 * A mappa CSAK a felhasznalo "Rendben" gombjara jon letre (a route-ban).
 *
 * Tiszta fuggvenyek: fajlrendszert nem erintenek, igy unit-tesztelhetok.
 */

export type FileKind = 'photo' | 'video' | 'audio' | 'post' | 'web' | 'contract' | 'doc' | 'other'

export type Placement =
  | { type: 'existing'; kind: FileKind; sub: string }
  | { type: 'new'; kind: FileKind; name: string; parent: string }

/** Osszehasonlitasi kulcs: ekezet, kis-/nagybetu, irasjel nelkul. */
export function placeKey(v: string): string {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

interface KindRule {
  /** A mappanev ezekkel a SZAVAKKAL illik ehhez a fajtahoz (placeKey alakban). */
  folders: string[]
  /** Gyujto-mappa (pl. media): ha van, az uj mappa ala kerul. */
  containers: string[]
  /** Uj mappa neve, ha nincs illo. */
  newName: { hu: string; en: string }
  /** Uj gyujto-mappa, ha az sincs (a projekt fomappaja ala). */
  newContainer?: { hu: string; en: string }
}

const MEDIA = ['media', 'mediak', 'mediatar']

const RULES: Record<FileKind, KindRule> = {
  photo: {
    folders: ['foto', 'fotok', 'fotoanyag', 'kep', 'kepek', 'kepanyag', 'photo', 'photos', 'image', 'images', 'picture', 'pictures', 'img'],
    containers: MEDIA,
    newName: { hu: 'Fotók', en: 'Photos' },
    newContainer: { hu: 'Média', en: 'Media' },
  },
  video: {
    folders: ['video', 'videok', 'videos', 'film', 'filmek', 'movie', 'movies', 'felvetel', 'felvetelek'],
    containers: MEDIA,
    newName: { hu: 'Videók', en: 'Videos' },
    newContainer: { hu: 'Média', en: 'Media' },
  },
  audio: {
    folders: ['hang', 'hangok', 'hanganyag', 'audio', 'zene', 'zenek', 'music', 'sound', 'sounds'],
    containers: MEDIA,
    newName: { hu: 'Hangok', en: 'Audio' },
    newContainer: { hu: 'Média', en: 'Media' },
  },
  post: {
    folders: ['marketing', 'poszt', 'posztok', 'post', 'posts', 'social', 'socialmedia', 'kampany', 'kampanyok', 'campaign', 'campaigns', 'hirdetes', 'hirdetesek', 'ads', 'reklam'],
    containers: [],
    newName: { hu: 'Marketing', en: 'Marketing' },
  },
  web: {
    folders: ['weboldal', 'weboldalak', 'web', 'website', 'honlap', 'site', 'landing', 'landingpage'],
    containers: [],
    newName: { hu: 'Weboldal', en: 'Website' },
  },
  contract: {
    folders: ['jogi', 'jog', 'szerzodes', 'szerzodesek', 'contract', 'contracts', 'legal', 'megallapodasok'],
    containers: [],
    newName: { hu: 'Jogi', en: 'Legal' },
  },
  doc: {
    folders: ['dokumentum', 'dokumentumok', 'doksi', 'docs', 'document', 'documents', 'iratok', 'irat', 'anyagok'],
    containers: [],
    newName: { hu: 'Dokumentumok', en: 'Documents' },
  },
  other: {
    folders: ['egyeb', 'other', 'misc', 'vegyes'],
    containers: [],
    newName: { hu: 'Egyéb', en: 'Other' },
  },
}

/** A fajl NEVEBEN allo szavak, amik felulirjak a kiterjesztest (egy
 *  "szerzodes.pdf" nem altalanos dokumentum, egy "poszt-tavasz.png" nem csak foto). */
const NAME_HINTS: [FileKind, string[]][] = [
  ['contract', ['szerzodes', 'megallapodas', 'contract', 'agreement', 'nda', 'meghatalmazas', 'jogi']],
  ['post', ['poszt', 'post', 'hirdetes', 'kampany', 'banner', 'social', 'facebook', 'instagram', 'tiktok', 'reklam']],
  ['web', ['weboldal', 'website', 'landing', 'honlap']],
]

const EXT: Record<string, FileKind> = {}
for (const e of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'raw', 'cr2', 'nef', 'dng']) EXT[e] = 'photo'
for (const e of ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp']) EXT[e] = 'video'
for (const e of ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma']) EXT[e] = 'audio'
for (const e of ['html', 'htm', 'css', 'js', 'php']) EXT[e] = 'web'
for (const e of ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']) EXT[e] = 'doc'

/** A fajl fajtaja a nevebol es (ha van) a MIME-tipusabol. */
export function fileKind(name: string, mime?: string | null): FileKind {
  const base = String(name || '')
  const words = base.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const [kind, hints] of NAME_HINTS) {
    if (words.some((w) => hints.some((h) => w === h || w.startsWith(h)))) return kind
  }
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (ext && EXT[ext]) return EXT[ext]
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'photo'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'text/html' || m === 'text/css') return 'web'
  if (m === 'application/pdf' || m.startsWith('text/') || m.includes('document') || m.includes('spreadsheet')) return 'doc'
  return 'other'
}

const lastSeg = (rel: string): string => rel.split('/').pop() ?? rel

/**
 * A javasolt hely. `subfolders`: a projekt almappai relativ utkent
 * ('Media', 'Media/Fotok', ...). Illo mappa: az utolso nevresze a fajta
 * szavai kozott van -- tobb talalatnal a melyebb (konkretabb) nyer, azonos
 * melysegnel a rovidebb/abc-ben elso. Nincs illo: uj mappa, a gyujto-mappa
 * (pl. Media) ala, ha van; ha az sincs es a fajtanak van gyujtoje, a gyujto
 * is uj (pl. "Média/Fotók"), a fomappa ala.
 */
export function suggestPlacement(name: string, mime: string | null | undefined, subfolders: string[], lang: 'hu' | 'en'): Placement {
  const kind = fileKind(name, mime)
  const rule = RULES[kind]
  const subs = subfolders.filter(Boolean)
  const hits = subs.filter((s) => rule.folders.includes(placeKey(lastSeg(s))))
  if (hits.length) {
    hits.sort((a, b) => (b.split('/').length - a.split('/').length) || a.length - b.length || a.localeCompare(b))
    return { type: 'existing', kind, sub: hits[0] }
  }
  const containers = subs.filter((s) => rule.containers.includes(placeKey(lastSeg(s))))
  if (containers.length) {
    containers.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    return { type: 'new', kind, name: rule.newName[lang], parent: containers[0] }
  }
  const name2 = rule.newContainer ? `${rule.newContainer[lang]}/${rule.newName[lang]}` : rule.newName[lang]
  return { type: 'new', kind, name: name2, parent: '' }
}

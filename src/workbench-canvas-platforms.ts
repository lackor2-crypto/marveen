/**
 * PLATFORMMERETEK a rajzvaszonhoz (kanban #441, v4 spec 8.3, K-2.8 .. K-2.10).
 *
 * A spec kikotese: a meretek ne legyenek kodba egetve, hanem ADAT, a
 * platformok hivatalos sugojabol, a celbirosag-profilokhoz hasonloan. Ezert:
 *
 *   - a kiindulo lista (SEED) a hivatalos oldalakbol van kiirva; minden tetel
 *     mellett ott a forras es az ellenorzes napja,
 *   - a `store/workbench-canvas-platforms.json` felulirja vagy kiegesziti (azonos
 *     `id` = csere, uj `id` = uj meret), igy egy platform-valtozas program-
 *     frissites nelkul atvezetheto,
 *   - ha egy tetelt regebben ellenoriztunk, mint `STALE_DAYS`, a felulet szol.
 *
 * A BIZTONSAGI ZONA (K-2.10) a kep aranyaban all (0..1): az a sav, amit a
 * platform sajat gombjai, felirata eltakar. A Meta (Facebook, Instagram) egy
 * kozos 9:16 zonat kozol a Story es a Reel hirdetesekre; a TikTok nem kozol
 * egyetlen szamot (a felirat hosszatol fugg), ezert ott a Meta zonaja all, es
 * a megjegyzes kimondja, hogy ez kozelites.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'

export type Text = { hu: string; en: string }

export interface SafeZone { top: number; bottom: number; left: number; right: number }

export interface CanvasPlatform {
  id: string
  label: Text
  width: number
  height: number
  safe: SafeZone | null
  sources: { title: string; url: string }[]
  /** Az utolso ellenorzes napja a hivatalos forrasban (YYYY-MM-DD). */
  checked: string
  note?: Text | null
}

/** Ennyi nap utan kerjuk, hogy valaki nezze meg ujra a forrast. */
export const STALE_DAYS = 365

const T = (hu: string, en: string): Text => ({ hu, en })

const META_SAFE = {
  title: 'Meta Business Help Centre: About text overlays and the Safe Zone for ads in Stories and Reels',
  url: 'https://www.facebook.com/business/help/980593475366490/',
}
const IG_SIZES = {
  title: 'Meta Ads Guide: image specs (Instagram feed, Stories, Reels)',
  url: 'https://www.facebook.com/business/ads-guide/update/image/instagram-reels',
}

export const SEED_PLATFORMS: CanvasPlatform[] = [
  {
    id: 'facebook_post', label: T('Facebook poszt (fekvő)', 'Facebook post (landscape)'), width: 1200, height: 630, safe: null,
    sources: [{ title: 'Meta Ads Guide: Facebook feed image specs', url: 'https://www.facebook.com/business/ads-guide/update/image' }],
    checked: '2026-09-30',
    note: T('A Meta ma a hírfolyamba az álló 1080 × 1350-es képet ajánlja; a fekvő 1200 × 630 a linkelőnézetek mérete.',
      'Meta now recommends the 1080 × 1350 portrait image for the feed; the 1200 × 630 landscape is the link preview size.'),
  },
  {
    id: 'facebook_portrait', label: T('Facebook poszt (álló)', 'Facebook post (portrait)'), width: 1080, height: 1350, safe: null,
    sources: [{ title: 'Meta Ads Guide: Facebook feed image specs', url: 'https://www.facebook.com/business/ads-guide/update/image' }],
    checked: '2026-09-30',
  },
  {
    id: 'instagram_square', label: T('Instagram négyzet', 'Instagram square'), width: 1080, height: 1080, safe: null,
    sources: [IG_SIZES], checked: '2026-09-30',
  },
  {
    id: 'instagram_portrait', label: T('Instagram álló', 'Instagram portrait'), width: 1080, height: 1350, safe: null,
    sources: [IG_SIZES], checked: '2026-09-30',
    note: T('A profilrács ma 3:4-es előnézetet mutat: a két szélről kb. 34 képpont lemaradhat, oda ne tegyél szöveget.',
      'The profile grid now shows a 3:4 preview: about 34 pixels may be cut from each side, keep text away from there.'),
  },
  {
    id: 'story_reel', label: T('Story / Reel (Facebook, Instagram)', 'Story / Reel (Facebook, Instagram)'), width: 1080, height: 1920,
    safe: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
    sources: [META_SAFE, IG_SIZES], checked: '2026-09-30',
  },
  {
    id: 'tiktok', label: T('TikTok', 'TikTok'), width: 1080, height: 1920,
    safe: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
    sources: [
      { title: 'TikTok Ads Manager: Auction In-Feed Ads (safe zone files)', url: 'https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en' },
      META_SAFE,
    ],
    checked: '2026-09-30',
    note: T('A TikTok nem ad egyetlen számot: a takart sáv a felirat hosszától függ. Itt a Meta zónája áll, ami a jobb oldali gombsort és az alsó feliratot is lefedi; hosszú feliratnál hagyj alul több helyet.',
      'TikTok gives no single number: the covered band depends on the caption length. The Meta zone is used here, which covers the right-hand buttons and the bottom caption; leave more room at the bottom for a long caption.'),
  },
  {
    id: 'linkedin_post', label: T('LinkedIn poszt', 'LinkedIn post'), width: 1200, height: 627, safe: null,
    sources: [{ title: 'LinkedIn Help: Image specifications for your LinkedIn Pages', url: 'https://www.linkedin.com/help/linkedin/answer/a563309/image-specifications-for-your-linkedin-pages-and-career-pages' }],
    checked: '2026-09-30',
  },
]

export function platformsFile(): string {
  return process.env['MARVEEN_CANVAS_PLATFORMS_FILE'] || join(STORE_DIR, 'workbench-canvas-platforms.json')
}

const isText = (t: unknown): t is Text =>
  !!t && typeof t === 'object' && typeof (t as Text).hu === 'string' && typeof (t as Text).en === 'string' && !!(t as Text).hu.trim()

const frac = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 0.5

/** Egy tetel ellenorzese (a fajlbol jon, kezzel is irhatjak). A hiba MEGNEVEZI a mezot. */
export function checkPlatform(raw: unknown): { ok: true; platform: CanvasPlatform } | { ok: false; detail: string } {
  const p = raw as CanvasPlatform
  if (!p || typeof p !== 'object') return { ok: false, detail: 'an entry must be an object' }
  if (typeof p.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(p.id)) return { ok: false, detail: 'id: 2..40 characters, a-z 0-9 _' }
  if (!isText(p.label)) return { ok: false, detail: `${p.id}: label must be { hu, en }` }
  for (const k of ['width', 'height'] as const) {
    if (!Number.isInteger(p[k]) || p[k] < 16 || p[k] > 8000) return { ok: false, detail: `${p.id}: ${k} must be a whole number 16 .. 8000` }
  }
  if (p.safe != null) {
    const s = p.safe
    if (!frac(s.top) || !frac(s.bottom) || !frac(s.left) || !frac(s.right)) {
      return { ok: false, detail: `${p.id}: safe must be { top, bottom, left, right }, each a share of the picture between 0 and 0.5` }
    }
  }
  if (!Array.isArray(p.sources) || !p.sources.length || !p.sources.every((s) => s && typeof s.title === 'string' && /^https:\/\/\S+$/.test(String(s.url)))) {
    return { ok: false, detail: `${p.id}: sources must be a non-empty list of { title, url } with https addresses` }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.checked))) return { ok: false, detail: `${p.id}: checked must be YYYY-MM-DD` }
  if (p.note != null && !isText(p.note)) return { ok: false, detail: `${p.id}: note must be { hu, en }` }
  return {
    ok: true,
    platform: {
      id: p.id, label: { hu: p.label.hu, en: p.label.en }, width: p.width, height: p.height,
      safe: p.safe ? { top: p.safe.top, bottom: p.safe.bottom, left: p.safe.left, right: p.safe.right } : null,
      sources: p.sources.map((s) => ({ title: s.title, url: s.url })), checked: p.checked, note: p.note ?? null,
    },
  }
}

export interface PlatformList {
  platforms: (CanvasPlatform & { stale: boolean; from_file: boolean })[]
  /** A fajl hibaja, ha van. A hibas fajl NEM tunteti el a kiindulo listat. */
  file_error: string | null
}

/** A mai lista: a kiindulo tetelek + a fajl felulirasai. */
export function listCanvasPlatforms(now: Date = new Date()): PlatformList {
  const byId = new Map<string, CanvasPlatform & { from_file: boolean }>()
  for (const p of SEED_PLATFORMS) byId.set(p.id, { ...p, from_file: false })
  let fileError: string | null = null
  const f = platformsFile()
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { platforms?: unknown }
      if (!j || typeof j !== 'object' || !Array.isArray(j.platforms)) throw new Error('"platforms" must be a list')
      for (const raw of j.platforms) {
        const c = checkPlatform(raw)
        if (!c.ok) throw new Error(c.detail)
        byId.set(c.platform.id, { ...c.platform, from_file: true })
      }
    } catch (e) {
      fileError = String((e as Error)?.message || e).slice(0, 300)
    }
  }
  const limit = now.getTime() - STALE_DAYS * 86400_000
  return {
    platforms: [...byId.values()].map((p) => ({ ...p, stale: Date.parse(p.checked + 'T00:00:00Z') < limit })),
    file_error: fileError,
  }
}

export function canvasPlatform(id: unknown): CanvasPlatform | null {
  const want = String(id ?? '').trim()
  return listCanvasPlatforms().platforms.find((p) => p.id === want) ?? null
}

/** A meretehez illo platform(ok) -- a biztonsagi zona kijelzesehez. Ha tobb
 *  is illik (Story es TikTok), az elso zonaval rendelkezo szamit. */
export function platformForSize(width: number, height: number): CanvasPlatform | null {
  const list = listCanvasPlatforms().platforms.filter((p) => p.width === width && p.height === height)
  return list.find((p) => p.safe) ?? list[0] ?? null
}

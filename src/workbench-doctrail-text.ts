// The "technical trail" of a document as a plain text file a person can open in Notepad (Boss TG 3007): who wrote,
// checked and confirmed what, and when. The JSON stays available (?format=json) for tools; this is the default.

type Lang = 'hu' | 'en'
type Obj = Record<string, unknown>

const T = {
  title: { hu: 'TECHNIKAI NYOM', en: 'TECHNICAL TRAIL' },
  intro: {
    hu: 'Ez a fájl egyszerű nyilvántartás: ki, mikor, mit írt, ellenőrzött és erősített meg ebben a dokumentumban. Nem kell vele semmit csinálni, nem kell sehova feltölteni; bármilyen szövegszerkesztővel (pl. Jegyzettömb) megnyitható. A Marvin nem minősíti, hogy ez jogilag mire elég.',
    en: 'This file is a plain record of who wrote, checked and confirmed what in this document, and when. You do not have to do anything with it or upload it anywhere; any text editor (for example Notepad) opens it. Marveen does not assess what this is legally enough for.',
  },
  doc: { hu: 'Dokumentum', en: 'Document' },
  made: { hu: 'Készült', en: 'Created' },
  fingerprint: { hu: 'Tartalom ujjlenyomata', en: 'Content fingerprint' },
  summary: { hu: 'ÖSSZEFOGLALÓ', en: 'SUMMARY' },
  sections: { hu: 'fejezet', en: 'sections' },
  blocks: { hu: 'bekezdés/blokk', en: 'blocks' },
  byAgent: { hu: 'az ágens írta, változatlan', en: 'written by the agent, unchanged' },
  byOwner: { hu: 'te írtad vagy átírtad', en: 'written or edited by you' },
  claims: { hu: 'állítás', en: 'claims' },
  content: { hu: 'TARTALOM ÉS ELŐZMÉNYEK', en: 'CONTENT AND HISTORY' },
  section: { hu: 'Fejezet', en: 'Section' },
  status: { hu: 'állapot', en: 'status' },
  block: { hu: 'Blokk', en: 'Block' },
  writtenBy: { hu: 'Írta', en: 'Written by' },
  agent: { hu: 'az ágens', en: 'the agent' },
  owner: { hu: 'te', en: 'you' },
  created: { hu: 'létrehozva', en: 'created' },
  updated: { hu: 'módosítva', en: 'updated' },
  editedOwner: { hu: 'te átírtad', en: 'you edited it' },
  claim: { hu: 'Állítás', en: 'Claim' },
  strength: { hu: 'erősség', en: 'strength' },
  addedBy: { hu: 'felvette', en: 'added by' },
  source: { hu: 'Forrás', en: 'Source' },
  verdict: { hu: 'ellenőrzés', en: 'check' },
  checkedAt: { hu: 'ellenőrizve', en: 'checked' },
  confirmedBy: { hu: 'megerősítette', en: 'confirmed by' },
  annexes: { hu: 'MELLÉKLETEK', en: 'ANNEXES' },
  sent: { hu: 'ELKÜLDÉSEK', en: 'SENDINGS' },
  officialCopy: { hu: 'hivatalos példány', en: 'official copy' },
  notFiled: { hu: 'nincs elhelyezve', en: 'not filed' },
  recordedBy: { hu: 'rögzítette', en: 'recorded by' },
  consistency: { hu: 'KÖVETKEZETLENSÉGEK', en: 'INCONSISTENCIES' },
  reviews: { hu: 'ÁTNÉZÉSEK', en: 'REVIEWS' },
  finals: { hu: 'VÉGLEGESÍTÉSEK', en: 'FINAL VERSIONS' },
  none: { hu: '(nincs)', en: '(none)' },
  file: { hu: 'fájl', en: 'file' },
  version: { hu: 'verzió', en: 'version' },
  acceptedBy: { hu: 'elfogadta', en: 'accepted by' },
  stillCurrent: { hu: 'megegyezik a mostani tartalommal', en: 'matches the current content' },
  outdated: { hu: 'azóta változott a tartalom', en: 'the content changed since' },
  by: { hu: 'ki', en: 'by' },
}

const str = (v: unknown): string => (v == null ? '' : String(v))

/** How it was sent, in words (the same choices as the Workbench form, workbench-docsent.ts). */
const SENT_METHOD: Record<string, { hu: string; en: string }> = {
  email: { hu: 'e-mail', en: 'e-mail' },
  post: { hu: 'posta', en: 'post' },
  registered_post: { hu: 'ajánlott / tértivevényes levél', en: 'registered letter' },
  in_person: { hu: 'személyesen', en: 'in person' },
  portal: { hu: 'online ügyintézési felület', en: 'online portal' },
  fax: { hu: 'fax', en: 'fax' },
  other: { hu: 'egyéb', en: 'other' },
}

function when(v: unknown): string {
  const s = str(v)
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Budapest' }).slice(0, 16)
}

/** The trail (documentTrail's object) as text; the owner's name is not in it, "te"/"you" stands for the owner. */
export function trailToText(trail: Obj, lang: Lang): string {
  const t = (k: keyof typeof T): string => T[k][lang]
  const out: string[] = []
  const doc = (trail['document'] || {}) as Obj
  const sum = (trail['summary'] || {}) as Obj
  const who = (a: unknown): string => (a === 'agent' ? t('agent') : a === 'owner' ? t('owner') : str(a))
  out.push(t('title'), '='.repeat(t('title').length), '', t('intro'), '')
  out.push(`${t('doc')}: ${str(doc['title'])}`, `${t('made')}: ${when(trail['generated_at'])}`, `${t('fingerprint')}: ${str(doc['content_hash'])}`, '')
  out.push(t('summary'), '-'.repeat(t('summary').length))
  out.push(`${t('sections')}: ${str(sum['sections'])}`, `${t('blocks')}: ${str(sum['blocks'])}`,
    `  ${t('byAgent')}: ${str(sum['blocks_written_by_agent'])}`, `  ${t('byOwner')}: ${str(sum['blocks_written_or_edited_by_owner'])}`, `${t('claims')}: ${str(sum['claims'])}`, '')
  out.push(t('content'), '-'.repeat(t('content').length), '')
  for (const s of (trail['sections'] as Obj[]) || []) {
    out.push(`${t('section')}: ${str(s['title'])}  (${t('status')}: ${str(s['status'])})`)
    let n = 0
    for (const b of (s['blocks'] as Obj[]) || []) {
      n++
      const edited = str(b['edited_by_owner_at'])
      out.push('', `  ${t('block')} ${n} [${str(b['kind'])}] ${t('writtenBy')}: ${who(b['written_by'])}, ${t('created')}: ${when(b['created_at'])}, ${t('updated')}: ${when(b['updated_at'])}` + (edited ? `, ${t('editedOwner')}: ${when(edited)}` : ''))
      out.push(...str(b['text']).split('\n').map((l) => '    | ' + l))
      for (const c of (b['claims'] as Obj[]) || []) {
        out.push(`    ${t('claim')}: ${str(c['text'])} (${t('strength')}: ${str(c['strength'])}, ${t('addedBy')}: ${who(c['added_by'])}, ${when(c['added_at'])})`)
        for (const src of (c['sources'] as Obj[]) || []) {
          const detail = str(src['file'] || src['citation'] || src['said'] || '')
          out.push(`      ${t('source')} [${str(src['kind'])}] ${detail}${src['quote'] ? ' "' + str(src['quote']) + '"' : ''}`
            + ` -- ${t('verdict')}: ${str(src['verdict'])}${src['checked_at'] ? ', ' + t('checkedAt') + ': ' + when(src['checked_at']) : ''}`
            + (src['confirmed_at'] ? `, ${t('confirmedBy')}: ${who(src['confirmed_by'])}, ${when(src['confirmed_at'])}` : ''))
        }
      }
    }
    out.push('')
  }
  const list = (key: string, head: keyof typeof T, line: (x: Obj) => string): void => {
    out.push(t(head), '-'.repeat(t(head).length))
    const xs = (trail[key] as Obj[]) || []
    if (!xs.length) out.push(t('none'))
    for (const x of xs) out.push(line(x))
    out.push('')
  }
  list('annexes', 'annexes', (a) => `${str(a['label'])} ${str(a['title'])} (${t('file')}: ${str(a['file'])}, ${t('addedBy')}: ${who(a['added_by'])}, ${when(a['added_at'])})`)
  list('consistency', 'consistency', (c) => `${str(c['kind'])}: ${((c['values'] as unknown[]) || []).map(str).join(' / ')} (${str(c['section'])})`)
  list('reviews', 'reviews', (r) => `${when(r['reviewed_at'])} ${t('by')}: ${who(r['reviewed_by'])}`)
  list('finals', 'finals', (f) => `${t('version')} ${str(f['version_no'])} ${str(f['label'])}: ${t('file')}: ${str(f['file'])}, ${t('acceptedBy')}: ${who(f['accepted_by'])}, ${when(f['accepted_at'])}, ${f['still_current'] ? t('stillCurrent') : t('outdated')}`)
  // #530: sent is not final -- when, to whom, how, and where the official copy is.
  list('sent', 'sent', (x) => `${str(x['date'])}${x['time'] ? ' ' + str(x['time']) : ''} – ${str(x['recipient'])} – ${(SENT_METHOD[str(x['method'])] || SENT_METHOD['other']!)[lang]}${x['reference'] ? ' – ' + str(x['reference']) : ''} (${str(x['final'])}; ${t('officialCopy')}: ${x['official_copy'] ? str(x['official_copy']) : t('notFiled')}; ${t('recordedBy')}: ${who(x['recorded_by'])}, ${when(x['recorded_at'])})`)
  return out.join('\r\n') + '\r\n'
}

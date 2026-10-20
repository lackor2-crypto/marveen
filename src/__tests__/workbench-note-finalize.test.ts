// #667 (Boss TG 9260): a work item whose file is a .md / .txt is finalized from a panel, and the finalize makes the PDF of
// the file into the item's Finished materials folder -- not just the bare "done" status.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { hasTextFinalPanel, isTextSourcePath } from '../workbench-notefinal.js'
import { reopenWorkItem } from '../workbench-approval.js'
import { textLangState } from '../workbench-notelang.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"; last="$a"
done
# the test reads back what was converted (the document text), to prove WHICH text became the PDF
if [ -n "$MARVEEN_TEST_CAPTURE" ] && [ -f "$last" ]; then cp "$last" "$MARVEEN_TEST_CAPTURE"; fi
printf '%%PDF-1.4 teszt' > "$out/doc.pdf"
exit 0
`

describe('#667 text-file work item: finalize makes the PDF', () => {
  let depot = ''
  let pid = ''
  const saved: Record<string, string | undefined> = {}
  const mkNote = (rel: string | null, title = 'Terv') => {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    if (rel) getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(rel, w.item.id)
    return w.item.id
  }
  const approval = (id: string, body: unknown, kind = 'session') =>
    callWorkbench(`/api/workbench/items/${id}/approval`, 'POST', body, undefined, kind === 'session' ? { kind: 'session', user: 'teszt' } : { kind })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-notefinal-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE', 'MARVEEN_TEST_CAPTURE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const fake = join(depot, 'fake-soffice.sh')
    writeFileSync(fake, FAKE_SOFFICE, 'utf-8')
    chmodSync(fake, 0o755)
    process.env['MARVEEN_SOFFICE'] = fake
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Terv.md'), '# Terv\n\nElső sor.\n', 'utf-8')
  })

  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    resetLibreOfficeProbe()
    rmTempDir(depot)
  })

  it('knows which files get the panel', () => {
    expect(isTextSourcePath('a/b/Terv (2).md')).toBe(true)
    expect(isTextSourcePath('a/b/jegyzet.TXT')).toBe(true)
    expect(isTextSourcePath('a/b/kep.png')).toBe(false)
    expect(isTextSourcePath(null)).toBe(false)
    expect(hasTextFinalPanel({ source_path: 'x/y.md' })).toBe(true)
    expect(hasTextFinalPanel({ source_path: null })).toBe(false)
  })

  it('the PDF lands in Finished materials and only then the item is done', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final.name).toMatch(/^Terv.*\.pdf$/)
    const abs = join(depot, r.body.final.path)
    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs).subarray(0, 5).toString()).toBe('%PDF-')
    expect(r.body.final.path).toMatch(/Elkészített anyagok|Finished materials/)
    expect(getWorkItem(id)?.status).toBe('done')
  })

  // #725 (Boss TG 3987): the same unchanged text finalized again reuses its PDF, no "(2)" copy.
  it('finalizing an unchanged text again makes no new PDF', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const a = await approval(id, { action: 'finalize', pdf: true })
    expect(a.status).toBe(200)
    const re = reopenWorkItem(id, { by: 'owner' })
    if (!re.ok) throw new Error('reopen ' + re.code)
    const b = await approval(id, { action: 'finalize', pdf: true })
    expect(b.status).toBe(200)
    expect(b.body.final.path).toBe(a.body.final.path)
    expect(readdirSync(dirname(join(depot, a.body.final.path))).filter((n) => n.endsWith('.pdf'))).toHaveLength(1)
  })

  it('a missing file stops it: no PDF, the item is not finalized, the message is a sentence', async () => {
    const id = mkNote('Projektek/Iroda/Nincs.md')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('note_final_unreadable')
    expect(r.body.message.length).toBeGreaterThan(20)
    expect(getWorkItem(id)?.status).not.toBe('done')
  })

  it('a second finalize says it is already done, and the old PDF stays', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const a = await approval(id, { action: 'finalize', pdf: true })
    expect(a.status).toBe(200)
    const b = await approval(id, { action: 'finalize', pdf: true })
    expect(b.status).toBe(409)
    expect(b.body.error).toBe('note_final_already_done')
    expect(existsSync(join(depot, a.body.final.path))).toBe(true)
  })

  it('an item without a text file keeps the bare status switch (no PDF)', async () => {
    const id = mkNote(null, 'Szabad jegyzet')
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.final).toBeUndefined()
  })

  it('only the owner click makes the PDF (an agent token is refused)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const r = await approval(id, { action: 'finalize', pdf: true }, 'token')
    expect(r.status).toBe(403)
    expect(getWorkItem(id)?.status).not.toBe('done')
    const dir = readdirSync(join(depot, 'Projektek', 'Iroda'))
    expect(dir.some((n) => /\.pdf$/i.test(n))).toBe(false)
  })

  it('#671: a fresh translation is SAVED as the language version, then PDF-ed; the original file stays', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const cap = join(depot, 'captured.fodt')
    process.env['MARVEEN_TEST_CAPTURE'] = cap
    const r = await approval(id, { action: 'finalize', pdf: true, lang: 'en', text: '# Plan\n\nFirst line.\n' })
    expect(r.status).toBe(200)
    expect(r.body.final.name).toMatch(/\(EN\)\.pdf$/)
    expect(existsSync(join(depot, r.body.final.path))).toBe(true)
    const converted = readFileSync(cap, 'utf-8')
    expect(converted).toContain('First line.')
    expect(converted).not.toContain('Első sor.')
    expect(readFileSync(join(depot, 'Projektek', 'Iroda', 'Terv.md'), 'utf-8')).toContain('Első sor.')
    expect(getWorkItem(id)?.status).toBe('done')
    // the translation is no longer lost: it is a sibling work item with its own file, listed as the EN version
    const st = textLangState({ id })
    expect(st.variants.map((v) => v.lang)).toEqual(['en'])
    const sib = getWorkItem(st.variants[0]!.item_id)!
    expect(sib.type).toBe('note')
    expect(sib.title).toMatch(/^EN/)
    expect(readFileSync(join(depot, sib.source_path!), 'utf-8')).toContain('First line.')
    expect(textLangState({ id: sib.id }).variant_of).toEqual({ item_id: id, lang: 'en' })
  })

  it('#671: a saved version is picked by language alone (no text sent), and the item GET lists it', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const saved = await callWorkbench(`/api/workbench/items/${id}/text-variant`, 'POST', { lang: 'en', text: 'Saved English body.' }, undefined, { kind: 'session', user: 'teszt' })
    expect(saved.status).toBe(201)
    const again = await callWorkbench(`/api/workbench/items/${id}/text-variant`, 'POST', { lang: 'en', text: 'Saved English body, v2.' }, undefined, { kind: 'session', user: 'teszt' })
    expect(again.status).toBe(200)
    expect(again.body.existing).toBe(true)
    expect(again.body.text_langs.variants).toHaveLength(1)
    const get = await callWorkbench(`/api/workbench/items/${id}`, 'GET', undefined, undefined, { kind: 'session', user: 'teszt' })
    expect(get.body.text_langs.variants.map((v: { lang: string }) => v.lang)).toEqual(['en'])
    const cap = join(depot, 'captured.fodt')
    process.env['MARVEEN_TEST_CAPTURE'] = cap
    const r = await approval(id, { action: 'finalize', pdf: true, lang: 'en' })
    expect(r.status).toBe(200)
    expect(readFileSync(cap, 'utf-8')).toContain('Saved English body, v2.')
    expect(r.body.final.name).toMatch(/\(EN\)\.pdf$/)
  })

  it('#671: no language -> the file in its own language is converted (no language in the name)', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const cap = join(depot, 'captured.fodt')
    process.env['MARVEEN_TEST_CAPTURE'] = cap
    const r = await approval(id, { action: 'finalize', pdf: true })
    expect(r.status).toBe(200)
    expect(r.body.final.name).not.toMatch(/\([A-Z]{2}\)/)
    expect(readFileSync(cap, 'utf-8')).toContain('Első sor.')
  })

  it('#671: a language with no saved version and no text, or a broken text / code, is refused with a sentence; nothing is finalized', async () => {
    const id = mkNote('Projektek/Iroda/Terv.md')
    const none = await approval(id, { action: 'finalize', pdf: true, lang: 'de' })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('note_final_no_variant')
    expect(none.body.message.length).toBeGreaterThan(20)
    for (const bad of [{ lang: 'en', text: '   ' }, { lang: '../x', text: 'a' }, { lang: 'english', text: 'a' }]) {
      const r = await approval(id, { action: 'finalize', pdf: true, ...bad })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('note_final_bad_translation')
      expect(r.body.message.length).toBeGreaterThan(20)
    }
    expect(getWorkItem(id)?.status).not.toBe('done')
    expect(textLangState({ id }).variants).toHaveLength(0)
  })
})

describe('#667 the finalize panel is brought into view (it stacks below the fold on a phone)', () => {
  it('opening the panel scrolls to it, and the scroll helper looks for the panel itself', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'workbench.js'), 'utf-8')
    const open = src.match(/a === 'item-finalize'\) \{[^\n]*/)?.[0] ?? ''
    expect(open).toContain('noteFinalScrollIn()')
    const helper = src.match(/function noteFinalScrollIn\(\) \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(helper).toContain("querySelector('.wb-note-final')")
    expect(helper).toContain('scrollIntoView')
  })
})

// #678: the finalize language list is only what exists (original + saved versions), refreshed from the server on open.
describe('finalize language list (#678, source contract)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('offers no translate-now languages and re-reads the saved versions when the panel opens', () => {
    expect(js).not.toContain('notefinal.lang_new')
    expect(js).toContain('function noteLangsRefresh()')
    expect(js).toMatch(/noteFinalScrollIn\(\); noteLangsRefresh\(\)/)
  })
})

// #678 follow-up: the "Original" entry never repeats a saved version's language, and the server message no longer points to a finalize-panel translation that does not exist.
describe('finalize language list naming (#678 follow-up, source contract)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf-8')
  it('names the original without a language when a saved version has the same one', () => {
    expect(js).toContain('workbench.notefinal.lang_orig_plain')
  })
  it('the no-variant message points only to the Translation view', () => {
    expect(route).not.toContain('a véglegesítő panelen')
    expect(route).not.toContain('or on the finalize panel')
  })
})

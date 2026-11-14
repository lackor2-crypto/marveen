// #861: the whole way an old official source (stored before #1635 with verdict 'unverified') has to go: the check is green,
// the final PDF is made, the final JSON says 'verified', and the e-mail draft (which exists only after the final PDF) can be
// made and put into the mailbox Drafts folder. The unit tests of the verdict rule are in workbench-official-legacy-verdict.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addBlock, addClaim, addSection, documentCheck, type SourceWorld } from '../workbench-docmodel.js'
import { contentHash, documentTrail, finalizeDocument, recordReview } from '../workbench-docfinal.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { saveDraftToMailbox, saveMailDraft } from '../workbench-maildraft.js'
import { registerMailboxEngine, _setGoogleEngine } from '../mail-send.js'

const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 test"; exit 0; fi
out=""; prev=""; src=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"; src="$a"
done
printf '%%PDF-1.4 SRC-%s\\n' "$(cksum < "$src" | tr ' ' '-')" > "$out/doc.pdf"
exit 0
`

const world: SourceWorld = { resolveFile: () => null, ownerMessages: () => [] }

describe('#861 old official source: final PDF and e-mail draft', () => {
  let depot = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-official-mail-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda', 'Iratok'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const f = join(depot, 'soffice.sh')
    writeFileSync(f, FAKE_SOFFICE, 'utf-8')
    chmodSync(f, 0o755)
    process.env['MARVEEN_SOFFICE'] = f
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Antwort auf das Schreiben', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    const s = addSection(itemId, '1. Rechtsgrundlage', { status: 'done' })
    if (!s.ok) throw new Error('section')
    const b = addBlock(itemId, s.section.id, { text: 'Die Frist endet am 17. März 2027.', author: 'agent' })
    if (!b.ok) throw new Error('block')
    const c = addClaim(itemId, b.block.id, 'Die Frist endet am 17. März 2027.', [
      { kind: 'official', citation: '§ 12 VwGO', url: 'https://www.gesetze-im-internet.de/vwgo/__12.html', quote: 'Frist bis 17. März 2027' },
    ], world, 'workbench-agent')
    if (!c.ok) throw new Error('claim')
    // what the program wrote before #1635
    getDb().prepare("UPDATE wb_doc_sources SET verdict = 'unverified', detail = 'not yet checked in the official source' WHERE claim_id = ?").run(c.claim.id)
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  it('check green, final PDF made, final JSON verified, e-mail draft made and put into the mailbox', async () => {
    const item = getWorkItem(itemId)!
    expect(documentCheck(itemId).items.find((i) => i.key === 'unverified_references')).toMatchObject({ ok: true, count: 0, total: 1 })

    // no final PDF yet: the draft is refused for exactly that reason, not for the reference
    expect(await saveMailDraft(item, { to: 'amt@stadt.de' }, 'hu')).toMatchObject({ ok: false, code: 'final_required' })

    const hash = contentHash(item)
    recordReview(itemId, hash, 'owner')
    const fin = await finalizeDocument(item, { accept: true, hash, by: 'owner', lang: 'hu' })
    if (!fin.ok) throw new Error('finalize ' + fin.code + ' ' + fin.detail)

    const trail = documentTrail(getWorkItem(itemId)!) as { sections: { blocks: { claims: { sources: { kind: string; verdict: string }[] }[] }[] }[] }
    const src = trail.sections[0]!.blocks[0]!.claims[0]!.sources[0]!
    expect(src).toMatchObject({ kind: 'official', verdict: 'verified' })

    const r = await saveMailDraft(getWorkItem(itemId)!, { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de' }, 'hu')
    if (!r.ok) throw new Error('draft ' + r.code + ' ' + r.detail)
    expect(r.draft).toMatchObject({ from_account: 'work', state: 'current' })
    expect(r.draft.attachments.length).toBeGreaterThan(0)

    const got = { account: '', to: '', attachments: [] as string[] }
    _setGoogleEngine(null, () => null)
    registerMailboxEngine({
      accounts: () => [{ id: 'work', address: 'me@example.com' }],
      run: async () => ({ ok: false, detail: 'a draft test never sends' }),
      sentFolder: async () => 'Sent',
      changed: () => {},
      async saveDraft(account, msg) {
        got.account = account; got.to = msg.to
        for (const f of msg.attachments || []) got.attachments.push(f.split('/').pop()!)
        return { ok: true, mailbox: '[Gmail]/Piszkozatok' }
      },
    })
    const saved2 = await saveDraftToMailbox(getWorkItem(itemId)!, 'hu')
    registerMailboxEngine(null)
    _setGoogleEngine(null)
    if (!saved2.ok) throw new Error('mailbox ' + saved2.code)
    expect(got.account).toBe('work')
    expect(got.to).toBe('amt@stadt.de')
    expect(got.attachments.length).toBeGreaterThan(0)
  })
})

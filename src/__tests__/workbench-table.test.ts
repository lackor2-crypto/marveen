// #406, 15. pont -- TABLAZAT-SZERKESZTES: .xlsx / .csv racskent, minden mentes
// uj fajl + uj verzio, a formazas (es minden, amihez nem nyultunk) megmarad.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { buildZip } from '../web/zip-writer.js'
import {
  readTable, writeTable, readZip, blankXlsx, shiftFormula, parseCsv, writeCsv, detectDelimiter,
  serialToIso, isoToSerial, normalizeSheets, TABLE_MAX_ROWS,
} from '../workbench-table.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const STYLES = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\.mm\\.dd"/></numFmts>`
  + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'

/** Egy "valodi" munkafuzet: megosztott szovegek, datum-stilus, megosztott
 *  keplet, calcChain, masodik lap -- amit az Excel is irna. */
function sampleXlsx(): Buffer {
  const sheet1 = `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C4"/><cols><col min="1" max="1" width="30" customWidth="1"/></cols><sheetData>`
    + '<row r="1" spans="1:3" ht="20" customHeight="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2" spans="1:3"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2"><v>10</v></c></row>'
    + '<row r="3" spans="1:3"><c r="A3" t="inlineStr"><is><t>Kő &amp; homok</t></is></c><c r="B3" s="2"><v>45001.5</v></c><c r="C3"><v>20.5</v></c></row>'
    + '<row r="4"><c r="A4" t="b"><v>1</v></c><c r="C4"><f t="shared" ref="C4:D4" si="0">SUM(C2:C3)</f><v>30.5</v></c><c r="D4"><f t="shared" si="0"/><v>0</v></c></row>'
    + '</sheetData><mergeCells count="1"><mergeCell ref="A1:A1"/></mergeCells></worksheet>'
  const sheet2 = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + '<sheets><sheet name="Költség" sheetId="1" r:id="rId1"/><sheet name="Másik" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId9" Type="cc" Target="calcChain.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}><si><t>Tétel</t></si><si><t>Dátum</t></si><si><r><t>Ös</t></r><r><t>szeg</t></r></si><si><t>Cement</t><rPh><t>x</t></rPh></si></sst>`,
    'xl/styles.xml': STYLES,
    'xl/calcChain.xml': '<calcChain><c r="C4" i="1"/></calcChain>',
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': sheet2,
  }
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })))
}

function zipText(buf: Buffer, name: string): string | null {
  const e = readZip(buf)?.find((x) => x.name === name)
  return e ? e.data.toString('utf8') : null
}

describe('a tablazat-olvaso es -iro', () => {
  it('az .xlsx-et racskent adja: megosztott szoveg, datum ISO-ban, keplet "="-vel, megosztott keplet eltolva', () => {
    const r = readTable(sampleXlsx(), 'k.xlsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.table.format).toBe('xlsx')
    expect(r.table.has_formulas).toBe(true)
    expect(r.table.sheets.map((s) => s.name)).toEqual(['Költség', 'Másik'])
    expect(r.table.sheets[0]!.rows).toEqual([
      ['Tétel', 'Dátum', 'Összeg', ''],
      ['Cement', '2023-03-15', '10', ''],
      ['Kő & homok', '2023-03-16 12:00', '20.5', ''],
      ['TRUE', '', '=SUM(C2:C3)', '=SUM(D2:D3)'],
    ])
  })

  it('mentesnel CSAK az atirt cella uj; a tobbi bajtra marad, a stilus marad, a calcChain kikerul, ujraszamolast ker', () => {
    const orig = sampleXlsx()
    const r = readTable(orig, 'k.xlsx')
    if (!r.ok) throw new Error('olvasas')
    const sheets = r.table.sheets
    sheets[0]!.rows[1]![2] = '12,5' // magyar tizedesvesszo
    sheets[0]!.rows[1]![1] = '2024-01-02' // datum-stilusu cella
    sheets[0]!.rows[2]![0] = 'Sóder <1>'
    sheets[0]!.rows.push(['Új', '', '=C4*2', ''])
    const w = writeTable(orig, 'k.xlsx', sheets, { lang: 'hu' })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const s1 = zipText(w.data, 'xl/worksheets/sheet1.xml')!
    expect(s1).toContain('<c r="A1" t="s"><v>0</v></c>')
    // A kepletek MEGMARADNAK, de a regi (elavult) eredmenyuk nem: minden
    // olvaso ujraszamol (a LibreOffice alapbol nem tenne).
    expect(s1).toContain('<c r="C4"><f t="shared" ref="C4:D4" si="0">SUM(C2:C3)</f></c>')
    expect(s1).toContain('<c r="D4"><f t="shared" si="0"/></c>')
    expect(s1).not.toContain('<v>30.5</v>')
    expect(s1).toContain('<c r="C2"><v>12.5</v></c>')
    expect(s1).toContain(`<c r="B2" s="1"><v>${isoToSerial('2024-01-02')}</v></c>`)
    expect(s1).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">Sóder &lt;1&gt;</t></is></c>')
    expect(s1).toContain('<c r="C5"><f>C4*2</f></c>')
    expect(s1).toContain('<row r="1" ht="20" customHeight="1">')
    expect(s1).toContain('<dimension ref="A1:D5"/>')
    expect(s1).toContain('<col min="1" max="1" width="30" customWidth="1"/>')
    expect(s1).toContain('<mergeCell ref="A1:A1"/>')
    // A masik lap es a stilusok erintetlenek.
    expect(zipText(w.data, 'xl/worksheets/sheet2.xml')).toBe(zipText(orig, 'xl/worksheets/sheet2.xml'))
    expect(zipText(w.data, 'xl/styles.xml')).toBe(STYLES)
    expect(zipText(w.data, 'xl/calcChain.xml')).toBeNull()
    expect(zipText(w.data, '[Content_Types].xml')).not.toContain('calcChain')
    expect(zipText(w.data, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
    expect(zipText(w.data, 'xl/workbook.xml')).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>')
    // Visszaolvasva ugyanaz, amit a felhasznalo beirt.
    const back = readTable(w.data, 'k.xlsx')
    if (!back.ok) throw new Error('vissza')
    expect(back.table.sheets[0]!.rows[1]).toEqual(['Cement', '2024-01-02', '12.5', ''])
    expect(back.table.sheets[0]!.rows[4]).toEqual(['Új', '', '=C4*2', ''])
  })

  it('angol feluletnel a "3,5" szoveg marad (ott a vesszo nem tizedesjel)', () => {
    const orig = blankXlsx('Sheet1')
    const w = writeTable(orig, 'x.xlsx', [{ name: 'Sheet1', rows: [['3,5', '3.5', 'FALSE']] }], { lang: 'en' })
    if (!w.ok) throw new Error('iras')
    const s = zipText(w.data, 'xl/worksheets/sheet1.xml')!
    expect(s).toContain('t="inlineStr"><is><t xml:space="preserve">3,5</t>')
    expect(s).toContain('<c r="B1"><v>3.5</v></c>')
    expect(s).toContain('<c r="C1" t="b"><v>0</v></c>')
  })

  it('valtozas nelkul nem keszul uj fajl; a lapok atnevezese / szama nem csuszhat el', () => {
    const orig = sampleXlsx()
    const r = readTable(orig, 'k.xlsx')
    if (!r.ok) throw new Error('olvasas')
    expect(writeTable(orig, 'k.xlsx', r.table.sheets)).toMatchObject({ ok: false, code: 'table_no_change' })
    expect(writeTable(orig, 'k.xlsx', r.table.sheets.slice(0, 1))).toMatchObject({ ok: false, code: 'table_sheets_changed' })
    const renamed = r.table.sheets.map((s, i) => ({ ...s, name: i ? 'X' : s.name }))
    expect(writeTable(orig, 'k.xlsx', renamed)).toMatchObject({ ok: false, code: 'table_sheets_changed' })
  })

  it('az ures munkafuzet ervenyes, es a vegere irt sor bekerul', () => {
    const b = blankXlsx('Munka1')
    const r = readTable(b, 'uj.xlsx')
    expect(r).toMatchObject({ ok: true, table: { sheets: [{ name: 'Munka1', rows: [['']] }] } })
    const w = writeTable(b, 'uj.xlsx', [{ name: 'Munka1', rows: [['Név', 'Ár'], ['Tégla', '120']] }])
    if (!w.ok) throw new Error('iras')
    const back = readTable(w.data, 'uj.xlsx')
    expect(back).toMatchObject({ ok: true, table: { sheets: [{ rows: [['Név', 'Ár'], ['Tégla', '120']] }] } })
  })

  it('a hibas / nem-zip fajlt kimondja, nem 500', () => {
    expect(readTable(Buffer.from('nem zip'), 'a.xlsx')).toMatchObject({ ok: false, code: 'table_bad_file' })
    expect(readTable(Buffer.from('x'), 'a.xls')).toMatchObject({ ok: false, code: 'table_unsupported' })
  })

  it('a megosztott keplet eltolasa: relativ mozog, $-os es idezett nem', () => {
    expect(shiftFormula('SUM(A1:B2)+$C$1+C$1+"A1"', 2, 1)).toBe('SUM(B3:C4)+$C$1+D$1+"A1"')
    expect(shiftFormula("'Lap 1'!A1*2", 1, 0)).toBe("'Lap 1'!A2*2")
    expect(shiftFormula('LOG10(A1)', 1, 0)).toBe('LOG10(A2)')
  })

  it('datum oda-vissza', () => {
    expect(serialToIso(45000)).toBe('2023-03-15')
    expect(isoToSerial('2023-03-15')).toBe(45000)
    expect(isoToSerial('2023.03.15.')).toBe(45000)
    expect(isoToSerial('2023-02-30')).toBeNull()
  })

  it('CSV: pontosvesszo, BOM, CRLF megmarad; idezojelezes; nem UTF-8 -> kimondja', () => {
    const src = Buffer.from('﻿név;ár\r\n"Kő; homok";"5 ""m3"""\r\n', 'utf8')
    const r = readTable(src, 'lista.csv')
    expect(r).toMatchObject({ ok: true, table: { format: 'csv', delimiter: ';', sheets: [{ rows: [['név', 'ár'], ['Kő; homok', '5 "m3"']] }] } })
    const w = writeTable(src, 'lista.csv', [{ name: '', rows: [['név', 'ár', 'db'], ['Kő; homok', '5 "m3"', '2']] }])
    if (!w.ok) throw new Error('iras')
    expect(w.data.toString('utf8')).toBe('﻿név;ár;db\r\n"Kő; homok";"5 ""m3""";2\r\n')
    expect(readTable(Buffer.from([0x6e, 0xe9, 0x76, 0x0a]), 'regi.csv')).toMatchObject({ ok: false, code: 'table_not_utf8' })
    expect(detectDelimiter('a\tb\n', 'tsv')).toBe('\t')
    expect(parseCsv('a,"b\nc"\n', ',')).toEqual([['a', 'b\nc']])
    expect(writeCsv([[' x', 'y']], ',', '\n')).toBe('" x",y\n')
  })

  it('a meret-hatar: tul sok sor -> kimondott kod', () => {
    const rows = Array.from({ length: TABLE_MAX_ROWS + 1 }, () => ['1'])
    expect(normalizeSheets([{ name: '', rows }])).toMatchObject({ ok: false, code: 'table_too_big' })
    expect(normalizeSheets('x')).toMatchObject({ ok: false, code: 'table_bad_input' })
  })
})

describe('a szerver', () => {
  let depot = ''
  let pid = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-tbl-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('mappa')
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('FRISS TELEPITES: uj ures tablazat a feluletrol -> fajl a projekt mappajaba + munkadarab; szerkesztes -> UJ fajl + UJ verzio, a regi erintetlen', async () => {
    const c = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Költségvetés' })
    expect(c.status).toBe(201)
    expect(c.body.name).toBe('Költségvetés.xlsx')
    const itemId = c.body.item.id
    const firstBytes = readFileSync(join(depot, 'Projektek', 'teszt', 'Költségvetés.xlsx'))

    const g = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ format: 'xlsx', current: true, sheets: [{ name: 'Munka1', rows: [['']] }] })

    const s = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'POST', {
      base_version: g.body.version_id, sheets: [{ name: 'Munka1', rows: [['Tétel', 'Ár'], ['Tégla', '120']] }],
    })
    expect(s.status).toBe(201)
    expect(s.body.name).toBe('Költségvetés (2).xlsx')
    expect(s.body.version.version_no).toBe(2)
    expect(readdirSync(join(depot, 'Projektek', 'teszt')).sort()).toEqual(['Költségvetés (2).xlsx', 'Költségvetés.xlsx'])
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'Költségvetés.xlsx')).equals(firstBytes)).toBe(true)

    const g2 = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')
    expect(g2.body.sheets[0].rows).toEqual([['Tétel', 'Ár'], ['Tégla', '120']])
    // A regi verzio megnezheto, de nem a mostani.
    const old = await callWorkbench(`/api/workbench/items/${itemId}/table?version=${g.body.version_id}`, 'GET')
    expect(old.body).toMatchObject({ current: false, sheets: [{ rows: [['']] }] })
  })

  it('kozben keszult ujabb verzio -> 409, nem ir felul; valtozas nelkul -> 409 emberi mondattal', async () => {
    const c = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Lista' })
    const itemId = c.body.item.id
    const g = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')
    const stale = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'POST', { base_version: 'regi', sheets: g.body.sheets })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('table_stale')
    const same = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'POST', { base_version: g.body.version_id, sheets: g.body.sheets })
    expect(same.status).toBe(409)
    expect(same.body.message).toMatch(/Nem változott semmi/)
  })

  it('archivalt projekt: megnezni lehet, menteni nem', async () => {
    const c = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Arch' })
    const itemId = c.body.item.id
    const g = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')
    setProjectArchived(pid, true)
    expect((await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')).status).toBe(200)
    const s = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'POST', { base_version: g.body.version_id, sheets: [{ name: 'Munka1', rows: [['x']] }] })
    expect(s.status).toBe(409)
    expect(s.body.error).toBe('project_archived')
  })

  it('feltoltott CSV is szerkesztheto; nem tablazat-fajlnal es mappa nelkuli projektnel emberi mondat', async () => {
    writeFileSync(join(depot, 'Projektek', 'teszt', 'lista.csv'), 'a,b\n1,2\n')
    const w = createWorkItem({ project_id: pid, title: 'Lista', type: 'document', source_path: 'Projektek/teszt/lista.csv' })
    if (!w.ok) throw new Error('mu')
    const g = await callWorkbench(`/api/workbench/items/${w.item.id}/table`, 'GET')
    expect(g.body).toMatchObject({ format: 'csv', delimiter: ',', sheets: [{ rows: [['a', 'b'], ['1', '2']] }] })
    const s = await callWorkbench(`/api/workbench/items/${w.item.id}/table`, 'POST', { base_version: g.body.version_id, delimiter: ',', sheets: [{ name: '', rows: [['a', 'b'], ['1', '3']] }] })
    expect(s.status).toBe(201)
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'lista (2).csv'), 'utf8')).toBe('a,b\n1,3\n')

    writeFileSync(join(depot, 'Projektek', 'teszt', 'k.png'), Buffer.from([0x89, 0x50]))
    const img = createWorkItem({ project_id: pid, title: 'Kép', type: 'image', source_path: 'Projektek/teszt/k.png' })
    if (!img.ok) throw new Error('kep')
    const bad = await callWorkbench(`/api/workbench/items/${img.item.id}/table?lang=en`, 'GET')
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/cannot be edited as a table/)

    const np = createProject({ name: 'Mappa nélkül' })
    if (!np.ok) throw new Error('p2')
    const nf = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: np.project.id, title: 'T' })
    expect(nf.status).toBe(400)
    expect(nf.body.message).toBeTruthy()
    expect(nf.body.message).not.toBe(nf.body.error)
    const noTitle = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: ' ' })
    expect(noTitle.body.error).toBe('table_title_required')
  })
})

describe('a felulet', () => {
  const ITEM = { id: 'w1', title: 'Költség', type: 'document', status: 'draft', current_version_id: 'v1' }
  const TABLE = { format: 'xlsx', sheets: [{ name: 'Munka1', rows: [['Tétel', 'Ár'], ['Tégla', '120']] }, { name: 'Másik', rows: [['7']] }], has_formulas: false, name: 'k.xlsx', version_id: 'v1', version_no: 1, current: true }

  function setup(opts: { archived?: boolean; table?: Record<string, unknown> } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács ház', archived: !!opts.archived }
    let created = false
    h.respond((url, init) => {
      if (url.includes('/new-table')) created = true
      if (url.includes('/new-table')) return { status: 201, body: { ok: true, item: { ...ITEM, id: 'w2' }, versions: [{ id: 'v9', version_no: 1 }], name: 'Új.xlsx' } }
      if (url.includes('/table') && init?.method === 'POST') {
        return { status: 201, body: { ok: true, item: { ...ITEM, current_version_id: 'v2' }, version: { id: 'v2', version_no: 2 }, versions: [{ id: 'v2', version_no: 2 }, { id: 'v1', version_no: 1 }], name: 'k (2).xlsx' } }
      }
      if (url.includes('/table')) return { status: 200, body: { ...TABLE, ...(opts.table || {}) } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'needs_conversion', kind: 'office', rel: 'P/k.xlsx', name: 'k.xlsx', message: 'PDF kell', office: { ext: 'xlsx', ready: false } } }
      if (url.includes('/api/workbench/items/w')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project } }
      return { status: 200, body: itemsBody(created ? [ITEM, { ...ITEM, id: 'w2' }] : [ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács ház')
    return h
  }

  async function openTable(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    // LibreOffice nelkul (friss telepites) is ott a gomb: nem kell hozza PDF.
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="table-open"'))
    h.click({ 'data-wb-act': 'table-open' })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbCell_1_1"'))
  }

  it('megnyitja racskent, a gepeles az allapotba megy (ujrarajzolas utan is megvan), a mentes base_version-nel UJ verziot ker', async () => {
    const h = setup()
    await openTable(h)
    expect(h.html()).toContain('value="Tégla"')
    expect(h.html()).toContain('data-wb-act="table-sheet" data-wb-sheet="1"')
    expect(h.html()).toContain('⟦workbench.table.hint_xlsx⟧')
    h.fire('input', { target: { id: 'wbCell_1_1', value: '150' } })
    h.click({ 'data-wb-act': 'table-col-add' })
    expect(h.html()).toContain('value="150"')
    expect(h.html()).toContain('id="wbCell_0_2"')
    h.click({ 'data-wb-act': 'table-save' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.table.saved'))
    const post = h.fetchCalls.find((c) => c.url.includes('/table') && c.init?.method === 'POST')!
    const body = JSON.parse(String(post.init!.body))
    expect(body.base_version).toBe('v1')
    expect(body.sheets[0].rows).toEqual([['Tétel', 'Ár', ''], ['Tégla', '150', '']])
    expect(body.sheets[1].rows).toEqual([['7']])
    expect(h.html()).not.toContain('id="wbCell_1_1"')
  })

  it('archivalt projektben / regi verzional csak olvashato: nincs mentes, nincs sor-gomb', async () => {
    const h = setup({ table: { current: false } })
    await openTable(h)
    expect(h.html()).toContain('readonly')
    expect(h.html()).not.toContain('data-wb-act="table-save"')
    expect(h.html()).not.toContain('data-wb-act="table-row-add"')
    expect(h.html()).toContain('⟦workbench.table.old_version⟧')
  })

  it('uj ures tablazat a "Uj munkadarab" urlaprol; nincs kezzel irt magyar szoveg', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-act': 'new' })
    expect(h.html()).toContain('data-wb-act="create-table"')
    h.inputs['wbNewTitle'] = { value: '', focus() {} }
    h.click({ 'data-wb-act': 'create-table' })
    expect(h.toasts.join(' ')).toContain('workbench.table.title_required')
    h.inputs['wbNewTitle'] = { value: 'Új lista', focus() {} }
    h.click({ 'data-wb-act': 'create-table' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.table.created'))
    const post = h.fetchCalls.find((c) => c.url.includes('/new-table'))!
    expect(JSON.parse(String(post.init!.body))).toEqual({ project_id: 'p1', title: 'Új lista' })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbCell_0_0"'))
    expect(untranslatedHungarian(h.html(), ['Kovács ház', 'Költség', 'Tétel', 'Tégla', 'Másik', 'PDF kell'])).toBe('')
  })
})

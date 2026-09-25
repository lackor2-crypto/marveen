// #389 -- INTEZO: WINDOWS-SZERU KIJELOLES + KULDES.
//
// Boss (TG 6369): Shift+kattintassal 20-100 kepet egyszerre kijelolni, mint a
// Windows Intezoben, es a jobbklikk-menubol "Küldés" e-mailben / WhatsAppon /
// Messengeren.
//
// Ket resz:
//   1) a szerver (life-send.ts): a kijeloles merese, a mappa ZIP-je (valodi,
//      kibonthato zip!), a meret-korlat es a hibak emberi mondattal;
//   2) a felulet (web/app.js): forrasszoveg-ellenorzes, mint az intezo-ctxmenu
//      teszt -- a tobb tizezer soros bongeszo-fajl modulkent nem toltheto be.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync, crc32 } from 'node:zlib'

const depot = mkdtempSync(join(tmpdir(), 'marveen-send-depot-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-send-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { lifeSendInfo, prepareLifeAttachments, zipFolder, EMAIL_ATTACH_LIMIT } = await import('../life-send.js')
const { explorerRoot } = await import('../life-explorer.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

/** Minimal zip reader: the central directory, each entry inflated and CRC-checked. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThanOrEqual(0)
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    expect(buf.readUInt16LE(p + 8) & 0x0800).toBe(0x0800)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    const lnlen = buf.readUInt16LE(off + 26)
    const data = buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize)
    const raw = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    expect(crc32(raw) >>> 0).toBe(crc)
    out.set(name, raw)
    p += 46 + nlen
  }
  return out
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Fotók', 'Nyaralás', 'belső'), { recursive: true })
  writeFileSync(join(root, 'Fotók', 'Nyaralás', 'tenger.txt'), 'hullám '.repeat(500))
  writeFileSync(join(root, 'Fotók', 'Nyaralás', 'belső', 'ékezetes név.txt'), 'árvíztűrő')
  writeFileSync(join(root, 'Fotók', 'egy.jpg'), Buffer.from([1, 2, 3, 4]))
})

describe('lifeSendInfo', () => {
  it('megmeri a fajlt es a mappat, a mappa ZIP-kent megy', () => {
    const r = lifeSendInfo(['Fotók/egy.jpg', 'Fotók/Nyaralás'], 'hu')
    expect(r.ok).toBe(true)
    expect(r.items.map((x) => x.sendName)).toEqual(['egy.jpg', 'Nyaralás.zip'])
    expect(r.items[1].files).toBe(2)
    expect(r.totalBytes).toBe(4 + Buffer.byteLength('hullám '.repeat(500)) + Buffer.byteLength('árvíztűrő'))
    expect(r.overEmailLimit).toBe(false)
  })

  it('ures kijeloles = emberi mondat, nem gepi kod', () => {
    const r = lifeSendInfo([], 'hu')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('empty')
    expect(r.message).toMatch(/Nincs kijelölve/)
    expect(lifeSendInfo([], 'en').message).toMatch(/Nothing is selected/)
  })

  it('kozben eltunt elem: megmondja, melyik, es mit tegyen', () => {
    const r = lifeSendInfo(['Fotók/nincs-ilyen.jpg'], 'hu')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not_found')
    expect(r.message).toContain('nincs-ilyen.jpg')
  })

  it('a fan kivulre mutato utat nem fogad el', () => {
    const r = lifeSendInfo(['../../etc/passwd'], 'hu')
    expect(r.ok).toBe(false)
  })
})

describe('zipFolder', () => {
  it('valodi, kibonthato zip: a mappa neve a teteje, ekezetes nevek UTF-8-ban', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'marveen-zip-')), 'x.zip')
    const r = zipFolder(join(root, 'Fotók', 'Nyaralás'), out)
    expect(r.files).toBe(2)
    const z = readZip(readFileSync(out))
    expect([...z.keys()].sort()).toEqual(['Nyaralás/belső/ékezetes név.txt', 'Nyaralás/tenger.txt'])
    expect(z.get('Nyaralás/tenger.txt')!.toString()).toBe('hullám '.repeat(500))
    expect(z.get('Nyaralás/belső/ékezetes név.txt')!.toString()).toBe('árvíztűrő')
  })

  it('a mappan beluli symlinket NEM koveti (a fa hatara a biztonsagi hatar)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'marveen-outside-'))
    writeFileSync(join(outside, 'titok.txt'), 'nem mehet ki')
    symlinkSync(outside, join(root, 'Fotók', 'Nyaralás', 'kifele'))
    const out = join(mkdtempSync(join(tmpdir(), 'marveen-zip-')), 'x.zip')
    zipFolder(join(root, 'Fotók', 'Nyaralás'), out)
    const names = [...readZip(readFileSync(out)).keys()]
    expect(names.some((n) => n.includes('titok'))).toBe(false)
  })
})

describe('prepareLifeAttachments', () => {
  it('fajl a helyerol, mappa ZIP-ben egy ideiglenes mappaba; a cleanup eltakarit', () => {
    const r = prepareLifeAttachments(['Fotók/egy.jpg', 'Fotók/Nyaralás'], 'hu')
    expect(r.ok).toBe(true)
    expect(r.paths[0]).toBe(join(root, 'Fotók', 'egy.jpg'))
    expect(r.paths[1].endsWith('Nyaralás.zip')).toBe(true)
    expect(existsSync(r.paths[1])).toBe(true)
    r.cleanup()
    expect(existsSync(r.paths[1])).toBe(false)
    // Az eredeti fajlhoz a takaritas nem nyul.
    expect(existsSync(r.paths[0])).toBe(true)
  })

  it('ket azonos nevu mappa: a masodik "(2)"-t kap, nem irja felul', () => {
    mkdirSync(join(root, 'Másik', 'Nyaralás'), { recursive: true })
    writeFileSync(join(root, 'Másik', 'Nyaralás', 'a.txt'), 'a')
    const r = prepareLifeAttachments(['Fotók/Nyaralás', 'Másik/Nyaralás'], 'hu')
    expect(r.ok).toBe(true)
    expect(r.paths.map((p) => p.split('/').pop())).toEqual(['Nyaralás.zip', 'Nyaralás (2).zip'])
    r.cleanup()
  })

  it('a korlat folott nem epit semmit, es megmondja a meretet', () => {
    const r = prepareLifeAttachments(['Fotók/Nyaralás'], 'hu', 100)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('too_big')
    expect(r.paths).toEqual([])
    expect(r.message).toMatch(/MB/)
    expect(EMAIL_ATTACH_LIMIT).toBe(25 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------- felulet
const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(process.cwd(), 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(process.cwd(), 'web', 'lang', 'en.js'), 'utf8')

function fnBody(fej: string): string {
  const i = app.indexOf(fej)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + fej)
  const veg = app.indexOf('\n}', i)
  return app.slice(i, veg < 0 ? undefined : veg + 2)
}

describe('#389 felulet -- kijeloles, mint a Windows Intezoben', () => {
  it('Shift = tartomany a horgonytol, Ctrl = egy elem ki/be, a Kijeloles gomb nelkul is', () => {
    const b = fnBody('function _intezoPickWithKeys(')
    expect(b).toContain('_intezoMultiEnsure()')
    expect(b).toContain('_intezoSelectRange(anchor, rel, additive)')
    expect(b).toMatch(/_intezoMulti\.delete\(rel\)/)
  })

  it('a sor, a nev es a pipa is erti a Shiftet', () => {
    expect(app).toMatch(/if \(ev\.shiftKey \|\| ev\.ctrlKey \|\| ev\.metaKey\) \{ _intezoPickWithKeys\(rel, ev\); return \}/)
    expect(app).toMatch(/if \(e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey\) \{ e\.stopPropagation\(\); _intezoPickWithKeys\(rel, e\); return \}/)
    expect(app).toMatch(/ev\.shiftKey && _intezoMulti && _intezoAnchor[\s\S]{0,200}_intezoSelectRange\(_intezoAnchor, rel, true\)/)
  })

  it('billentyuk: Ctrl+A, nyilak, Szokoz, Enter, Delete, Esc a kijelolest zarja', () => {
    expect(app).toContain("if (k === 'a' && !e.shiftKey)")
    expect(app).toContain('_intezoSelectAll()')
    expect(app).toMatch(/'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter', 'Delete'/)
    expect(app).toMatch(/if \(_intezoMulti\) _intezoMultiSetOn\(false\)\s*\n\s*else if \(_intezoClip\) _intezoClipClear\(\)/)
    const nav = fnBody('function _intezoKeyNav(')
    expect(nav).toContain('_intezoTrashMany(items)')
    expect(nav).toContain('_intezoGridCols()')
  })

  it('keret-huzas egerrel az ures helyrol', () => {
    const b = fnBody('function _intezoBindRubberBand(')
    expect(b).toContain("box.className = 'intezo-band'")
    expect(b).toContain('getBoundingClientRect')
    expect(app).toMatch(/\n_intezoBindRubberBand\(\)\n/)
  })

  it('Ctrl+X/C a TOBBES kijelolesre, a beillesztes mindet viszi, egyszer kerdez', () => {
    expect(app).toContain('_intezoClipSet(sel.length > 1 ? sel : (_intezoSelected || sel[0])')
    const many = fnBody('async function _intezoPasteMany(')
    expect(many).toContain('choice.applyAll')
    expect(many).toContain('_intezoAskNameClash(info, { more: items.length - i - 1 })')
    // A #386-os teszt ezt a pontos hivast varja a menuben.
    expect(app).toContain("_intezoClipSet(entry, 'cut')")
  })

  it('tobb elem a Kukaba EGY kerdessel; Kukaban levo elemet nem kever bele', () => {
    const b = fnBody('async function _intezoTrashMany(')
    expect(b).toContain("t('intezo.trash_confirm_n'")
    expect(b).toContain("t('intezo.multi_trash_in_kuka')")
  })

  it('jobb klikk tobbes kijelolesnel a kijelolesre szol, es van benne Kuldes', () => {
    const b = fnBody('async function _intezoOpenMenu(')
    expect(b).toContain("t('intezo.menu_multi_head'")
    expect(b).toContain('_intezoMenuSend(m, multi, build)')
    expect(b).toContain('_intezoMenuSend(m, [entry], build)')
    // Telefonon nincs Shift: a menubol indul a tobbes kijeloles.
    expect(b).toContain("t('intezo.menu_select')")
  })
})

describe('#389 felulet -- Kuldes', () => {
  it('az e-mail SOHA nem kuld magatol: csak a levelirot nyitja meg', () => {
    const b = fnBody('function emailShowComposeWithLifeFiles(')
    expect(b).toContain('emailShowComposeNew()')
    expect(b).not.toMatch(/fetch\(/)
    expect(b).not.toMatch(/api\/email\/compose/)
  })

  it('fiok nelkul (friss telepites) emberi mondat mondja meg, hol lehet felvenni', () => {
    const b = fnBody('async function _intezoSendEmail(')
    expect(b).toContain("t('intezo.send_email_no_account')")
    expect(b).toContain("t('intezo.send_email_accounts_failed')")
    expect(hu).toMatch(/'intezo\.send_email_no_account': ".*Beállítások.*"/)
  })

  it('a megosztas a rendszer ablakan at megy, es megmondja, ha a bongeszo nem tudja', () => {
    const b = fnBody('function _intezoShareBlocker(')
    expect(b).toContain('isSecureContext')
    expect(b).toContain('navigator.canShare')
    const s = fnBody('async function _intezoSendShare(')
    expect(s).toContain('navigator.share({ files')
    expect(s).toContain("e.name === 'AbortError'")
  })

  it('a leveliro a kivalasztott fiokkal, a fajlokkal kuld', () => {
    expect(app).toContain('life ? { lifeAttachments: life.rels')
  })

  it('minden uj szoveg megvan magyarul ES angolul', () => {
    const keys = [
      'intezo.menu_send', 'intezo.send_email', 'intezo.send_share', 'intezo.send_share_apps',
      'intezo.send_email_no_account', 'intezo.send_share_unsupported', 'intezo.send_share_insecure',
      'intezo.menu_multi_head', 'intezo.trash_confirm_n', 'intezo.clip_pasted_n',
      'email.compose_life_attached', 'email.compose_from_label',
    ]
    for (const k of keys) {
      expect(hu, k).toContain(`'${k}':`)
      expect(en, k).toContain(`'${k}':`)
    }
  })
})

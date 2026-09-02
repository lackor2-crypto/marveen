// A NEVESITETT FIOKOK KIJELENTKEZESE EDDIG NEMA VOLT.
//
// Boss, 2026-08-29: "ezeket remelem ellenorzi az onellenorzo resz...!? es az
// attekintes alatt szolni fog ha baj van." -- nem ellenorizte. A
// claudeAuthRow() csak a telepites sajat ~/.claude bejelentkezeset nezte, es a
// zold szovege meg meg is nyugtatott a tobbi agens felol. Igy tudott az
// usalackor halottan ulni ugy, hogy az Attekintes vegig zold volt.
//
// A masik fele ugyanez a Google-oldalon: kapcsolokulcs nelkul egyetlen mar
// bekotott cim sem tud megujulni -- se level, se naptar, se Drive, se foto --,
// es errol sem szolt semmi.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namedLoginRows, googleClientRows, vaultBindingRows } from '../web/system-health.js'
import type { NamedCred } from '../web/system-health.js'
import type { ClaudePlan } from '../web/claude-plans.js'

const gyoker = (): string => mkdtempSync(join(tmpdir(), 'named-login-'))

/** Egy fiok-mappa a lemezen. Hogy be van-e jelentkezve, azt a proba mondja
 *  meg -- a valosagban is a CLI, nem egy fajl jelenlete. */
function fiok(hova: string, nev: string, vanMappa = true): ClaudePlan {
  const configDir = join(hova, nev)
  if (vanMappa) mkdirSync(configDir, { recursive: true })
  return { id: nev, label: nev, configDir, planType: 'personal', channelsAllowed: true }
}

/** A CLI helyett: nev -> valasz. Ami nincs benne, az 'vak'. */
const probaVal = (terkep: Record<string, NamedCred>) => (dir: string): NamedCred =>
  terkep[dir.split('/').pop() as string] ?? 'vak'

const jegyzek = (hova: string, tervek: ClaudePlan[]): string => {
  const p = join(hova, 'claude-plans.json')
  writeFileSync(p, JSON.stringify(tervek))
  return p
}

describe('nevesitett Claude-fiokok az onellenorzesben', () => {
  it('a kijelentkezett fiokot PIROSSAL, NEVEN nevezi', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'ki', lackor3: 'be' }))
    const sor = r.find(x => x.id === 'named_login_out')
    expect(sor).toBeDefined()
    expect(sor!.status).toBe('bad')
    // A nev nelkul a sor hasznalhatatlan: nem tudod, melyiket kell megnyomni.
    expect(String(sor!.params!.names)).toContain('usalackor')
    expect(String(sor!.params!.names)).not.toContain('lackor3')
  })

  it('a "nem tudtam megkerdezni" NEM kijelentkezes -- kulon sor', () => {
    // A kesz readIdentity() a sikertelen probat is loggedIn:false-kent adja
    // vissza; ott a ketto megkulonboztethetetlen. Itt pont ez a lenyeg.
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek, probaVal({ usalackor: 'vak' }))
    expect(r.map(x => x.id)).toContain('named_login_blind')
    expect(r.map(x => x.id)).not.toContain('named_login_out')
  })

  it('mind bejelentkezve: ZOLD sor, hogy a hallgatas ne legyen ketertelmu', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'be', lackor3: 'be' }))
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('named_login_ok')
    expect(r[0].params).toMatchObject({ n: 2 })
  })

  // A NULLA KET DOLGOT JELENTHET -- ez a negy eset a lenyeg.
  it('friss telepites (nincs jegyzek-fajl): CSEND, nem hibauzenet', () => {
    const r = namedLoginRows(join(gyoker(), 'nincs-ilyen.json'), () => [], () => 'be')
    expect(r).toEqual([])
  })

  it('a hianyzo fiok-mappa "nem latok oda", NEM "kijelentkezve"', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor', false)]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek, () => 'be')
    expect(r.map(x => x.id)).toContain('named_login_blind')
    expect(r.map(x => x.id)).not.toContain('named_login_out')
    expect(String(r[0].params!.names)).toContain('usalackor')
  })

  it('serult jegyzek-fajl: PIROS, mert a Fiokok oldal uresnek fog latszani', () => {
    const h = gyoker()
    const p = join(h, 'claude-plans.json')
    writeFileSync(p, '{ ez nem json')
    const r = namedLoginRows(p, () => [], () => 'be')
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('named_login_broken')
    expect(r[0].status).toBe('bad')
  })

  it('ertelmes fajl, de egyetlen ervenyes bejegyzes sincs: szol rola', () => {
    const h = gyoker()
    const p = join(h, 'claude-plans.json')
    writeFileSync(p, JSON.stringify([{ id: 'rossz' }]))
    const r = namedLoginRows(p, () => [], () => 'be')
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('named_login_none_valid')
  })
})

describe('Google kapcsolokulcs', () => {
  it('van kulcs: nincs sor (mas sorok beszelnek a fiokokrol)', () => {
    expect(googleClientRows(true, () => 3)).toEqual([])
  })

  it('friss telepites (nincs kulcs, nincs cim): CSEND', () => {
    expect(googleClientRows(false, () => 0)).toEqual([])
  })

  it('nincs kulcs, de VAN bekotott cim: PIROS -- ez nema uzemszunet', () => {
    const r = googleClientRows(false, () => 2)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('google_client_missing')
    expect(r[0].status).toBe('bad')
    expect(r[0].params).toMatchObject({ n: 2 })
  })

  it('ha a cimlistat sem tudom elolvasni, azt mondom ki -- nem azt, hogy rendben', () => {
    const r = googleClientRows(false, () => { throw new Error('EACCES') })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('google_client_blind')
  })
})


describe('arva Vault-kotesek', () => {
  // Egy kotes azt mondja: "ez az MCP-szerver ezt a kulcsot kapja". Ha a kulcs
  // eltunt, a szerver URES kulcsot kap -- nem hibazik, csak nem mukodik.
  const kotesFajl = (tartalom: string): string => {
    const p = join(gyoker(), 'vault-bindings.json')
    writeFileSync(p, tartalom)
    return p
  }
  const kotes = (id: string, envVar: string) => ({ vaultSecretId: id, envVar, targets: [] })

  it('a halott kulcsra mutato kotest PIROSSAL, neven nevezi', () => {
    const p = kotesFajl(JSON.stringify({ bindings: [kotes('sk1', 'BRAVE_API_KEY'), kotes('sk2', 'MAS_KEY')] }))
    const r = vaultBindingRows(p, () => ['sk2'])
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('vault_binding_orphan')
    expect(r[0].status).toBe('bad')
    expect(String(r[0].params!.names)).toContain('BRAVE_API_KEY')
    expect(String(r[0].params!.names)).not.toContain('MAS_KEY')
  })

  it('mind el: ZOLD sor', () => {
    const p = kotesFajl(JSON.stringify({ bindings: [kotes('sk1', 'A'), kotes('sk2', 'B')] }))
    const r = vaultBindingRows(p, () => ['sk1', 'sk2'])
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('vault_binding_ok')
    expect(r[0].params).toMatchObject({ n: 2 })
  })

  it('friss telepites (nincs kotes-fajl): CSEND', () => {
    expect(vaultBindingRows(join(gyoker(), 'nincs.json'), () => [])).toEqual([])
  })

  it('ures kotes-lista: CSEND, nem zold hazugsag', () => {
    const p = kotesFajl(JSON.stringify({ bindings: [] }))
    expect(vaultBindingRows(p, () => [])).toEqual([])
  })

  it('olvashatatlan fajl: "nem latok oda", NEM "nulla kotes"', () => {
    const p = kotesFajl('{ ez nem json')
    const r = vaultBindingRows(p, () => [])
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('vault_binding_blind')
  })

  it('ha a KULCSLISTAT nem erem el, nem allitom, hogy arvak', () => {
    const p = kotesFajl(JSON.stringify({ bindings: [kotes('sk1', 'A')] }))
    const r = vaultBindingRows(p, () => { throw new Error('vault zarva') })
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('vault_binding_blind')
  })
})

/** A CLI helyett: nev -> cim. Ami nincs benne, arrol nem tudunk semmit. */
const cimVal = (terkep: Record<string, string>) => (dir: string): string | undefined =>
  terkep[dir.split('/').pop() as string]

describe('KI VAN A SLOTBAN -- ket elofizetes egy fiokon', () => {
  // Boss, 2026-08-29: a lackor3 es az usalackor ugyanabban a Claude-fiokban ult,
  // ketten ettek egyetlen fiok kereteit, a masik elofizetes meg allt. Semmi nem
  // szolt rola.
  it('ket nevesitett fiok azonos cimen: PIROS sor, mindket nevvel', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'be', lackor3: 'be' }),
      cimVal({ usalackor: 'usalackor@gmail.com', lackor3: 'usalackor@gmail.com' }))
    const sor = r.find(x => x.id === 'named_login_same_account')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ n: 2, names: 'usalackor, lackor3', email: 'usalackor@gmail.com' })
  })

  it('a piros sor MELLE nem jarhat megnyugtato zold sor', () => {
    // Elesben pont ez tortent: "2 nevesitett bejelentkezes rendben" allt a
    // figyelmeztetes mellett. A felrevezeto zold rosszabb, mint a hallgatas.
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'be', lackor3: 'be' }),
      cimVal({ usalackor: 'k@o.hu', lackor3: 'k@o.hu' }))
    expect(r.map(x => x.id)).not.toContain('named_login_ok')
  })

  it('a gep sajat fiokjara atcsuszott elofizetes ugyanaz a hiba', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ lackor3: 'be', '.claude': 'be' }),
      cimVal({ lackor3: 'lackor2@gmail.com', '.claude': 'lackor2@gmail.com' }))
    const sor = r.find(x => x.id === 'named_login_same_as_host')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ email: 'lackor2@gmail.com' })
  })

  it('elteres a rogzitett cimtol: neven nevezi, mi van most bent', () => {
    const h = gyoker()
    const t1 = fiok(h, 'lackor3')
    const tervek = [{ ...t1, expectedEmail: 'lackor3@gmail.com' }]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ lackor3: 'be' }), cimVal({ lackor3: 'usalackor@gmail.com' }))
    const sor = r.find(x => x.id === 'named_login_drift')
    expect(sor?.status).toBe('bad')
    expect(String(sor?.params?.names)).toContain('usalackor@gmail.com')
  })

  it('kulon fiokok: csend (es a zold sor kijar)', () => {
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'be', lackor3: 'be' }),
      cimVal({ usalackor: 'usalackor@gmail.com', lackor3: 'lackor3@gmail.com' }))
    expect(r.map(x => x.id)).toEqual(['named_login_ok'])
  })

  it('cim nelkul NEM allitunk utkozest -- a nem tudom nem bizonyitek', () => {
    // Ha a proba nem adott cimet, ket fiok latszolag "ugyanaz a semmi" -- ebbol
    // utkozest allitani talalgatas lenne.
    const h = gyoker()
    const tervek = [fiok(h, 'usalackor'), fiok(h, 'lackor3')]
    const r = namedLoginRows(jegyzek(h, tervek), () => tervek,
      probaVal({ usalackor: 'be', lackor3: 'be' }), cimVal({}))
    expect(r.map(x => x.id)).not.toContain('named_login_same_account')
  })
})

describe('minden uj sornak van magyar ES angol szovege', () => {
  // A felulet minden sorat ket nyelven kell tudni kiirni; kulonben a sor
  // helyen a nyers azonosito jelenne meg.
  const idk = [
    'named_login_out', 'named_login_blind', 'named_login_ok',
    'named_login_same_account', 'named_login_same_as_host', 'named_login_drift',
    'named_login_unreadable', 'named_login_broken', 'named_login_none_valid',
    'google_client_missing', 'google_client_blind',
    'vault_binding_orphan', 'vault_binding_ok', 'vault_binding_blind',
    'provider_key_missing', 'provider_key_ok', 'provider_key_blind',
  ]
  for (const nyelv of ['hu', 'en']) {
    it(`${nyelv}: mind a ${idk.length} sor + teendo megvan`, async () => {
      const { readFileSync } = await import('node:fs')
      const s = readFileSync(`web/lang/${nyelv}.js`, 'utf-8')
      for (const id of idk) {
        expect(s, `${nyelv}: health.${id}`).toContain(`'health.${id}':`)
        expect(s, `${nyelv}: health.${id}_action`).toContain(`'health.${id}_action':`)
      }
    })
  }
})

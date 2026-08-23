/**
 * MIRE VALO EZ A MAPPA -- egy mondatnyi sugo minden fa-mappahoz.
 *
 * Boss, 2026-08-21: „en nem tudom mit szoktak tenni a digitalis, identitas,
 * otthon, szemelyes, stb ala.. csalad? szoval minden mappahoz irj zarojelbe
 * vagy 5 dolgot. mit lehet ala teni."
 *
 * A sugo NEM kerul a mappa NEVEBE. Az atnevezes eltorne minden utat, minden
 * bekotest es minden mar rogzitett hivatkozast -- egy magyarazo szoveg pedig
 * sosem er annyit, hogy adatot kockaztasson ertek. A lemezen tehat tovabbra is
 * `Otthon` all; a zarojeles resz csak a kepernyon letezik.
 *
 * A kulcs a GEPI nev, nem a magyar mappanev: igy egy angol telepitesen is
 * ugyanaz a sugo tartozik ugyanahhoz a helyhez.
 *
 * A megfogalmazas szabalya: KONKRET peldak, amiket az ember felismer a sajat
 * fiokjabol ("lakcimkartya", "kozuzemi szamla"), nem kategoria-nevek
 * ("szemelyes adatok"). Aki azt nezi, hogy hova tegyen egy papirt, annak a
 * pelda segit, a definicio nem.
 *
 * KETNYELVU. Boss, 2026-08-23: „nincs meg angol nyelven!!!!!". A sugok 2026-08-21
 * ota latszanak a kepernyon, es MINDEN nyelven magyarul jottek: a tabla egynyelvu
 * volt, es az `/api/life/hints` a telepites nyelvet adta vissza akkor is, ha a
 * felulet angolra volt allitva. Ezert all itt minden kulcs mellett `hu` ES `en`
 * -- a tipus kikenyszeriti, hogy egy uj sugo ne szulethessen felig.
 */
import { APP_LANG } from './config.js'

/** Egy sugo mindket nyelven. Nincs opcionalis mezo: felig nem lehet felvenni. */
export type Hint = { hu: string; en: string }

/** Gepi nev -> mit szoktak alaja tenni. */
const HINTS: Record<string, Hint> = {
  // ---- Felso szint ----
  inbox: {
    hu: 'ide dobj be mindent, aminek még nincs helye — innen tesszük a helyére: '
      + 'lefotózott papírok, letöltött számlák, e-mail mellékletek, szkennelt levelek, mentett képek',
    en: 'drop anything here that has no place yet — we file it from here: '
      + 'photographed paperwork, downloaded invoices, e-mail attachments, scanned letters, saved images',
  },
  companies: {
    hu: 'cégenként egy ág: szerződések, számlák, levelezés, weboldal, fejlesztés',
    en: 'one branch per company: contracts, invoices, correspondence, website, development',
  },
  knowledge: {
    hu: 'amit meg akarsz tartani tanulságnak: útmutatók, receptek, jegyzetek, könyvek, cikkek',
    en: 'what you want to keep as knowledge: guides, recipes, notes, books, articles',
  },
  digital: {
    hu: 'ami az online életedhez tartozik: domainek, eszközök, előfizetések, licenckulcsok, fiókok (jelszó soha!)',
    en: 'anything belonging to your online life: domains, devices, subscriptions, licence keys, accounts (never passwords!)',
  },
  media: {
    hu: 'a nagy fájlok helye: fotók, videók, hangfelvételek, szkennek, képernyőmentések',
    en: 'where the large files live: photos, videos, audio recordings, scans, screenshots',
  },
  shared: {
    hu: 'amit másokkal közösen használtok: családi iratok, közös projektek, átadott anyagok, megosztott listák',
    en: 'what you use together with others: family documents, joint projects, handed-over material, shared lists',
  },
  archive: {
    hu: 'ami lezárult, de nem dobható ki: régi évek, megszűnt szerződések, korábbi lakások, lezárt ügyek, régi munkahelyek',
    en: 'what is closed but cannot be thrown away: past years, ended contracts, previous homes, closed cases, former jobs',
  },
  system: {
    hu: 'a Marveen saját dolgai — tárolók, Marvin, beállítások; ide nem kell nyúlnod',
    en: "Marveen's own things — storages, Marvin, settings; you do not need to touch this",
  },

  // ---- Szemely alatt ----
  identity: {
    hu: 'ami igazolja, hogy ki vagy: személyi igazolvány, útlevél, jogosítvány, lakcímkártya, TAJ- és adókártya, anyakönyvi kivonat',
    en: 'what proves who you are: ID card, passport, driving licence, address card, social security and tax card, birth certificate',
  },
  personal: {
    hu: 'ami rólad szól, de nem hatósági: önéletrajz, oklevelek, bizonyítványok, tagságok, saját levelezés',
    en: 'what is about you but not official: CV, diplomas, certificates, memberships, personal correspondence',
  },
  family: {
    hu: 'a hozzátartozók iratai: házassági anyakönyv, gyerekek papírjai, szülők dokumentumai, családfa, öröklés',
    en: "relatives' documents: marriage certificate, children's papers, parents' documents, family tree, inheritance",
  },
  finance: {
    hu: 'ahol a pénz mozog: bankszámlák, hitelek, befektetések, nyugdíjpénztár, adóbevallás',
    en: 'where the money moves: bank accounts, loans, investments, pension fund, tax returns',
  },
  legal: {
    hu: 'ami jogilag köt: szerződések, meghatalmazások, végrendelet, peres iratok, ügyvédi levelezés',
    en: 'what binds you legally: contracts, powers of attorney, will, litigation papers, correspondence with lawyers',
  },
  authorities: {
    hu: 'hivatalos ügyintézés: NAV, önkormányzat, kormányablak, rendőrség, bíróság',
    en: 'dealing with the authorities: tax office, local council, government office, police, court',
  },
  home: {
    hu: 'a lakáshoz tartozó papírok: adásvételi vagy bérleti szerződés, közüzemi számlák, biztosítás, felújítás, garancialevelek',
    en: 'papers belonging to your home: purchase or rental contract, utility bills, insurance, renovation, warranty letters',
  },
  work: {
    hu: 'a munkaviszony papírjai: munkaszerződés, bérjegyzékek, munkáltatói igazolások, továbbképzések, referenciák',
    en: 'papers of your employment: employment contract, payslips, employer certificates, training, references',
  },
  projects: {
    hu: 'a saját, folyamatban lévő ügyeid: építkezés, tanulás, fejlesztés, pályázat, költözés',
    en: 'your own things in progress: building work, studying, development, grant applications, moving house',
  },
  health: {
    hu: 'az egészségügyi papírok: leletek, zárójelentések, receptek, oltási könyv, szemüveg- és fogászati papírok',
    en: 'your medical papers: test results, discharge reports, prescriptions, vaccination record, optician and dental papers',
  },
  documents: {
    hu: 'ami sehova máshova nem illik: vegyes iratok, igazolások, nyugták, jegyzetek, másolatok',
    en: 'what fits nowhere else: assorted documents, certificates, receipts, notes, copies',
  },

  // ---- Ceg alatt ----
  companyAffairs: {
    hu: 'maga a cég: cégkivonat, alapító okirat, taggyűlési jegyzőkönyvek, aláírási címpéldány, engedélyek',
    en: 'the company itself: register extract, articles of association, meeting minutes, specimen signature, permits',
  },
  correspondence: {
    hu: 'akikkel leveleztek: ügyfelek, beszállítók, hatóságok, könyvelő, ajánlatok',
    en: 'whoever you write to: clients, suppliers, authorities, accountant, quotes',
  },
  knowledgeBase: {
    hu: 'ahogy ez működik: folyamatleírások, szabályzatok, sablonok, oktatóanyagok, gyakori kérdések',
    en: 'how this works: process descriptions, policies, templates, training material, FAQs',
  },
  moreMaterial: {
    hu: 'ami nem fért a többibe: prezentációk, tanulmányok, fordítások, jegyzőkönyvek, vegyes anyagok',
    en: 'what did not fit anywhere else: presentations, studies, translations, minutes, assorted material',
  },
  website: {
    hu: 'a weboldal háttere: tárhely-adatok, domain, arculat, szövegek, látogatottsági kimutatások',
    en: 'behind the website: hosting details, domain, branding, copy, traffic reports',
  },
  development: {
    hu: 'a fejlesztés helye: a GIT_REPOS-ban a valódi repók, mellette a belőlük készült összefoglalók',
    en: 'where development lives: the real repositories under GIT_REPOS, with the summaries built from them beside it',
  },
  marketing: {
    hu: 'ami kifelé megy: kampányok, hirdetések, közösségi média, hírlevelek, arculati elemek',
    en: 'what goes outwards: campaigns, ads, social media, newsletters, brand assets',
  },
  gitRepos: {
    hu: 'a GitHub-repók bekötve — kód és dokumentáció; ide kézzel ne tegyél semmit, a gazda a git',
    en: 'the GitHub repositories, linked in — code and documentation; do not put anything here by hand, git is the owner',
  },

  // ---- Digitalis alatt ----
  domains: {
    hu: 'a domainnevek: lejárati dátumok, regisztrátor, DNS-beállítások, átirányítások, tanúsítványok',
    en: 'your domain names: expiry dates, registrar, DNS settings, redirects, certificates',
  },
  devices: {
    hu: 'a gépek és készülékek: számítógépek, telefonok, garanciajegyek, sorozatszámok, licenckulcsok',
    en: 'your machines and devices: computers, phones, warranty cards, serial numbers, licence keys',
  },
  digitalServices: {
    hu: 'az előfizetések: felhőtárhely, e-mail, streaming, szoftverbérlet, tárhelyszolgáltató (jelszó soha!)',
    en: 'your subscriptions: cloud storage, e-mail, streaming, software rental, hosting provider (never passwords!)',
  },

  // ---- Media alatt ----
  photos: {
    hu: 'fényképek: telefonról, fényképezőről, régi papírképek szkennelve',
    en: 'photographs: from your phone, from a camera, old prints scanned in',
  },
  videos: {
    hu: 'mozgóképek: felvételek, kamerafelvételek, letöltött videók',
    en: 'moving pictures: recordings, camera footage, downloaded videos',
  },
  audio: {
    hu: 'hangfelvételek: diktált jegyzetek, telefonbeszélgetések, zene, hangoskönyv',
    en: 'audio recordings: dictated notes, phone calls, music, audiobooks',
  },
  scans: {
    hu: 'beszkennelt papírok: szerződések, számlák, levelek, orvosi papírok',
    en: 'scanned paperwork: contracts, invoices, letters, medical papers',
  },

  // ---- Rendszer alatt ----
  marvin: {
    hu: 'Marvin saját munkafájljai — ide nem kell nyúlnod',
    en: "Marvin's own working files — you do not need to touch this",
  },
  storages: {
    hu: 'a bekötött tárolók: Git, Drive, Fotók',
    en: 'the linked storages: Git, Drive, Photos',
  },
  git: {
    hu: 'a lehúzott git-fiókok és repóik',
    en: 'the git accounts pulled down and their repositories',
  },
  trash: {
    hu: 'amit az Intézőből töröltél — dátum szerinti mappákban, hogy vissza tudd húzni, ha mégis kellene',
    en: 'what you deleted in the Explorer — in dated folders, so you can pull it back if you need it after all',
  },
}

/**
 * A NEM FIX NEVU helyek sugoi.
 *
 * Kulon allnak, mert a nevuk ember-, ceg- vagy projektnev: a nev szerinti tabla
 * nem talalna oket, pedig eppen ezek a fa legfelso, legfeltunobb elemei.
 */
const SPECIAL: Record<string, Hint> = {
  person: {
    hu: 'egy ember teljes anyaga: iratok, pénzügy, egészség, munka, otthon',
    en: 'everything belonging to one person: documents, finances, health, work, home',
  },
  company: {
    hu: 'egy cég teljes anyaga: céges ügyek, levelezés, pénzügy, weboldal, fejlesztés',
    en: 'everything belonging to one company: company affairs, correspondence, finances, website, development',
  },
  /**
   * EGY PROJEKT mappaja a `Projektek` alatt. A neve nem fix (a felhasznalo
   * adja: `Marvin`, `Tőzsde`), ezert a nev szerinti tabla nem talalja -- pedig
   * eppen itt a legnagyobb a kerdes, hogy mi kerul ala.
   */
  project: {
    hu: 'egy folyamatban lévő ügyed: a tudásbázisa, a vegyes anyagai, és ha kód is tartozik hozzá, a Fejlesztés ág',
    en: 'one of your things in progress: its knowledge base, its assorted material, and if code belongs to it, the Development branch',
  },
  /**
   * A FEJLESZTES ALATTI tudasbazis es tovabbi anyagok. Ugyanaz a nevuk, mint a
   * projekt/ceg szintjen allonak -- a specifikacio 17. pontja szerint
   * szandekosan ket kulon reteg. Amit a felhasznalo lat, az viszont ket
   * egyforma nev egymas alatt; a sugo feladata megmondani, melyik melyik, mert
   * atnevezni nem szabad (minden utat es bekotest eltorne).
   */
  devKnowledge: {
    hu: 'a REPÓK dokumentációjából készült összefoglaló — nem ugyanaz, mint a projekt fölötte lévő Tudásbázisa',
    en: 'a summary built from the REPOSITORIES documentation — not the same as the project Knowledge base above it',
  },
  devMore: {
    hu: 'a fejlesztéshez tartozó vegyes anyag: specifikációk, hibajegyek, tesztjegyzőkönyvek, verziók',
    en: 'assorted development material: specifications, bug tickets, test reports, versions',
  },
  /**
   * A PELDA-agak sugoja: mondja meg, mit kezdjen veluk. Egy pelda, amit nem
   * lehet egyszeruen eltuntetni, tehertetel. Ezert a szoveg kimondja a torlest
   * is, nem csak az atnevezest.
   */
  samplePerson: {
    hu: 'PÉLDA — így néz ki egy családtag ága; nevezd át egy hozzátartozódra, vagy töröld nyugodtan',
    en: 'EXAMPLE — this is what a family member branch looks like; rename it to a relative of yours, or just delete it',
  },
  sampleCompany: {
    hu: 'PÉLDA — így néz ki egy cég ága; nevezd át a saját cégedre, vagy töröld nyugodtan',
    en: 'EXAMPLE — this is what a company branch looks like; rename it to your own company, or just delete it',
  },
}

/** hu vagy en -- barmi mas a magyar valtozatra esik vissza. */
function pick(h: Hint | undefined, lang: string): string {
  if (!h) return ''
  return lang === 'en' ? h.en : h.hu
}

/** Egy gepi nevhez tartozo sugo, vagy ures szoveg, ha nincs. */
export function lifeHint(key: string, lang: string = APP_LANG): string {
  return pick(HINTS[key], lang)
}

/** Minden sugo, gepi nev szerint -- a felulet ebbol dolgozik. */
export function lifeHints(lang: string = APP_LANG): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, h] of Object.entries(HINTS)) out[key] = pick(h, lang)
  return out
}

/** A nem fix nevu helyek sugoi (szemely, ceg, projekt, pelda-agak). */
export function specialHint(key: string, lang: string = APP_LANG): string {
  return pick(SPECIAL[key], lang)
}

/** A ketnyelvu tablak nyersen -- a ketnyelvuseg-teszt ebbol dolgozik. */
export function hintTables(): { hints: Record<string, Hint>; special: Record<string, Hint> } {
  return { hints: { ...HINTS }, special: { ...SPECIAL } }
}

// Nevesitett hozzaferok a nem fix nevu helyekhez. Fuggvenyek, nem konstansok:
// egy konstans befagyasztana a telepites nyelvet, es pontosan ez volt a hiba.
export const personHint = (lang: string = APP_LANG) => specialHint('person', lang)
export const companyHint = (lang: string = APP_LANG) => specialHint('company', lang)
export const projectHint = (lang: string = APP_LANG) => specialHint('project', lang)
export const devKnowledgeHint = (lang: string = APP_LANG) => specialHint('devKnowledge', lang)
export const devMoreHint = (lang: string = APP_LANG) => specialHint('devMore', lang)
export const samplePersonHint = (lang: string = APP_LANG) => specialHint('samplePerson', lang)
export const sampleCompanyHint = (lang: string = APP_LANG) => specialHint('sampleCompany', lang)

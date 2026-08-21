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
 */

/** Gepi nev -> mit szoktak alaja tenni. */
const HINTS: Record<string, string> = {
  // ---- Felso szint ----
  inbox:
    'ide dobj be mindent, aminek még nincs helye — innen tesszük a helyére: '
    + 'lefotózott papírok, letöltött számlák, e-mail mellékletek, szkennelt levelek, mentett képek',
  companies:
    'cégenként egy ág: szerződések, számlák, levelezés, weboldal, fejlesztés',
  knowledge:
    'amit meg akarsz tartani tanulságnak: útmutatók, receptek, jegyzetek, könyvek, cikkek',
  digital:
    'ami az online életedhez tartozik: domainek, eszközök, előfizetések, licenckulcsok, fiókok (jelszó soha!)',
  media:
    'a nagy fájlok helye: fotók, videók, hangfelvételek, szkennek, képernyőmentések',
  shared:
    'amit másokkal közösen használtok: családi iratok, közös projektek, átadott anyagok, megosztott listák',
  archive:
    'ami lezárult, de nem dobható ki: régi évek, megszűnt szerződések, korábbi lakások, lezárt ügyek, régi munkahelyek',
  system:
    'a Marveen saját dolgai — tárolók, Marvin, beállítások; ide nem kell nyúlnod',

  // ---- Szemely alatt ----
  identity:
    'ami igazolja, hogy ki vagy: személyi igazolvány, útlevél, jogosítvány, lakcímkártya, TAJ- és adókártya, anyakönyvi kivonat',
  personal:
    'ami rólad szól, de nem hatósági: önéletrajz, oklevelek, bizonyítványok, tagságok, saját levelezés',
  family:
    'a hozzátartozók iratai: házassági anyakönyv, gyerekek papírjai, szülők dokumentumai, családfa, öröklés',
  finance:
    'ahol a pénz mozog: bankszámlák, hitelek, befektetések, nyugdíjpénztár, adóbevallás',
  legal:
    'ami jogilag köt: szerződések, meghatalmazások, végrendelet, peres iratok, ügyvédi levelezés',
  authorities:
    'hivatalos ügyintézés: NAV, önkormányzat, kormányablak, rendőrség, bíróság',
  home:
    'a lakáshoz tartozó papírok: adásvételi vagy bérleti szerződés, közüzemi számlák, biztosítás, felújítás, garancialevelek',
  work:
    'a munkaviszony papírjai: munkaszerződés, bérjegyzékek, munkáltatói igazolások, továbbképzések, referenciák',
  projects:
    'a saját, folyamatban lévő ügyeid: építkezés, tanulás, fejlesztés, pályázat, költözés',
  health:
    'az egészségügyi papírok: leletek, zárójelentések, receptek, oltási könyv, szemüveg- és fogászati papírok',
  documents:
    'ami sehova máshova nem illik: vegyes iratok, igazolások, nyugták, jegyzetek, másolatok',

  // ---- Ceg alatt ----
  companyAffairs:
    'maga a cég: cégkivonat, alapító okirat, taggyűlési jegyzőkönyvek, aláírási címpéldány, engedélyek',
  correspondence:
    'akikkel leveleztek: ügyfelek, beszállítók, hatóságok, könyvelő, ajánlatok',
  knowledgeBase:
    'ahogy a cég dolgozik: folyamatleírások, belső szabályzatok, sablonok, oktatóanyagok, gyakori kérdések',
  moreMaterial:
    'ami nem fért a többibe: prezentációk, tanulmányok, fordítások, jegyzőkönyvek, vegyes anyagok',
  website:
    'a weboldal háttere: tárhely-adatok, domain, arculat, szövegek, látogatottsági kimutatások',
  development:
    'a fejlesztés: GIT_REPOS, specifikációk, hibajegyek, tesztjegyzőkönyvek, verziók',
  marketing:
    'ami kifelé megy: kampányok, hirdetések, közösségi média, hírlevelek, arculati elemek',
  gitRepos:
    'a GitHub-repók bekötve — kód és dokumentáció; ide kézzel ne tegyél semmit, a gazda a git',

  // ---- Digitalis alatt ----
  domains:
    'a domainnevek: lejárati dátumok, regisztrátor, DNS-beállítások, átirányítások, tanúsítványok',
  devices:
    'a gépek és készülékek: számítógépek, telefonok, garanciajegyek, sorozatszámok, licenckulcsok',
  digitalServices:
    'az előfizetések: felhőtárhely, e-mail, streaming, szoftverbérlet, tárhelyszolgáltató (jelszó soha!)',

  // ---- Media alatt ----
  photos: 'fényképek: telefonról, fényképezőről, régi papírképek szkennelve',
  videos: 'mozgóképek: felvételek, kamerafelvételek, letöltött videók',
  audio:  'hangfelvételek: diktált jegyzetek, telefonbeszélgetések, zene, hangoskönyv',
  scans:  'beszkennelt papírok: szerződések, számlák, levelek, orvosi papírok',

  // ---- Rendszer alatt ----
  marvin:   'Marvin saját munkafájljai — ide nem kell nyúlnod',
  storages: 'a bekötött tárolók: Git, Drive, Fotók',
  git:      'a lehúzott git-fiókok és repóik',
}

/**
 * A SZEMELY- es CEGMAPPAK sugoja.
 *
 * Kulon all, mert ezek neve nem fix: ember- es cegnevek. A nev szerinti tabla
 * nem talalna oket, pedig eppen ezek a fa legfelso, legfeltunobb elemei.
 */
export const PERSON_HINT =
  'egy ember teljes anyaga: iratok, pénzügy, egészség, munka, otthon'
export const COMPANY_HINT =
  'egy cég teljes anyaga: céges ügyek, levelezés, pénzügy, weboldal, fejlesztés'

/**
 * A PELDA-agak sugoja: mondja meg, mit kezdjen veluk.
 *
 * Egy pelda, amit nem lehet egyszeruen eltuntetni, tehertetel. Ezert a szoveg
 * kimondja a torlest is, nem csak az atnevezest.
 */
export const SAMPLE_PERSON_HINT =
  'PÉLDA — így néz ki egy családtag ága; nevezd át egy hozzátartozódra, vagy töröld nyugodtan'
export const SAMPLE_COMPANY_HINT =
  'PÉLDA — így néz ki egy cég ága; nevezd át a saját cégedre, vagy töröld nyugodtan'

/** Egy gepi nevhez tartozo sugo, vagy ures szoveg, ha nincs. */
export function lifeHint(key: string): string {
  return HINTS[key] || ''
}

/** Minden sugo, gepi nev szerint -- a felulet ebbol dolgozik. */
export function lifeHints(): Record<string, string> {
  return { ...HINTS }
}

// A Drive-bejaras felso hatarai -- EGY helyen, mert KET helyen kell.
//
// A szinkron ezekbe futhat bele (`csonkolt`), az Attekintes onellenorzese
// pedig KIIRJA oket a felhasznalonak ("elerted a(z) N mappas hatart"). Amig a
// ket szam ket fajlban allt, a kepernyo a REGI ertekeket mondta: a szoveg
// 500 mappat / 5000 fajlt allitott, mikozben a kod mar 5000-nel es 50 000-nel
// jart (merve 2026-09-23, kanban 284044a2). Egy szam, amit ket helyen kell
// karbantartani, elobb-utobb szetcsuszik -- ezert innen jon mindketto.
//
// Ez a modul SZANDEKOSAN nem importal semmit: igy barmelyik reteg behuzhatja
// korkoros fuggoseg nelkul.

/**
 * Egy futasban legfeljebb ennyi mappat jarunk be -- vegtelen melyseg ellen.
 *
 * MERVE 2026-08-16, mind a 10 csatolt fiokon (`files.list`, `trashed=false`):
 * a legnagyobb 293 mappa (nyalomapuncidma), utana 75 (usalackor) es 73
 * (lackor2). A regi 500-as hatart tehat EGYIK Drive sem erte el -- vagyis a
 * lackor2-n latott "reszleges" uzenet NEM a korlatbol jott, hanem egy ki nem
 * olvashato mappabol. A hatar megis felmegy: nem a mai meret a kerdes, hanem
 * hogy a novekedes ne fusson bele, es kozben maradjon fek egy elszabadult
 * bejaras ellen.
 */
export const MAX_FOLDERS = 5_000

/**
 * Egy futasban legfeljebb ennyi fajlt hozunk le.
 *
 * MERVE 2026-08-16: a legnagyobb Drive 3179 fajl (lackor2), utana 2178
 * (nyalomapuncidma). A regi 5000-es hatar tehat 64%-on allt -- meg nem fajt, de
 * mar lathatoan a kozeleben jart. Ennel a hatarnal az egesz felmeno ag is
 * kimarad (`csonkolt`), vagyis eleg lett volna par ezer uj fajl ahhoz, hogy a
 * szinkron csendben FELIG mukodjon.
 */
export const MAX_FILES = 50_000

// AI Munkapad (kanban #336, 740b432a) -- 1. fazis: vaz + adatmodell.
//
//   GET  /api/workbench/items?project=<id>  -- egy projekt munkadarabjai
//   POST /api/workbench/items               -- uj munkadarab (+ magatol egy v1 verzio)
//   GET  /api/workbench/items/:id           -- egy munkadarab + a verzioi + a reszei
//
// 3. fazis -- VEGYES (kompozit) munkadarab: egy munkadarab tobb RESZBOL allhat
// (szoveg-blokk es kep egyszerre, pl. Facebook-poszt).
//
//   POST   /api/workbench/items/:id/parts            -- uj resz (szoveg vagy mar
//                                                      meglevo kep utja)
//   POST   /api/workbench/items/:id/parts/image?name= -- kep FELTOLTESE a projekt
//                                                      mappajaba + kep-resz (nyers bajtok)
//   PATCH  /api/workbench/items/:id/parts/:partId    -- szoveg/felirat javitasa
//   POST   /api/workbench/items/:id/parts/:partId/move -- fel/le mozgatas
//   DELETE /api/workbench/items/:id/parts/:partId    -- a resz kivetele (a KEP
//                                                      FAJLJA a mappaban marad)
//
// 7. fazis -- IRODAI DOKUMENTUM (DOCX) elonezete. A bongeszo a .docx-et nem
// mutatja meg; a spec (8., 24.) szerinti konnyu ut a LibreOffice headless
// konverzio EGY PDF-fe, amit utana ugyanaz az elonezet mutat.
//
//   GET  /api/workbench/capabilities        -- mi all rendelkezesre a gepen
//   POST /api/workbench/items/:id/convert   -- PDF keszitese (gyorsitotarazva)
//   GET  /api/workbench/items/:id/converted -- a kesz PDF bajtjai (+ letoltes)
//
// A LibreOffice NEM kotelezo: ha nincs, a Munkapad tovabbra is mukodik (a fajl
// letoltheto, a munkadarab szerkesztheto), csak a beagyazott elonezet marad el
// -- es a felhasznalo megkapja, MI hianyzik es HOGYAN szerezheto be. Magatol
// SEMMIT nem telepitunk: a csomagtelepites a tulajdonos dontese.
//
// A Munkapad NEM uj projekt-fogalom: minden vegpont egy LETEZO projekthez
// kotott (`/api/projects`, #321). Ismeretlen projektre 404 jon, nem ures lista.
//
// Minden hiba `{ error: <kod>, message: <emberi mondat> }` alaku, a `message`
// a keres nyelven (HU/EN) -- gepi kod sosem kerul a kepernyore onmagaban.
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import { APP_LANG } from '../../config.js'
import { getProject } from '../../projects.js'
import {
  ensureWorkbenchTables, createWorkItem, getWorkItem, getWorkItemVersion, listWorkItems,
  listWorkItemParts, addWorkItemPart, updateWorkItemPart, moveWorkItemPart, removeWorkItemPart,
  createWorkItemVersion, restoreWorkItemVersion, listWorkItemVersionsView,
  WORK_ITEM_TYPES, WORK_ITEM_STATUSES, WORK_ITEM_PART_KINDS, TITLE_MAX, PART_TEXT_MAX, PART_CAPTION_MAX,
} from '../../workbench.js'
import { writeProjectFile, PROJECT_UPLOAD_MAX_BYTES } from '../../project-files.js'
import { buildPreview } from '../../workbench-preview.js'
import { buildWorkbenchOverview } from '../../workbench-overview.js'
import { workItemTypeForFile, titleFromFileName } from '../../workbench-upload.js'
import { editAsNewVersion, saveTextSourceAsNewVersion, TEXT_SOURCE_MAX } from '../../workbench-edit.js'
import { buildProjectTimeline, clampTimelineLimit } from '../../workbench-timeline.js'
import { searchProject } from '../../workbench-search.js'
import { listDecisions, addDecision, updateDecision, setDecisionRevoked, getDecision, DECISION_MAX_CHARS, DECISIONS_MAX_ACTIVE } from '../../workbench-decisions.js'
import { listTemplates, createFromTemplate } from '../../workbench-templates.js'
import { submitWorkItemForApproval, withdrawWorkItemApproval, decideWorkItemApproval, workItemApprovalState } from '../../workbench-approval.js'
import {
  convertOfficeToPdf, probeLibreOffice, cachedPdfFor, OFFICE_CONVERTIBLE, officeExt,
} from '../../office-convert.js'
import {
  describeAllCapabilities, describeCapability, getCapability,
} from '../../workbench-capabilities.js'
import {
  parseCanvas, applyCanvasOps, canvasSummary, canvasFileName,
  CANVAS_MAX_OBJECTS, CANVAS_TEXT_MAX, CANVAS_MAX_SIZE,
} from '../../workbench-graphic.js'
import { readCanvas, saveCanvas, renderCanvasForItem } from '../../workbench-canvas-store.js'
import { setOverride } from '../../settings-store.js'
import { getSettingDefinition } from '../../config-registry.js'
import { resolveLifePath } from '../../life-explorer.js'
import { createReadStream, statSync } from 'node:fs'
import type { RouteContext } from './types.js'

function uiLang(url: URL): 'hu' | 'en' {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const MESSAGES: Record<string, { hu: string; en: string }> = {
  project_required: {
    hu: 'Nincs megadva, melyik projekt Munkapadját nyitod meg.',
    en: 'It is not given which project\'s Workbench you are opening.',
  },
  version_not_found: {
    hu: 'Ez a verzió nincs meg. Lehet, hogy közben törölted a munkadarabot, vagy egy régi lapot néztél -- frissítsd az oldalt.',
    en: 'That version does not exist. The work item may have been deleted, or you are looking at a stale page -- reload it.',
  },
  version_mismatch: {
    hu: 'Ez a verzió nem ehhez a munkadarabhoz tartozik, ezért nem állítom vissza.',
    en: 'That version belongs to a different work item, so it will not be restored.',
  },
  preview_no_source: {
    hu: 'Ehhez a munkadarabhoz még nincs megjeleníthető tartalom. Írj bele egy szöveg-részt, vagy tölts fel egy képet -- és itt azonnal látni fogod.',
    en: 'There is nothing to show for this work item yet. Add a text part or upload an image, and it will appear here right away.',
  },
  preview_no_depot: {
    hu: 'Nincs még beállítva, hol tárolja a Marveen a fájlokat, ezért az előnézetet sem tudom megmutatni. Nyisd meg a Raktár oldalt, és válaszd ki a mappát.',
    en: 'There is no storage folder set up for Marveen yet, so the preview cannot be shown. Open the Depot page and pick the folder.',
  },
  preview_no_folder: {
    hu: 'Ehhez a projekthez még nincs mappa kiválasztva, ezért a fájlt nem találom. Válaszd ki a projekt mappáját a projekt adatlapján.',
    en: 'This project has no folder selected yet, so the file cannot be found. Choose the project folder on the project page.',
  },
  preview_missing: {
    hu: 'A fájl neve ismert, de a lemezen nincs ott. Lehet, hogy átnevezték vagy áthelyezték.',
    en: 'The file name is known, but the file is not on disk. It may have been renamed or moved.',
  },
  preview_unreachable: {
    hu: 'Ezt a helyet most nem érem el (lecsatolt meghajtó vagy hálózati mappa). Ez NEM azt jelenti, hogy nincs ott a fájl.',
    en: 'This location cannot be reached right now (an unmounted drive or a network folder). This does NOT mean the file is gone.',
  },
  preview_unsupported: {
    hu: 'Ezt a formátumot a böngésző magától nem mutatja meg. Töltsd le, vagy nyisd meg a saját programoddal.',
    en: 'The browser cannot show this format on its own. Download it, or open it with your own program.',
  },
  preview_too_large: {
    hu: 'Ez a fájl túl nagy ahhoz, hogy itt megmutassam. Töltsd le, és nyisd meg a gépeden.',
    en: 'This file is too large to show here. Download it and open it on your computer.',
  },
  preview_unreadable: {
    hu: 'A fájl ott van, de nem tudtam elolvasni. A pontos hibát a részletek mutatják.',
    en: 'The file is there, but it could not be read. The details show the exact error.',
  },
  project_archived: {
    hu: 'Ez a projekt archiválva van, ezért csak olvasható. Ha dolgozni akarsz benne, előbb állítsd vissza a Projektek oldalon.',
    en: 'This project is archived, so it is read-only. To work in it, restore it first on the Projects page.',
  },
  approval_owner_only: {
    hu: 'Elfogadni vagy visszadobni csak a tulajdonos tud, bejelentkezve a felületen.',
    en: 'Only the owner can approve or send back, signed in on the dashboard.',
  },
  approval_bad_action: {
    hu: 'Ismeretlen jóváhagyási lépés.',
    en: 'Unknown approval step.',
  },
  approval_already_done: {
    hu: 'Ez a munkadarab már el van fogadva, nem kell újra jóváhagyásra küldeni.',
    en: 'This work item is already approved; it does not need to be sent again.',
  },
  approval_not_in_review: {
    hu: 'Ez a munkadarab most nem vár jóváhagyásra, ezért nincs mit visszavonni.',
    en: 'This work item is not waiting for approval, so there is nothing to withdraw.',
  },
  approval_no_pending: {
    hu: 'Ehhez a munkadarabhoz most nincs nyitott jóváhagyási kérés (lehet, hogy közben döntöttek róla). Frissítsd az oldalt.',
    en: 'There is no open approval request for this work item (it may have been decided meanwhile). Reload the page.',
  },
  approval_reason_too_long: {
    hu: 'Az indoklás túl hosszú (legfeljebb 1000 karakter).',
    en: 'The note is too long (1000 characters at most).',
  },
  decision_text_required: {
    hu: 'Írd be, miben állapodtatok meg (például: „a logó kék marad”).',
    en: 'Type what was agreed (for example: "the logo stays blue").',
  },
  decision_text_too_long: {
    hu: 'A döntés túl hosszú (legfeljebb 500 karakter). Írd röviden, egy-két mondatban.',
    en: 'The decision is too long (500 characters at most). Keep it to a sentence or two.',
  },
  decision_too_many: {
    hu: 'Ebben a projektben már 200 érvényes döntés van. Vonj vissza néhány régit, mielőtt újat írsz.',
    en: 'This project already has 200 decisions in force. Withdraw some old ones before adding a new one.',
  },
  decision_not_found: {
    hu: 'Ez a döntés nem található (lehet, hogy közben törölték). Frissítsd az oldalt.',
    en: 'This decision was not found (it may have been removed meanwhile). Reload the page.',
  },
  decision_item_not_in_project: {
    hu: 'A megadott munkadarab nem ehhez a projekthez tartozik.',
    en: 'The given work item does not belong to this project.',
  },
  template_not_found: {
    hu: 'Ilyen sablon nincs. Frissítsd az oldalt, és válassz a listából.',
    en: 'There is no such template. Reload the page and pick one from the list.',
  },
  template_failed: {
    hu: 'A sablonból nem sikerült elkészíteni a munkadarabot, ezért semmi nem jött létre. Próbáld újra.',
    en: 'The work item could not be made from the template, so nothing was created. Please try again.',
  },
  search_query_short: {
    hu: 'Írj be legalább 2 betűt a kereséshez.',
    en: 'Type at least 2 characters to search.',
  },
  search_query_long: {
    hu: 'A keresett szöveg túl hosszú (legfeljebb 200 karakter).',
    en: 'The search text is too long (200 characters at most).',
  },
  project_not_found: {
    hu: 'Ez a projekt nem található (lehet, hogy közben törölték).',
    en: 'This project was not found (it may have been deleted).',
  },
  not_found: {
    hu: 'Ez a munkadarab nem található (lehet, hogy közben törölték).',
    en: 'This work item was not found (it may have been deleted).',
  },
  bad_json: {
    hu: 'A kérés nem értelmezhető.',
    en: 'The request could not be read.',
  },
  title_required: {
    hu: 'Adj nevet a munkadarabnak (például: „Ajánlat Kovács úrnak”).',
    en: 'Give the work item a name (for example: "Offer for Mr Smith").',
  },
  title_too_long: {
    hu: `A munkadarab neve túl hosszú (legfeljebb ${TITLE_MAX} karakter). A részleteket írd majd a munkadarabba.`,
    en: `The work item name is too long (${TITLE_MAX} characters at most). Put the details inside the work item.`,
  },
  bad_type: {
    hu: 'Ismeretlen munkadarab-fajta. Válassz a felkínált fajták közül.',
    en: 'Unknown work item kind. Pick one of the offered kinds.',
  },
  bad_status: {
    hu: 'Ismeretlen munkadarab-állapot.',
    en: 'Unknown work item state.',
  },
  bad_kind: {
    hu: 'Ismeretlen résztípus. Egy rész vagy szöveg, vagy kép.',
    en: 'Unknown part kind. A part is either text or an image.',
  },
  text_required: {
    hu: 'Írj valamit a szöveges részbe (üresen nem tudom hozzáadni).',
    en: 'Write something into the text part (an empty one cannot be added).',
  },
  text_too_long: {
    hu: `Ez a szöveg túl hosszú (legfeljebb ${PART_TEXT_MAX} karakter). Bontsd több szöveges részre.`,
    en: `This text is too long (${PART_TEXT_MAX} characters at most). Split it into several text parts.`,
  },
  asset_required: {
    hu: 'Nincs megadva, melyik kép kerüljön a munkadarabba.',
    en: 'It is not given which image should go into the work item.',
  },
  caption_too_long: {
    hu: `A felirat túl hosszú (legfeljebb ${PART_CAPTION_MAX} karakter).`,
    en: `The caption is too long (${PART_CAPTION_MAX} characters at most).`,
  },
  part_not_found: {
    hu: 'Ez a rész már nincs meg (lehet, hogy közben törölték).',
    en: 'This part is gone (it may have been deleted meanwhile).',
  },
  bad_move: {
    hu: 'Nem értem, merre mozgassam a részt (fel vagy le).',
    en: 'It is unclear which way to move the part (up or down).',
  },
  too_large: {
    hu: `Ez a kép túl nagy (legfeljebb ${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Másold be a projekt mappájába, és onnan vedd fel.`,
    en: `This image is too large (${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB at most). Copy it into the project folder and add it from there.`,
  },
  bad_name: {
    hu: 'Ez a fájlnév nem használható. Adj neki egyszerű nevet (például: kep.jpg).',
    en: 'This file name cannot be used. Give it a simple name (for example: photo.jpg).',
  },
  empty_file: {
    hu: 'A feltöltött kép üres volt (nulla bájt). Próbáld újra.',
    en: 'The uploaded image was empty (zero bytes). Try again.',
  },
  no_depot: {
    hu: 'Nincs beállítva Raktár, ezért a kép nem tud hova kerülni. Beállítások → Raktár.',
    en: 'No Depot is configured, so the image has nowhere to go. Settings → Depot.',
  },
  no_folder: {
    hu: 'Ehhez a projekthez nincs mappa, ezért a kép nem tud hova kerülni. Nyisd meg a projektet, és adj neki mappát.',
    en: 'This project has no folder, so the image has nowhere to go. Open the project and give it a folder.',
  },
  missing: {
    hu: 'A projekt mappája nincs meg a lemezen. Nyisd meg a projektet, és nézd meg a mappáját.',
    en: 'The project folder is missing from the disk. Open the project and check its folder.',
  },
  unreachable: {
    hu: 'A projekt mappáját most nem érem el (lehet, hogy a meghajtó nincs csatlakoztatva).',
    en: 'The project folder cannot be reached right now (the drive may be disconnected).',
  },
  bad_folder: {
    hu: 'A megadott almappa nem használható.',
    en: 'The given subfolder cannot be used.',
  },
  repo_inside: {
    hu: 'Ide nem írhatok: a mappa egy git tároló belseje.',
    en: 'I cannot write here: this folder is inside a git repository.',
  },
  write_failed: {
    hu: 'A képet nem sikerült kiírni a projekt mappájába.',
    en: 'The image could not be written into the project folder.',
  },

  // --- 7. fazis: irodai dokumentum -> PDF ---
  preview_needs_conversion: {
    hu: 'Ezt a dokumentumot a böngésző magától nem tudja megmutatni, de tudok belőle PDF-előnézetet készíteni. Kattints az „Előnézet készítése” gombra -- a fájlhoz nem nyúlok hozzá, az eredeti marad.',
    en: 'The browser cannot show this document on its own, but a PDF preview can be made from it. Click "Create preview" -- the file itself is left untouched.',
  },
  convert_unsupported: {
    hu: 'Ebből a fájlból nem tudok PDF-előnézetet készíteni. Töltsd le, és nyisd meg a saját gépeden.',
    en: 'A PDF preview cannot be made from this file. Download it and open it on your own computer.',
  },
  convert_missing_source: {
    hu: 'A dokumentum fájlja nincs meg a lemezen, ezért nincs miből előnézetet készíteni. Nézd meg a projekt mappáját.',
    en: 'The document file is missing from the disk, so there is nothing to build a preview from. Check the project folder.',
  },
  convert_not_installed: {
    hu: 'Az előnézethez a LibreOffice kellene, és az ezen a gépen nincs telepítve. Enélkül minden más működik: a dokumentum letölthető és szerkeszthető, csak itt, beágyazva nem látszik. Ha szeretnéd: Linuxon „sudo apt install libreoffice-writer”, Windowson/macOS-en a libreoffice.org oldaláról telepíthető -- utána nyomj a „Mégegyszer” gombra. Ha máshova telepítetted, add meg az útvonalát a MARVEEN_SOFFICE beállításban.',
    en: 'The preview needs LibreOffice, and it is not installed on this machine. Everything else still works: the document can be downloaded and edited, it just cannot be shown embedded here. If you want it: on Linux "sudo apt install libreoffice-writer", on Windows/macOS from libreoffice.org -- then press "Try again". If you installed it elsewhere, give its path in the MARVEEN_SOFFICE setting.',
  },
  convert_check_failed: {
    hu: 'Nem tudtam megállapítani, van-e LibreOffice ezen a gépen -- tehát ez NEM azt jelenti, hogy nincs. A pontos hibaüzenet a részleteknél olvasható; ha a MARVEEN_SOFFICE beállításban adtál meg útvonalat, ellenőrizd, hogy jó-e.',
    en: 'It could not be determined whether LibreOffice is on this machine -- so this does NOT mean it is missing. The exact error is in the details; if you set a path in MARVEEN_SOFFICE, check that it is correct.',
  },
  convert_timeout: {
    hu: 'Az átalakítás túl sokáig tartott, ezért leállítottam. Nagy vagy sérült dokumentumnál fordul elő. Próbáld újra, vagy nyisd meg a fájlt a saját gépeden.',
    en: 'The conversion took too long, so it was stopped. This happens with very large or damaged documents. Try again, or open the file on your own computer.',
  },
  convert_failed: {
    hu: 'Az átalakítás nem sikerült. A pontos hibaüzenet a részleteknél olvasható -- nem találgatok helyette okot.',
    en: 'The conversion failed. The exact error is in the details -- no cause is guessed in its place.',
  },
  convert_no_output: {
    hu: 'Az átalakító lefutott, de nem keletkezett PDF. Ez általában sérült vagy jelszóval védett dokumentumnál fordul elő.',
    en: 'The converter ran but produced no PDF. This usually happens with a damaged or password-protected document.',
  },
  document_too_large: {
    hu: `Ez a dokumentum túl nagy (legfeljebb ${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Másold be a projekt mappájába, és onnan vedd fel.`,
    en: `This document is too large (${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB at most). Copy it into the project folder and add it from there.`,
  },
  convert_not_ready: {
    hu: 'Ennek a dokumentumnak még nincs kész PDF-előnézete. Nyomj az „Előnézet készítése” gombra.',
    en: 'This document has no PDF preview yet. Press "Create preview".',
  },
  capability_unknown: {
    hu: 'Nincs ilyen képesség. A lista a Munkapad „Mi működik ezen a gépen?” paneljén látható.',
    en: 'There is no such capability. The list is on the Workbench "What works on this machine?" panel.',
  },
  capability_no_setting: {
    hu: 'Ehhez a képességhez nem tartozik beállítható érték, így nincs mit menteni.',
    en: 'This capability has no value to set, so there is nothing to save.',
  },
  canvas_bad_json: {
    hu: 'A rajz fájlja sérült: nem értelmezhető adat áll benne. A korábbi verziók érintetlenek, azokból vissza lehet állni.',
    en: 'The drawing file is damaged: it does not hold readable data. The earlier versions are untouched, you can go back to one of them.',
  },
  canvas_bad_shape: {
    hu: 'Ez nem rajzvászon: szélesség, magasság és elem-lista kellene bele.',
    en: 'This is not a canvas: it needs a width, a height and a list of objects.',
  },
  canvas_bad_object: {
    hu: 'A vászon egyik eleme értelmezhetetlen. Elem csak szöveg, téglalap vagy kép lehet.',
    en: 'One element of the canvas cannot be read. An element can only be a text, a rectangle or a picture.',
  },
  canvas_text_too_long: {
    hu: 'Ez a szöveg túl hosszú egy rajz-elemhez. Vágd rövidebbre, vagy tedd több elembe.',
    en: 'This text is too long for a drawing element. Make it shorter, or split it into several elements.',
  },
  canvas_too_many: {
    hu: 'Túl sok elem van a vásznon. Törölj néhányat, vagy bontsd szét több rajzra.',
    en: 'There are too many elements on the canvas. Remove some, or split it into several drawings.',
  },
  canvas_bad_ops: {
    hu: 'Ezt a módosítást nem tudom értelmezni. A részletek megmondják, melyik lépéssel van a baj.',
    en: 'I cannot read this change. The details say which step is the problem.',
  },
  canvas_object_not_found: {
    hu: 'Nincs ilyen elem a vásznon. A részletek felsorolják, mi van rajta.',
    en: 'There is no such element on the canvas. The details list what is on it.',
  },
  canvas_no_depot: {
    hu: 'A rajz fájljához nem látok oda: nincs beállítva a Raktár ezen a gépen. Ez NEM azt jelenti, hogy a rajz elveszett: a Beállításoknál add meg a Raktár helyét.',
    en: 'I cannot see the drawing file: the Depot is not set up on this machine. This does NOT mean the drawing is lost -- set the Depot folder in Settings.',
  },
  canvas_no_folder: {
    hu: 'A rajz fájljához nem látok oda: ennek a projektnek még nincs mappája. A projekt adatlapján lehet mappát választani.',
    en: 'I cannot see the drawing file: this project has no folder yet. You can pick one on the project page.',
  },
  canvas_missing: {
    hu: 'A rajz fájlja nincs a helyén (átnevezés vagy áthelyezés után ez történik). A korábbi verziók megvannak.',
    en: 'The drawing file is not where it should be (this happens after a rename or a move). The earlier versions are still there.',
  },
  canvas_unreachable: {
    hu: 'A rajz fájlja most nem érhető el. Ez nem azt jelenti, hogy nincs meg: próbáld újra.',
    en: 'The drawing file cannot be reached right now. That does not mean it is gone -- try again.',
  },
  canvas_unreadable: {
    hu: 'A rajz fájlját nem sikerült beolvasni. A részletek a rendszer saját hibaüzenetét mutatják.',
    en: 'The drawing file could not be read. The details show the system message itself.',
  },
  canvas_too_large: {
    hu: 'A rajz fájlja túl nagy ahhoz, hogy megnyissam.',
    en: 'The drawing file is too large to open.',
  },
  canvas_saved: {
    hu: 'Mentve, új verzióként. A korábbi állapot megmaradt.',
    en: 'Saved as a new version. The earlier state is kept.',
  },
  text_source_unsupported: {
    hu: 'Ennek a munkadarabnak a forrása nem szövegfájl, ezért itt nem írható át. Dokumentumnál töltsd le, szerkeszd a gépeden, és töltsd vissza.',
    en: 'The source of this work item is not a text file, so it cannot be rewritten here. For a document, download it, edit it on your computer and upload it again.',
  },
  text_source_truncated: {
    hu: `Ez a szövegfájl túl hosszú ahhoz, hogy itt biztonságosan átírjam (az előnézet csak az elejét mutatja, legfeljebb ${TEXT_SOURCE_MAX} karaktert írok). Nyisd meg a saját programoddal.`,
    en: `This text file is too long to rewrite here safely (the preview only shows its beginning; at most ${TEXT_SOURCE_MAX} characters are written). Open it with your own program.`,
  },
  text_source_too_long: {
    hu: `A szöveg túl hosszú (legfeljebb ${TEXT_SOURCE_MAX} karakter).`,
    en: `The text is too long (${TEXT_SOURCE_MAX} characters at most).`,
  },
  upload_too_large: {
    hu: `Ez a fájl túl nagy (legfeljebb ${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Másold be a projekt mappájába a gépeden, és onnan vedd fel.`,
    en: `This file is too large (${Math.floor(PROJECT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB at most). Copy it into the project folder on your computer and add it from there.`,
  },
  upload_empty: {
    hu: 'A feltöltött fájl üres volt (nulla bájt). Próbáld újra.',
    en: 'The uploaded file was empty (zero bytes). Try again.',
  },
  upload_no_depot: {
    hu: 'Nincs beállítva Raktár, ezért a fájl nem tud hova kerülni. Nyisd meg a Raktár oldalt, és válaszd ki a mappát.',
    en: 'No Depot is configured, so the file has nowhere to go. Open the Depot page and pick the folder.',
  },
  upload_no_folder: {
    hu: 'Ehhez a projekthez nincs mappa, ezért a fájl nem tud hova kerülni. Nyisd meg a projekt adatlapját, és adj neki mappát.',
    en: 'This project has no folder, so the file has nowhere to go. Open the project page and give it a folder.',
  },
  upload_missing: {
    hu: 'A projekt mappája nincs meg a lemezen. Nyisd meg a projektet, és nézd meg a mappáját.',
    en: 'The project folder is missing from the disk. Open the project and check its folder.',
  },
  upload_unreachable: {
    hu: 'A projekt mappáját most nem érem el (lehet, hogy a meghajtó nincs csatlakoztatva). Ez NEM azt jelenti, hogy eltűnt.',
    en: 'The project folder cannot be reached right now (the drive may be disconnected). This does NOT mean it is gone.',
  },
  capability_saved: {
    hu: 'Elmentve, és azonnal újra megmértem.',
    en: 'Saved, and measured again right away.',
  },
}

/** Gepi kod -> EMBERI mondat. Ismeretlen kodnal a kodot adjuk vissza, hogy
 *  soha ne legyen ures a mondat (az ures uzenet rosszabb a nyers kodnal). */
function msg(code: string, lang: 'hu' | 'en'): string {
  const m = MESSAGES[code]
  return m ? m[lang] : code
}

function fail(res: RouteContext['res'], status: number, code: string, lang: 'hu' | 'en'): true {
  const m = MESSAGES[code]
  json(res, { error: code, message: m ? m[lang] : code }, status)
  return true
}

/** Ugyanaz, mint a `fail`, de VISZI a rendszer sajat hibauzenetet is. A
 *  `message` az EMBERI mondat, a `detail` a MERT tenyeknek a helye -- igy a
 *  felhasznalo ertheto mondatot lat, es kozben nem tunik el, MI tortent
 *  valojaban (a hiba okat sosem talaljuk ki helyette). */
function failDetail(res: RouteContext['res'], status: number, code: string, lang: 'hu' | 'en', detail: string | null): true {
  json(res, { error: code, message: msg(code, lang), detail: detail || null }, status)
  return true
}

async function readJson(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req)).toString('utf-8').trim()
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Ki hozta letre. A felulet mogott mindig egy bejelentkezett munkamenet all;
 *  token/federacios hivonal marad a nyers fajta -- semmi beegetett nev. */
function actor(ctx: RouteContext): string | null {
  const a = ctx.auth
  if (!a) return null
  if (a.kind === 'session' && a.user) return a.user
  if (a.kind === 'federation' && a.peer) return a.peer
  if (a.kind === 'device' && a.device) return a.device
  return a.kind
}

export async function tryHandleWorkbench(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/api/workbench/')) return false
  const lang = uiLang(url)
  ensureWorkbenchTables()

  // MI ALL RENDELKEZESRE EZEN A GEPEN (spec 1-2), es ami nem, azzal MI A
  // TEENDO. Friss telepitesen a valasz tobbnyire "nincs meg" -- es az NEM
  // hiba: minden sor megmondja, mire hat, es hogyan szerezheto be. A "nem
  // tudtam megkerdezni" KULON allapot: azt sosem mondjuk "nincs"-nek.
  //
  //   GET  /api/workbench/capabilities            -- a teljes lista (?force=1: ujramer)
  //   POST /api/workbench/capabilities/:key/test  -- EGY kepesseg ujramerese
  //   POST /api/workbench/capabilities/:key/setting -- a hozza tartozo beallitas
  //
  // A beallitas-iras SZUK: csak az a kulcs irhato, amit a kepesseg leirasa
  // megnevez (`writableSettingKeys`) -- ez a vegpont nem altalanos config-iro.
  if (path === '/api/workbench/capabilities' && method === 'GET') {
    const force = url.searchParams.get('force') === '1'
    json(res, { capabilities: await describeAllCapabilities(lang, force) })
    return true
  }

  if (path.startsWith('/api/workbench/capabilities/') && method === 'POST') {
    const rest = path.slice('/api/workbench/capabilities/'.length).split('/')
    const cap = getCapability(decodeURIComponent(rest[0] || ''))
    if (!cap) return fail(res, 404, 'capability_unknown', lang)
    const action = rest[1] || ''

    if (action === 'test') {
      // Az "Ellenorzes most" MINDIG ujramer: telepites vagy beallitas utan a
      // regi meresbol valaszolni pont azt a hibat okozna, amit javitani akart.
      json(res, { capability: await describeCapability(cap, lang, true) })
      return true
    }

    if (action === 'setting') {
      if (!cap.setting_key) return fail(res, 400, 'capability_no_setting', lang)
      const body = await readJson(req)
      if (!body) return fail(res, 400, 'bad_json', lang)
      const def = getSettingDefinition(cap.setting_key)
      const secret = def?.secret === true
      const raw = body['value']
      // TITOKNAL: az ures mezo azt jelenti, hogy NEM nyulunk hozza (kulonben
      // a mentes torolne a kulcsot, amit a bongeszo sosem latott). A `null`
      // a kimondott torles. Nem titoknal az ures ertek ervenyes ertek: "keresd
      // meg magadtol".
      const skip = secret && typeof raw === 'string' && raw.trim() === ''
      if (!skip) {
        const value = raw === null ? '' : String(raw ?? '').trim()
        const r = setOverride(cap.setting_key, value)
        // A VALODI hibauzenetet adjuk vissza (a registry validalasa mondja ki),
        // nem egy talalgatott okot.
        if (!r.ok) {
          json(res, { error: 'setting_invalid', message: r.error || msg('capability_no_setting', lang) }, 400)
          return true
        }
      }
      json(res, {
        capability: await describeCapability(cap, lang, true),
        saved: !skip,
        message: msg('capability_saved', lang),
      })
      return true
    }

    return fail(res, 404, 'not_found', lang)
  }

  // PROJEKT-ATTEKINTO (#406, 2. pont): nyitott / jovahagyasra var / friss
  // kesz / utoljara valtozott fajl. Csak olvas; ismeretlen projektre 404.
  if (path === '/api/workbench/overview' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    json(res, { project: { id: project.id, name: project.name, archived: project.archived_at != null }, overview: buildWorkbenchOverview(project.id) })
    return true
  }

  // PROJEKT-IDOVONAL (#406, 7. pont): a projekt minden esemenye, a
  // legfrissebb elol. `before` = lapozas visszafele (masodperc). Csak olvas.
  if (path === '/api/workbench/timeline' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const beforeRaw = Number(url.searchParams.get('before') || '')
    json(res, {
      timeline: buildProjectTimeline(project.id, {
        before: Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null,
        limit: clampTimelineLimit(url.searchParams.get('limit')),
      }),
    })
    return true
  }

  // KERESES A PROJEKT EGESZEBEN (#406, 8. pont): cimek, szovegek,
  // kepalairasok, beszelgetesek, kartyak, otletek, fajlnevek. Csak olvas.
  if (path === '/api/workbench/search' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const r = await searchProject(project, url.searchParams.get('q'))
    if (!r.ok) return fail(res, 400, r.code === 'query_short' ? 'search_query_short' : 'search_query_long', lang)
    json(res, { search: r.result })
    return true
  }

  // DONTESNAPLO (#406, 10. pont): amiben a projektben megallapodtak.
  // Visszavonni lehet (a sor atuzva megmarad), torolni nem.
  if (path === '/api/workbench/decisions' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    json(res, {
      decisions: listDecisions(project.id, { includeRevoked: true }),
      max_chars: DECISION_MAX_CHARS,
      max_active: DECISIONS_MAX_ACTIVE,
    })
    return true
  }
  if (path === '/api/workbench/decisions' && method === 'POST') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const pid = typeof body['project'] === 'string' ? body['project'].trim() : ''
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = addDecision({
      project_id: project.id,
      text: body['text'],
      work_item_id: typeof body['work_item_id'] === 'string' && body['work_item_id'] ? body['work_item_id'] : null,
      by: actor(ctx),
      source: 'owner',
    })
    if (!r.ok) return fail(res, r.code === 'too_many' ? 409 : 400, 'decision_' + r.code, lang)
    json(res, { decision: r.decision })
    return true
  }
  const decMatch = path.match(/^\/api\/workbench\/decisions\/([^/]+)$/)
  if (decMatch && method === 'PATCH') {
    const d = getDecision(decodeURIComponent(decMatch[1]))
    if (!d) return fail(res, 404, 'decision_not_found', lang)
    const project = getProject(d.project_id)
    if (project && project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    let r = null as ReturnType<typeof updateDecision> | null
    if ('text' in body) r = updateDecision(d.id, body['text'])
    if ((!r || r.ok) && typeof body['revoked'] === 'boolean') r = setDecisionRevoked(d.id, body['revoked'])
    if (!r) return fail(res, 400, 'decision_text_required', lang)
    if (!r.ok) return fail(res, r.code === 'not_found' ? 404 : r.code === 'too_many' ? 409 : 400, 'decision_' + r.code, lang)
    json(res, { decision: r.decision })
    return true
  }

  // SABLONOK (#406, 11. pont): egy kattintassal uj munkadarab, elore kitoltott
  // szerkezettel. A sablonok a kodban elnek, friss telepitesen is ott vannak.
  if (path === '/api/workbench/templates' && method === 'GET') {
    json(res, { templates: listTemplates(lang) })
    return true
  }
  if (path === '/api/workbench/templates/use' && method === 'POST') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const pid = typeof body['project_id'] === 'string' ? body['project_id'].trim() : ''
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = createFromTemplate(project, body['template'], { title: body['title'], lang, created_by: actor(ctx) })
    if (!r.ok) return fail(res, r.code === 'template_not_found' ? 404 : r.code === 'template_failed' ? 500 : 400, r.code, lang)
    json(res, { ok: true, item: r.item, versions: [r.version], parts: r.parts, template: r.template }, 201)
    return true
  }

  if (path !== '/api/workbench/items' && !path.startsWith('/api/workbench/items/')) return false

  if (path === '/api/workbench/items' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    json(res, {
      project: { id: project.id, name: project.name, archived: project.archived_at != null },
      items: listWorkItems(project.id),
      types: WORK_ITEM_TYPES,
      statuses: WORK_ITEM_STATUSES,
    })
    return true
  }

  if (path === '/api/workbench/items' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const pid = String(body.project_id ?? '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = createWorkItem({
      project_id: project.id,
      type: body.type,
      title: body.title,
      status: body.status,
      source_path: body.source_path,
      prompt: body.prompt,
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, item: r.item, versions: [r.version] }, 201)
    return true
  }

  // FAJLBOL UJ MUNKADARAB (#406, 3. pont): behuzas / feltoltes a feluletrol,
  // telefonrol is. A nyers bajtok jonnek, a nev a query-ben (ekezetes nev sem
  // torik el). A fajl a projekt mappajaba kerul, foglalt nevnel UJ nevet kap
  // (sosem ir felul), es egy uj munkadarab szuletik, aminek ez a forrasa.
  if (path === '/api/workbench/items/upload' && method === 'POST') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'upload_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'upload_too_large', lang)
      throw e
    }
    if (!data.length) return fail(res, 400, 'upload_empty', lang)
    const name = url.searchParams.get('name') || ''
    const out = writeProjectFile(project, url.searchParams.get('sub'), name, data)
    if (!out.ok) {
      const code = MESSAGES['upload_' + out.code] ? 'upload_' + out.code : out.code
      return failDetail(res, out.code === 'write_failed' ? 500 : 400, code, lang, 'message' in out ? (out.message || null) : null)
    }
    const r = createWorkItem({
      project_id: project.id,
      type: workItemTypeForFile(out.name, url.searchParams.get('type')),
      title: titleFromFileName(out.name),
      source_path: out.rel,
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, item: r.item, versions: [r.version], file: out, renamed: out.renamed, name: out.name }, 201)
    return true
  }

  if (!path.startsWith('/api/workbench/items/')) return false

  // .../items/<id>[/parts[/<partId>[/move]]]
  const segs = path.slice('/api/workbench/items/'.length).split('/').map((sg) => {
    // Rosszul kodolt url nem dobhat 500-at: ilyenkor egyszeruen nincs ilyen darab.
    try { return decodeURIComponent(sg) } catch { return sg }
  })
  const item = getWorkItem(segs[0] || '')
  if (!item) return fail(res, 404, 'not_found', lang)

  if (segs.length === 1 && method === 'GET') {
    const project = getProject(item.project_id)
    json(res, {
      item,
      versions: listWorkItemVersionsView(item.id),
      parts: listWorkItemParts(item.id),
      part_kinds: WORK_ITEM_PART_KINDS,
      approval: workItemApprovalState(item.id),
      project: project ? { id: project.id, name: project.name, archived: project.archived_at != null } : null,
    })
    return true
  }

  // JOVAHAGYAS MUNKADARABRA (#406, 9. pont): bekuldes / visszavonas a
  // Munkapadrol barki; DONTENI (elfogad / visszadob) csak bejelentkezett
  // munkamenet tud -- az agensek kozos tokenje nem.
  if (segs.length === 2 && segs[1] === 'approval' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const action = body['action']
    const who = actor(ctx)
    let r
    if (action === 'submit') r = submitWorkItemForApproval(item.id, { actor: who, lang })
    else if (action === 'withdraw') r = withdrawWorkItemApproval(item.id, { actor: who, lang })
    else if (action === 'approve' || action === 'reject') {
      if (ctx.auth?.kind !== 'session') return fail(res, 403, 'approval_owner_only', lang)
      r = decideWorkItemApproval(item.id, action === 'approve' ? 'approved' : 'rejected', { by: who || 'dashboard', reason: body['reason'] })
    } else return fail(res, 400, 'approval_bad_action', lang)
    if (!r.ok) return fail(res, r.code === 'reason_too_long' ? 400 : 409, 'approval_' + r.code, lang)
    json(res, { item: r.item, approval: r.approval })
    return true
  }

  // VERZIOZAS (5. fazis; spec 12): minden jelentos modositas UJ verzio, es a
  // regi SOHA nem irodik felul. A visszaallitas sem ir felul semmit: a regi
  // allapotbol UJ verzio lesz, a kozben keletkezettek megmaradnak.
  if (segs.length === 2 && segs[1] === 'versions' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = createWorkItemVersion(item.id, {
      prompt: body['prompt'],
      // A `source_path` csak akkor valtozik, ha a hivo KIMONDJA -- kulonben marad.
      ...('source_path' in body ? { source_path: body['source_path'] } : {}),
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id) }, 201)
    return true
  }

  // EGY VERZIO RESZEI (#406, 5. pont): a verziok egymas melletti
  // osszehasonlitasahoz. Csak olvas; masik munkadarab verziojara 409 (nem
  // "ures lista" -- az osszekeveres kulon valaszt erdemel).
  if (segs.length === 4 && segs[1] === 'versions' && segs[3] === 'parts' && method === 'GET') {
    const v = getWorkItemVersion(segs[2] || '')
    if (!v) return fail(res, 404, 'version_not_found', lang)
    if (v.work_item_id !== item.id) return fail(res, 409, 'version_mismatch', lang)
    const isCurrent = v.id === item.current_version_id
    json(res, {
      version: v,
      // A mostani verzio "elo" reszei a verziozas elotti sorokat is fogjak.
      parts: listWorkItemParts(item.id, isCurrent ? null : v.id),
    })
    return true
  }

  if (segs.length === 4 && segs[1] === 'versions' && segs[3] === 'restore' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = restoreWorkItemVersion(segs[2] || '', { created_by: actor(ctx), work_item_id: item.id })
    if (!r.ok) return fail(res, r.code === 'version_mismatch' ? 409 : 404, r.code, lang)
    json(res, { ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id), parts: listWorkItemParts(item.id) }, 201)
    return true
  }

  // ELONEZET (4. fazis): mit lehet megmutatni a kozepso panelen, es ha semmit,
  // MIERT nem. A bajtokat a MEGLEVO fajl-kiszolgalo adja (`/api/life/file?rel=`),
  // ez a vegpont csak megmondja, MIT kell kerni -- nincs masodik fajl-ut.
  if (segs.length === 2 && segs[1] === 'preview' && method === 'GET') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    const message = p.reason ? msg('preview_' + p.reason, lang) : null
    // GYORSITOTAR (spec: "verziohoz kotve, cache"): a jelzes a VERZIOHOZ es a
    // fajl allapotahoz kotodik, tehat valtozasra magatol elavul. `no-cache` =
    // eltarolhato, de MINDIG vissza kell kerdezni -- igy a nagy szoveges
    // elonezet nem megy at ujra a droton, de elavult tartalmat sem latni.
    // A nyelv is beleszamit: mas nyelven MAS mondat jon.
    const tag = p.etag ? `W/"${p.etag}-${lang}"` : null
    const cacheHeaders = tag ? { ETag: tag, 'Cache-Control': 'private, no-cache' } : undefined
    if (tag && req.headers['if-none-match'] === tag) {
      res.writeHead(304, cacheHeaders)
      res.end()
      return true
    }
    json(res, {
      ...p,
      message,
      // Keszre epitett cim -- a felulet ne rakjon ossze sajat utvonalat.
      // Keszre epitett cim. A sajat fajlt a MEGLEVO fajl-kiszolgalo adja; az
      // ATALAKITOTT PDF viszont nem a Raktarban all (szarmaztatott adat), ezert
      // annak sajat, szuk vegpontja van -- de ugyanugy egyetlen ut, nem harom.
      url: p.available && p.kind === 'office'
        ? `/api/workbench/items/${encodeURIComponent(item.id)}/converted?lang=${lang}`
          + (p.version_id ? `&version=${encodeURIComponent(p.version_id)}` : '')
        : p.available && p.rel && p.kind !== 'parts' && p.kind !== 'text'
          ? `/api/life/file?rel=${encodeURIComponent(p.rel)}&lang=${lang}`
          : null,
      versions: listWorkItemVersionsView(item.id),
    }, 200, cacheHeaders)
    return true
  }

  // PDF KESZITESE irodai dokumentumbol (7. fazis). Nem ir felul semmit: az
  // eredeti fajlhoz hozza sem nyulunk, a PDF a `store/` alatti gyorsitotarba
  // kerul, es a forras valtozasara magatol elavul (a kulcs a forras allapota).
  //
  // SZANDEKOSAN az "archivalt projekt = csak olvashato" sor ELOTT all: az
  // elonezet keszitese OLVASAS a felhasznalo adatain (a sajat fajljabol semmi
  // nem valtozik), ezert egy archivalt projekt dokumentumat is meg lehet nezni.
  if (segs.length === 2 && segs[1] === 'convert' && method === 'POST') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    if (p.kind !== 'office' || !p.rel) return fail(res, 400, 'convert_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const r = await convertOfficeToPdf(abs)
    if (!r.ok) {
      // A kodot az ATALAKITO mondja meg (nincs telepitve / nem tudtam
      // megkerdezni / idotullepes / hibauzenet), nem mi talaljuk ki. A `detail`
      // a VALODI hibauzenet, hogy a felhasznalo tovabb tudjon lepni.
      const status = r.code === 'not_installed' || r.code === 'check_failed' ? 501
        : r.code === 'timeout' ? 504
        : r.code === 'missing_source' ? 404
        : r.code === 'unsupported' ? 400 : 500
      const code = 'convert_' + r.code
      json(res, {
        error: code, message: msg(code, lang), detail: r.detail,
        capability: r.probe ? { key: 'office_to_pdf', state: r.probe.reason, checked_at: r.probe.checked_at } : null,
      }, status)
      return true
    }
    json(res, {
      ok: true, ready: true, cached: r.cached,
      ext: officeExt(p.name) || null,
      url: `/api/workbench/items/${encodeURIComponent(item.id)}/converted?lang=${lang}`
        + (p.version_id ? `&version=${encodeURIComponent(p.version_id)}` : ''),
    })
    return true
  }

  // A KESZ PDF bajtjai. Kulon vegpont, mert ez a fajl NEM a Raktarban all --
  // barmikor eldobhato, ujra eloallithato szarmaztatott adat.
  if (segs.length === 2 && segs[1] === 'converted' && method === 'GET') {
    const p = buildPreview(item.id, url.searchParams.get('version'))
    if (p.kind !== 'office' || !p.rel) return fail(res, 400, 'convert_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const pdf = cachedPdfFor(abs)
    if (!pdf) return fail(res, 409, 'convert_not_ready', lang)
    let size = 0
    try { size = statSync(pdf).size } catch {
      // A gyorsitotar-fajl a ket lepes kozott eltunhetett (takaritas). Ez nem
      // 500: ugyanaz a teendo, mint ha meg nem lett volna kesz.
      return fail(res, 409, 'convert_not_ready', lang)
    }
    const name = String(p.name || 'dokumentum').replace(/\.[^.]+$/, '') + '.pdf'
    const download = url.searchParams.get('download') === '1'
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      // Szarmaztatott, de szemelyes tartalom: a bongeszo ne tarolja el.
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    createReadStream(pdf).pipe(res)
    return true
  }

  // Archivalt projekt = CSAK OLVASHATO. Az olvasas (GET) marad, minden iras
  // ugyanazt az EMBERI mondatot kapja -- a felulet el is rejti a gombokat, de a
  // szabalyt a szerver tartja be, nem a kepernyo.
  if (method !== 'GET') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
  }

  // DOKUMENTUM FELTOLTESE (7. fazis, spec 8: "letoltes / modositas /
  // ujrafeltoltes; verziozas"). Ez zarja be a kort: a felhasznalo letolti a
  // .docx-et, megszerkeszti a sajat gepen, visszatolti -- es UJ VERZIO lesz
  // belole. A regi SOHA nem irodik felul: sem a verzio (uj sor keletkezik),
  // sem a fajl (a `writeProjectFile` atnevez, ha a nev foglalt).
  if (segs.length === 2 && segs[1] === 'document' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'document_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'document_too_large', lang)
      throw e
    }
    if (!data.length) return fail(res, 400, 'empty_file', lang)
    const out = writeProjectFile(project, url.searchParams.get('sub'), url.searchParams.get('name'), data)
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang)
    const r = createWorkItemVersion(item.id, {
      source_path: out.rel,
      prompt: url.searchParams.get('prompt'),
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, {
      ok: true, item: r.item, version: r.version,
      versions: listWorkItemVersionsView(item.id),
      file: out,
      // Ha a nev foglalt volt, a felulet MONDJA MEG, mi lett a fajl neve --
      // ne csak csendben mas neven alljon ott.
      renamed: out.renamed, name: out.name,
    }, 201)
    return true
  }


  // ============================================================================
  // GRAFIKA / RAJZVASZON (9. fazis, spec 9)
  //
  //   GET  .../canvas       -- a vaszon adata (meg nincs rajz => URES vaszon,
  //                            ami NEM hiba: ez a kezdoallapot)
  //   PUT  .../canvas       -- a teljes vaszon mentese  -> UJ VERZIO
  //   POST .../canvas/ops   -- STRUKTURALT modositas    -> UJ VERZIO
  //   GET  .../canvas.svg   -- a vaszon KEPE (elonezet es letoltes)
  //
  // A strukturalt muveleteket ugyanaz a modul vegzi, amit az agent toolja hiv
  // (`applyCanvasOps`), tehat a "tedd a cimet 30%-kal nagyobbra es kozepre"
  // pontosan ugyanazt csinalja gombbal es agenssel.
  // ============================================================================
  if (segs.length === 2 && segs[1] === 'canvas' && method === 'GET') {
    const r = readCanvas(item.id, url.searchParams.get('version'))
    if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 409, r.code, lang, r.detail)
    json(res, {
      canvas: r.doc,
      // A KET NULLA KULON: "meg nincs rajz" (exists=false) sosem keveredik
      // ossze azzal, hogy "nem tudtam megnezni" (az fentebb hiba).
      exists: r.exists,
      rel: r.rel, name: r.name,
      version_id: r.version_id, version_no: r.version_no,
      limits: { max_objects: CANVAS_MAX_OBJECTS, text_max: CANVAS_TEXT_MAX, max_size: CANVAS_MAX_SIZE },
      summary: canvasSummary(r.doc),
    })
    return true
  }

  if (segs.length === 2 && segs[1] === 'canvas.svg' && method === 'GET') {
    const r = readCanvas(item.id, url.searchParams.get('version'))
    if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 409, r.code, lang, r.detail)
    const svg = renderCanvasForItem(item, r.doc)
    const name = (r.name || canvasFileName(item.title)).replace(/\.canvas\.json$/i, '') + '.svg'
    const download = url.searchParams.get('download') === '1'
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(svg, 'utf-8')),
      // Szemelyes tartalom: a bongeszo ne tarolja el. A kep a vaszonnal egyutt
      // valtozik, egy elavult kep pont a most elvegzett modositast rejtene el.
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    res.end(svg)
    return true
  }

  if (segs.length === 2 && segs[1] === 'canvas' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const parsed = parseCanvas('canvas' in body ? body['canvas'] : body)
    if (!parsed.ok) return failDetail(res, 400, parsed.code, lang, parsed.detail)
    const saved = saveCanvas(item, parsed.doc, {
      prompt: body['prompt'], createdBy: actor(ctx), sub: body['sub'], name: body['name'],
    })
    if (!saved.ok) return failDetail(res, saved.code === 'project_not_found' ? 404 : 400, saved.code, lang, saved.detail)
    json(res, {
      ok: true, canvas: parsed.doc, item: saved.item, version: saved.version,
      versions: listWorkItemVersionsView(item.id),
      rel: saved.rel, name: saved.name, renamed: saved.renamed,
      message: msg('canvas_saved', lang),
    }, 201)
    return true
  }

  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'ops' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const current = readCanvas(item.id, body['version'])
    if (!current.ok) return failDetail(res, current.code === 'not_found' ? 404 : 409, current.code, lang, current.detail)
    const applied = applyCanvasOps(current.doc, body['ops'])
    if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
    const saved = saveCanvas(item, applied.doc, {
      prompt: body['prompt'], createdBy: actor(ctx), sub: body['sub'], name: current.name,
    })
    if (!saved.ok) return failDetail(res, saved.code === 'project_not_found' ? 404 : 400, saved.code, lang, saved.detail)
    json(res, {
      ok: true, canvas: applied.doc, applied: applied.applied,
      item: saved.item, version: saved.version, versions: listWorkItemVersionsView(item.id),
      rel: saved.rel, name: saved.name, renamed: saved.renamed,
      message: msg('canvas_saved', lang),
    }, 201)
    return true
  }

  // SZOVEGFAJL KOZVETLEN SZERKESZTESE (#406, 4. pont): az uj tartalom UJ
  // fajlba kerul a projekt mappajaban, es UJ verzio mutat ra -- a regi fajl es
  // a regi verzio erintetlen. Csak akkor, ha a munkadarab MOSTANI forrasa
  // szovegfajl, es az egeszet latjuk (levagott elonezetet nem irunk vissza:
  // az a fajl vegenek elvesztese lenne).
  if (segs.length === 2 && segs[1] === 'text' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (typeof body['text'] !== 'string') return fail(res, 400, 'text_required', lang)
    const p = buildPreview(item.id)
    if (!p.available || p.kind !== 'text' || !p.rel) return fail(res, 400, 'text_source_unsupported', lang)
    if (p.truncated) return fail(res, 400, 'text_source_truncated', lang)
    const r = saveTextSourceAsNewVersion(item, project, p.rel, body['text'] as string, { created_by: actor(ctx), prompt: body['prompt'] })
    if (!r.ok) {
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      return failDetail(res, r.code === 'write_failed' ? 500 : 400, code, lang, r.detail || null)
    }
    json(res, {
      ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id),
      file: r.file, renamed: r.file.renamed, name: r.file.name,
    }, 201)
    return true
  }

  if (segs[1] !== 'parts') return false

  // MINDEN MENTES UJ VERZIO (#406, 4. pont): a felulet `?new_version=1`-gyel
  // kuldi a resz-muveleteket, es akkor a valtoztatas egy UJ verzioba kerul (a
  // regi valtozatlan marad). A parameter nelkuli hivas a regi, helyben iro
  // viselkedes -- az agens eszkozei es a regebbi hivok ezt varjak.
  const versioned = url.searchParams.get('new_version') === '1'
  const withVersion = <R extends { ok: boolean }>(kind: string, pid: string | null, fn: (mapped: string | null) => R) =>
    editAsNewVersion(item.id, { created_by: actor(ctx), kind }, pid, fn)
  const versionExtras = (r: { ok: true; version: unknown; item: unknown }) => ({
    version: r.version, item: r.item, versions: listWorkItemVersionsView(item.id),
  })

  // Uj resz: szoveg-blokk, vagy egy MAR meglevo kep utja a Raktarban.
  if (segs.length === 2 && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const add = () => addWorkItemPart({
      work_item_id: item.id,
      kind: body.kind,
      text: body.text,
      asset_path: body.asset_path,
      mime_type: body.mime_type,
      size: body.size,
      caption: body.caption,
      created_by: actor(ctx),
    })
    if (versioned) {
      const v = withVersion('part_add', null, add)
      if (!v.ok) return fail(res, v.code === 'not_found' ? 404 : 400, v.code, lang)
      json(res, { ok: true, part: v.part, parts: listWorkItemParts(item.id), ...versionExtras(v) }, 201)
      return true
    }
    const r = add()
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id) }, 201)
    return true
  }

  // Kep feltoltese a feluletrol: a fajl a PROJEKT mappajaba kerul (ott keresi a
  // felhasznalo, es a mentes is viszi), a munkadarab csak az utjat orzi.
  if (segs.length === 3 && segs[2] === 'image' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'too_large', lang)
      throw e
    }
    if (!data.length) return fail(res, 400, 'empty_file', lang)
    const out = writeProjectFile(project, url.searchParams.get('sub'), url.searchParams.get('name'), data)
    // A hibakodot a FAJLRENDSZER mondja meg (nincs Raktar / nincs mappa / nem
    // erem el / git-tarolo) -- nem talalgatjuk, mindegyiknek sajat mondata van.
    if (!out.ok) return fail(res, out.code === 'write_failed' ? 500 : 400, out.code, lang)
    const addImage = () => addWorkItemPart({
      work_item_id: item.id,
      kind: 'image',
      asset_path: out.rel,
      mime_type: url.searchParams.get('type') || null,
      size: out.bytes,
      caption: url.searchParams.get('caption'),
      created_by: actor(ctx),
    })
    if (versioned) {
      const v = withVersion('part_add_image', null, addImage)
      if (!v.ok) return fail(res, v.code === 'not_found' ? 404 : 400, v.code, lang)
      json(res, { ok: true, part: v.part, parts: listWorkItemParts(item.id), file: out, ...versionExtras(v) }, 201)
      return true
    }
    const r = addImage()
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id), file: out }, 201)
    return true
  }

  const partId = segs[2] || ''

  if (segs.length === 3 && (method === 'PATCH' || method === 'PUT')) {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (versioned) {
      const v = withVersion('part_update', partId, (mapped) => updateWorkItemPart(mapped || '', { text: body.text, caption: body.caption }, item.id))
      if (!v.ok) return fail(res, v.code === 'part_not_found' || v.code === 'not_found' ? 404 : 400, v.code, lang)
      json(res, { ok: true, part: v.part, parts: listWorkItemParts(item.id), ...versionExtras(v) })
      return true
    }
    const r = updateWorkItemPart(partId, { text: body.text, caption: body.caption }, item.id)
    if (!r.ok) return fail(res, r.code === 'part_not_found' ? 404 : 400, r.code, lang)
    json(res, { ok: true, part: r.part, parts: listWorkItemParts(item.id) })
    return true
  }

  if (segs.length === 3 && method === 'DELETE') {
    if (versioned) {
      const v = withVersion('part_remove', partId, (mapped) => removeWorkItemPart(mapped || '', item.id))
      if (!v.ok) return fail(res, 404, v.code, lang)
      json(res, { ok: true, removed: v.part, parts: listWorkItemParts(item.id), ...versionExtras(v) })
      return true
    }
    const r = removeWorkItemPart(partId, item.id)
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, removed: r.part, parts: listWorkItemParts(item.id) })
    return true
  }

  if (segs.length === 4 && segs[3] === 'move' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const dir = String(body.dir ?? '')
    if (dir !== 'up' && dir !== 'down') return fail(res, 400, 'bad_move', lang)
    if (versioned) {
      const v = withVersion('part_move', partId, (mapped) => moveWorkItemPart(mapped || '', dir, item.id))
      if (!v.ok) return fail(res, 404, v.code, lang)
      json(res, { ok: true, parts: v.parts, ...versionExtras(v) })
      return true
    }
    const r = moveWorkItemPart(partId, dir, item.id)
    if (!r.ok) return fail(res, 404, r.code, lang)
    json(res, { ok: true, parts: r.parts })
    return true
  }

  return false
}

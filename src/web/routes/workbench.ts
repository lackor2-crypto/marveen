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
import { createHash } from 'node:crypto'
import { fileManagerKind, openInFileManager } from '../../open-in-file-manager.js'
import { json, readBody, RequestBodyTooLargeError } from '../http-helpers.js'
import { APP_LANG, DASHBOARD_PUBLIC_URL, MAIN_AGENT_ID } from '../../config.js'
import { executeTool } from '../../workbench-agent/execute.js'
import { getTool, decideTool } from '../../workbench-agent/tools.js'
import { auditWorkbench } from '../../workbench-agent/audit.js'
import { requestShare, revokeShare, listProjectShares, settleShareApprovals, getShare } from '../../workbench-share.js'
import { getProject } from '../../projects.js'
import {
  ensureWorkbenchTables, createWorkItem, getWorkItem, getWorkItemVersion, listWorkItems, setWorkItemPinned, listDeletedWorkItems, setWorkItemDeleted, purgeWorkItem,
  listWorkItemParts, addWorkItemPart, updateWorkItemPart, moveWorkItemPart, removeWorkItemPart,
  createWorkItemVersion, setWorkItemVersionMeta, restoreWorkItemVersion, deleteWorkItemVersion, listWorkItemVersionsView,
  WORK_ITEM_TYPES, WORK_ITEM_STATUSES, WORK_ITEM_PART_KINDS, TITLE_MAX, PART_TEXT_MAX, PART_CAPTION_MAX,
} from '../../workbench.js'
import { writeProjectFile, writeProjectNote, projectFileTarget, freeFileName, PROJECT_UPLOAD_MAX_BYTES } from '../../project-files.js'
import {
  hasDocModel, documentOutline, documentCheck, addSection, updateSection, removeSection, addBlock, updateBlock, removeBlock,
  confirmOwnerClaim, recheckPendingSources, acceptRewrite, dismissRewrite,
} from '../../workbench-docmodel.js'
import { resolveProjectFile, sourceWorldFor } from '../../workbench-docmodel-world.js'
import { egressLog, itemAiCost, recordImageAiCall, privacyState, projectSensitive, sensitiveItemIds, setItemSensitive, setProjectSensitive } from '../../workbench-privacy.js'
import { createVariant, variantInfo, variantsSummary, listGlossary, addGlossaryTerm, removeGlossaryTerm, backchecks, removeBackTranslation } from '../../workbench-doclang.js'
import { scheduleOutlineMirror } from '../../workbench-docmirror.js'
import { tombstoneSnapshot, restoreFromFolders, sweepSnapshots, snapshotStatus } from '../../workbench-snapshot.js'
import { docxFileName, draftFileName, documentTrail, finalizationState, finalizeDocument, listFinals, recheckFinal, recordReview, renderDocx, renderDraft, resolverFor } from '../../workbench-docfinal.js'
import { acceptProposal, itemCourtState, markProfileChecked, rejectProposal, setItemProfile, setMaxAgeDays } from '../../workbench-courtprofile.js'
import { addAnnex, docSettings, listAnnexes, removeAnnex, setAnnexPath, setDocSettings, updateAnnex, ANNEX_SCHEMES, ANNEX_MODES } from '../../workbench-docannex.js'
import { consistencyIssues, ackConsistencyIssue, unackConsistencyIssue } from '../../workbench-doccheck.js'
import { itemDeadlines, proposeDue, deadlineToTodo, dismissDeadline } from '../../workbench-deadlines.js'
import { documentOverview, documentPagesText, verifyQuote, makeSearchableCopy, searchableName, searchableCopyAvailable } from '../../workbench-docread.js'
import { scanForRedaction, makeRedactedCopy, redactedName } from '../../workbench-redact.js'
import { realpathSync } from 'node:fs'
import { dirname as dirnamePath, join as joinPath, sep as pathSep } from 'node:path'
import { buildPreview } from '../../workbench-preview.js'
import { buildWorkbenchOverview, listBoardWorkItems } from '../../workbench-overview.js'
import { workItemTypeForFile, titleFromFileName } from '../../workbench-upload.js'
import { editAsNewVersion, saveTextSourceAsNewVersion, saveBytesAsNewVersion, TEXT_SOURCE_MAX } from '../../workbench-edit.js'
import { docEditExt, docToEditableHtml, htmlToDocBytes, htmlToExportBytes, DOC_EXPORT_FORMATS, pdfToDocxBytes, looksLikePdf, DOC_EDIT_HTML_MAX } from '../../workbench-docedit.js'
import { saveEditedImage } from '../../workbench-image-edit.js'
import { savePostFile, listPostFiles, POST_FILE_MAX_BYTES } from '../../workbench-post-files.js'
import { videoToolStatus, trimVideo, saveVideoFrame } from '../../workbench-video.js'
import { timelineStore, applyTimelineOps, timelineSummary, timelineDuration, clipOffsets, TIMELINE_MAX_CLIPS, TIMELINE_MAX_SUBTITLES, TIMELINE_MAX_OVERLAYS, TIMELINE_TEXT_MAX, TIMELINE_MIN_CLIP, TIMELINE_ASPECTS } from '../../workbench-video-timeline.js'
import { renderTimeline, lastRenderOf, fillClipEnds, listProjectMedia } from '../../workbench-video-render.js'
import { deckStore, applyDeckOps, deckSummary, DECK_MAX_SLIDES, DECK_NOTES_MAX, DECK_SIZES, DECK_LAYOUTS } from '../../workbench-deck.js'
import { exportDeck, DECK_EXPORT_FORMATS, type DeckExportFormat } from '../../workbench-deck-export.js'
import { recogniseTimeline, applySubtitleLines, AUTOSUB_LANGS, type AutoSubLang } from '../../workbench-video-autosub.js'
import { opsLabel } from '../../workbench-draft-store.js'
import { loadTableSource, readTable, writeTable, normalizeSheets, blankXlsx, TABLE_MAX_ROWS, TABLE_MAX_COLS, TABLE_MAX_CELLS } from '../../workbench-table.js'
import { buildProjectTimeline, clampTimelineLimit } from '../../workbench-timeline.js'
import { searchProject } from '../../workbench-search.js'
import { ensureLastWeekSummary, listWeeklySummaries, currentWeekSummary } from '../../workbench-weekly.js'
import { addTodo, updateTodo, deleteTodo, getTodo, listItemTodos, listProjectTodos, todosToIcs, TODO_TEXT_MAX } from '../../workbench-todos.js'
import { getReminderStatus, setReminderSettings } from '../../workbench-todo-reminder.js'
import { gcalStatus, requestTodoCalendar, settleTodoCalendarApprovals } from '../../workbench-todo-gcal.js'
import { sendOwnerChannelChecked } from '../../notify.js'
import { getBrand, saveBrand, checkCanvasBrand, emptyBrand, brandIsEmpty, BrandUnreadableError, BRAND_FONTS, LOGO_CORNERS, BRAND_MAX_COLORS, BRAND_MAX_NOTES, BRAND_NOTE_MAX_CHARS, listBrandTemplates, deleteBrandTemplate, BRAND_MAX_TEMPLATES, BRAND_TEMPLATE_NAME_MAX } from '../../workbench-brand.js'
import { brandTemplateFromItem, createFromBrandTemplate } from '../../workbench-brand-templates.js'
import { listDecisions, addDecision, updateDecision, setDecisionRevoked, getDecision, DECISION_MAX_CHARS, DECISIONS_MAX_ACTIVE } from '../../workbench-decisions.js'
import { listTemplates, createFromTemplate } from '../../workbench-templates.js'
import { contentDispositionHeader } from './drive-browser.js'
import { planHandoff, buildHandoffZip, isHandoffScope, HANDOFF_MAX_BYTES } from '../../workbench-handoff.js'
import { submitWorkItemForApproval, withdrawWorkItemApproval, decideWorkItemApproval, workItemApprovalState } from '../../workbench-approval.js'
import { buildExportPage, requestSendApproval, sendNow, SEND_SUBJECT_MAX, SEND_MESSAGE_MAX } from '../../workbench-export.js'
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
import { listCanvasPlatforms, canvasPlatform, platformForSize } from '../../workbench-canvas-platforms.js'
import { imageAiConfig, estimateImageEdit, editImageWithAI } from '../../workbench-image-ai.js'
import { INTAKE_KINDS, INTAKE_TYPE, guessIntakeKind, intakeTitle, type IntakeKind, type IntakeKindAny } from '../../workbench-intake.js'
import {
  readCanvas, renderCanvasForItem, commitCanvasChange, readCanvasImageFile, canvasOpsLabel, canvasHistory, canvasOrphans,
  undoCanvas, redoCanvas, saveCanvasVersion, flushCanvasDraft, restoreCanvasOrphan, discardCanvasOrphan,
} from '../../workbench-canvas-store.js'
import { setOverride, getEffectiveSettingValue } from '../../settings-store.js'
import { getSettingDefinition } from '../../config-registry.js'
import { resolveLifePath } from '../../life-explorer.js'
import { createReadStream, statSync, rmdirSync } from 'node:fs'
import { logger } from '../../logger.js'
import { getSecret } from '../vault.js'
import { translateEmailContent, resolveTargetLang, SUPPORTED_TRANSLATION_LANGS, TRANSLATION_FAILED_MARKER } from '../email-translate.js'
import {
  makeFreshFolder, ensureWorkItemFolder, assignWorkItemFolder, registerAsset, sha256Of, attachAsset,
  listSharedFiles, uploadSharedFile, linkSharedAsset, withDocState, startPendingDocReads,
  unlinkAsset, deleteAssetFile, workbenchPlace, tidyWorkItemIntoFolder, ensureAssetTables, listWorkItemAssetsSynced, renameWorkItem,
  workFolderTarget, listWorkFolders, makeWorkFolder, migrateSubItemsToFolders, moveWorkItemToFolder,
  deleteWorkFolder,
  renameWorkFolder, adoptExistingFolder,
} from '../../workbench-assets.js'
import type { RouteContext } from './types.js'

function uiLang(url: URL): 'hu' | 'en' {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const MESSAGES: Record<string, { hu: string; en: string }> = {
  translate_no_key: {
    hu: 'A fordításhoz egy OpenRouter-kulcs kell, és még nincs beállítva. Állítsd be a bal oldali menü OpenRouter oldalán (a beérkező levelek fordítása is ezt a kulcsot használja).',
    en: 'Translating needs an OpenRouter key, and none is set yet. Set it on the OpenRouter page in the left menu (translating incoming emails uses the same key).',
  },
  translate_failed: {
    hu: 'A fordítás nem sikerült. Próbáld újra egy perc múlva.',
    en: 'The translation did not work. Try again in a minute.',
  },
  translate_empty: {
    hu: 'Nincs mit fordítani: a szöveg üres.',
    en: 'There is nothing to translate: the text is empty.',
  },
  translate_too_long: {
    hu: 'Ez a szöveg túl hosszú egy lépésben fordításhoz (legfeljebb 30 000 karakter). Fordítsd részletekben.',
    en: 'This text is too long to translate in one go (at most 30,000 characters). Translate it in parts.',
  },
  project_required: {
    hu: 'Nincs megadva, melyik projekt Munkapadját nyitod meg.',
    en: 'It is not given which project\'s Workbench you are opening.',
  },
  version_not_found: {
    hu: 'Ez a verzió nincs meg. Lehet, hogy közben törölted a munkadarabot, vagy egy régi lapot néztél -- frissítsd az oldalt.',
    en: 'That version does not exist. The work item may have been deleted, or you are looking at a stale page -- reload it.',
  },
  version_last: {
    hu: 'Ez a munkadarab egyetlen verziója, ezt nem lehet törölni, mert nem maradna mit betölteni. Ha az egész munkadarabot el akarod tüntetni, töröld a listából (a Lomtárba kerül).',
    en: 'This is the only version of the work item, so it cannot be deleted -- nothing would be left to load. To remove the whole work item, delete it from the list (it goes to the Trash).',
  },
  not_in_trash: {
    hu: 'Véglegesen csak a Lomtárban lévő munkadarabot lehet törölni. Előbb tedd a Lomtárba.',
    en: 'Only a work item in the Trash can be deleted permanently. Move it to the Trash first.',
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
  handoff_bad_scope: {
    hu: 'Válaszd ki, mi kerüljön a csomagba: csak a kész munkadarabok, vagy mind.',
    en: 'Choose what goes into the package: only the finished work items, or all of them.',
  },
  handoff_no_items: {
    hu: 'Ebben a projektben még nincs munkadarab, így nincs mit csomagba tenni. Előbb hozz létre egyet.',
    en: 'This project has no work items yet, so there is nothing to package. Create one first.',
  },
  handoff_nothing_done: {
    hu: 'Még egyik munkadarab sincs „Kész” állapotban. Állítsd késznek, amit átadnál, vagy válaszd a „Mind” lehetőséget.',
    en: 'No work item is marked "Done" yet. Mark what you want to hand over as done, or choose "All".',
  },
  handoff_too_large: {
    hu: 'A csomag túl nagy lenne (200 MB fölött). Válaszd a „csak a kész” lehetőséget, vagy vedd ki a nagy fájlokat (például a videókat).',
    en: 'The package would be too large (over 200 MB). Choose "only finished", or leave out the large files (for example videos).',
  },
  todo_text_required: {
    hu: 'Írd be, mi a teendő (például: „szöveget átnézni”).',
    en: 'Type what needs doing (for example: "review the text").',
  },
  todo_text_too_long: {
    hu: 'A teendő legfeljebb 300 karakter lehet. Ha hosszabb, bontsd kisebb lépésekre.',
    en: 'A to-do can be at most 300 characters. If it is longer, split it into smaller steps.',
  },
  todo_bad_due_date: {
    hu: 'A határidő nem érvényes nap. Válassz egy napot a naptárból, vagy hagyd üresen.',
    en: 'The due date is not a valid day. Pick a day from the calendar, or leave it empty.',
  },
  todo_too_many: {
    hu: 'Ezen a munkadarabon már 100 nyitott teendő van. Pipáld ki vagy töröld a régieket, mielőtt újat veszel fel.',
    en: 'This work item already has 100 open to-dos. Tick off or remove old ones before adding a new one.',
  },
  todo_bad_repeat: {
    hu: 'Az ismétlődés csak „nem ismétlődik”, „hetente” vagy „havonta” lehet.',
    en: 'Repeat can only be "does not repeat", "weekly" or "monthly".',
  },
  todo_repeat_needs_due: {
    hu: 'Az ismétlődéshez adj meg egy határidőt: abból tudja a Marveen, melyik napon jön a következő.',
    en: 'To repeat, set a due date: that is how Marveen knows which day the next one comes.',
  },
  todo_not_found: {
    hu: 'Ez a teendő nem található (lehet, hogy közben törölték). Frissítsd az oldalt.',
    en: 'This to-do was not found (it may have been removed meanwhile). Reload the page.',
  },
  todo_item_not_found: {
    hu: 'A munkadarab nem található (lehet, hogy közben törölték). Frissítsd az oldalt.',
    en: 'The work item was not found (it may have been removed meanwhile). Reload the page.',
  },
  todo_no_due: {
    hu: 'Ennek a teendőnek nincs határideje, így a naptárba sincs mit betenni. Adj meg előbb egy napot.',
    en: 'This to-do has no due date, so there is nothing to put in the calendar. Set a day first.',
  },
  todo_reminder_bad_time: {
    hu: 'Az időpont nem érvényes. Válassz egy időt, például 18:00.',
    en: 'The time is not valid. Pick a time, for example 18:00.',
  },
  todo_reminder_bad_days_before: {
    hu: 'Válassz a listából: aznap, 1, 2 vagy 3 nappal, vagy egy héttel előtte.',
    en: 'Pick from the list: on the day, 1, 2 or 3 days, or one week before.',
  },
  todo_reminder_no_channel: {
    hu: 'Nincs bekötött csatorna (például Telegram), ahova az emlékeztető kimehetne. Bekötni az Ügynökök oldalon lehet: nyisd meg a fő ügynököt, ott a „Telegram bot bekötése” rész.',
    en: 'No channel (for example Telegram) is connected for the reminder to go to. You can connect one on the Agents page: open the main agent, see the "Connect Telegram bot" part.',
  },
  todo_reminder_send_failed: {
    hu: 'A próba-üzenet nem ment ki. A csatorna ezt válaszolta:',
    en: 'The test message did not go out. The channel replied:',
  },
  todo_gcal_no_account: {
    hu: 'Még nincs bekötve Google-fiók, így a Google Naptárba sincs hova írni. Bekötni a Beállítások → Varázsló „Google-fiókok” lépésében lehet. Addig a „Naptárba (.ics)” letöltés bármely naptárral működik.',
    en: 'No Google account is connected yet, so there is no Google Calendar to write to. Connect one in Settings → Wizard, "Google accounts" step. Until then the "To calendar (.ics)" download works with any calendar.',
  },
  todo_gcal_no_scope: {
    hu: 'A bekötött Google-fiók nem adott engedélyt a naptár írására. Csatlakoztasd újra a Beállítások → Varázsló „Google-fiókok” lépésében, és a Google ablakában engedélyezd a Naptárat is.',
    en: 'The connected Google account did not grant permission to write the calendar. Reconnect it in Settings → Wizard, "Google accounts" step, and allow Calendar in the Google window.',
  },
  todo_gcal_check_failed: {
    hu: 'Nem tudtam megnézni, milyen Google-fiók van bekötve (a fiókok listája nem olvasható). Nézd meg a Beállítások → Varázsló „Google-fiókok” lépését.',
    en: 'I could not check which Google account is connected (the account list cannot be read). Look at Settings → Wizard, "Google accounts" step.',
  },
  todo_gcal_blocked: {
    hu: 'A Google Naptárba írás most tiltva van (Beállítások → Autonómia: „Munkapad: teendő beírása a Google Naptárba” 1-es szinten). Állítsd 2-re (jóváhagyással) vagy 3-ra.',
    en: 'Writing to Google Calendar is switched off (Settings → Autonomy: "Workbench: to-do into Google Calendar" is at level 1). Set it to 2 (with approval) or 3.',
  },
  todo_gcal_failed: {
    hu: 'A Google Naptár nem fogadta el az eseményt. A Google ezt válaszolta:',
    en: 'Google Calendar did not accept the event. Google replied:',
  },
  share_bad_kind: {
    hu: 'Nem derül ki, mire szóljon a link: egy munkadarabra vagy az átadási csomagra.',
    en: 'It is not clear what the link should show: one work item or the handoff package.',
  },
  share_bad_days: {
    hu: 'A link 1, 7 vagy 30 napig lehet érvényes. Válassz ezek közül.',
    en: 'The link can be valid for 1, 7 or 30 days. Pick one of these.',
  },
  share_bad_scope: {
    hu: 'Az átadási csomag a kész munkadarabokból vagy mindegyikből állhat. Válassz ezek közül.',
    en: 'The handoff package can hold the finished work items or all of them. Pick one of these.',
  },
  share_item_not_found: {
    hu: 'Ez a munkadarab már nincs meg, így linket sem lehet adni hozzá. Frissítsd az oldalt.',
    en: 'This work item no longer exists, so no link can be made for it. Refresh the page.',
  },
  share_project_not_found: {
    hu: 'Ez a projekt már nincs meg. Frissítsd az oldalt.',
    en: 'This project no longer exists. Refresh the page.',
  },
  share_blocked: {
    hu: 'Linket kiadni most tiltva van (Beállítások → Autonómia: a „Jogosultság-változtatás / megosztás” 1-es szinten). Állítsd 2-re (jóváhagyással) vagy 3-ra.',
    en: 'Issuing links is switched off (Settings → Autonomy: "Permission change / sharing" is at level 1). Set it to 2 (with approval) or 3.',
  },
  share_not_found: {
    hu: 'Ez a link már nincs meg. Frissítsd az oldalt.',
    en: 'This link no longer exists. Refresh the page.',
  },
  todo_none_due: {
    hu: 'Ebben a projektben nincs nyitott, határidős teendő, így a naptárba sincs mit betenni.',
    en: 'This project has no open to-dos with a due date, so there is nothing to put in the calendar.',
  },
  brand_bad_color: {
    hu: 'Ez nem szín. Színt így adj meg: #1a73e8 (kettőskereszt és hat jegy), vagy válaszd ki a színválasztóval.',
    en: 'That is not a colour. Give a colour like #1a73e8 (a hash and six digits), or pick it with the colour picker.',
  },
  brand_too_many_colors: {
    hu: 'Legfeljebb 12 márkaszín lehet. Egy márka általában 3-5 színből áll, hagyd ki a ritkán használtakat.',
    en: 'A brand can have at most 12 colours. A brand usually has 3-5, leave out the ones rarely used.',
  },
  brand_bad_logo: {
    hu: 'A logó egy kép legyen (png, jpg, svg, gif vagy webp) a projekt közös anyagai közül. Válaszd ki a listából.',
    en: 'The logo has to be a picture (png, jpg, svg, gif or webp) from the project\'s shared materials. Pick it from the list.',
  },
  brand_bad_font: {
    hu: 'Ez a betűtípus nincs a választékban. Válassz a listából: serif (talpas), sans (talp nélküli) vagy mono (fix szélességű).',
    en: 'That font is not available. Pick one from the list: sans, serif or mono.',
  },
  brand_bad_corner: {
    hu: 'A logó helye csak a négy sarok egyike lehet. Válassz a listából.',
    en: 'The logo position can only be one of the four corners. Pick it from the list.',
  },
  brand_bad_min_width: {
    hu: 'A logó legkisebb szélessége 1 és 80 közötti százalék legyen (például 10).',
    en: 'The smallest logo width must be a percentage between 1 and 80 (for example 10).',
  },
  brand_bad_clear_space: {
    hu: 'A logó körüli szabad terület 1 és 100 közötti százalék legyen a logó szélességéből (például 25).',
    en: 'The clear space around the logo must be a percentage between 1 and 100 of the logo width (for example 25).',
  },
  brand_too_many_notes: {
    hu: 'Legfeljebb 20 stílusszabályt lehet felírni. Vond össze a hasonlókat.',
    en: 'At most 20 style rules can be written down. Merge similar ones.',
  },
  brand_note_too_long: {
    hu: 'Egy stílusszabály legfeljebb 300 karakter lehet. Írd rövidebben, egy mondatban.',
    en: 'A style rule can be at most 300 characters. Keep it to one sentence.',
  },
  brand_bad_input: {
    hu: 'A márka adatai nem érthetők. Töltsd újra az oldalt, és próbáld újra.',
    en: 'The brand data could not be understood. Reload the page and try again.',
  },
  brand_read_failed: {
    hu: 'A márka adatai most nem olvashatók. Ez NEM azt jelenti, hogy nincs márka: próbáld újra később.',
    en: 'The brand data cannot be read right now. This does NOT mean there is no brand: try again later.',
  },
  brand_unreadable: {
    hu: 'A korábban elmentett márka adatai nem olvashatók, ezért most nincs mihez hasonlítani. Ez NEM azt jelenti, hogy nincs márka. Nyisd meg a „Márka” panelt, állítsd be újra, és mentsd el.',
    en: 'The brand saved earlier cannot be read, so there is nothing to compare with right now. This does NOT mean there is no brand. Open the "Brand" panel, set it again and save it.',
  },
  brand_item_not_found: {
    hu: 'Ez a munkadarab nem található, ezért nincs mit ellenőrizni.',
    en: 'This work item was not found, so there is nothing to check.',
  },
  brand_template_item_not_found: {
    hu: 'Ez a munkadarab nem található, ezért nem lehet sablonként elmenteni. Frissítsd az oldalt, és nyisd meg újra a grafikát.',
    en: 'This work item was not found, so it cannot be saved as a template. Reload the page and open the drawing again.',
  },
  brand_template_no_canvas: {
    hu: 'Ezen a munkadarabon még nincs rajz, ezért nincs mit sablonként elmenteni. Előbb készítsd el a grafikát, utána mentsd el márka-sablonként.',
    en: 'This work item has no drawing yet, so there is nothing to save as a template. Make the drawing first, then save it as a brand template.',
  },
  brand_template_name_required: {
    hu: 'Adj nevet a sablonnak (például: Instagram poszt), ebből fogod megismerni a listában.',
    en: 'Give the template a name (for example: Instagram post); this is how you will recognise it in the list.',
  },
  brand_template_name_too_long: {
    hu: 'A sablon neve legfeljebb 80 karakter lehet. Adj rövidebb nevet.',
    en: 'A template name can be at most 80 characters. Give it a shorter name.',
  },
  brand_template_name_taken: {
    hu: 'Ilyen nevű márka-sablon már van ebben a projektben. Adj másik nevet, vagy írd felül a régit.',
    en: 'This project already has a brand template with this name. Give another name, or replace the old one.',
  },
  brand_too_many_templates: {
    hu: 'Egy projektben legfeljebb 30 márka-sablon lehet. Törölj egy régit a „Márka” panel „Sablonok” részénél, utána mentsd el az újat.',
    en: 'A project can have at most 30 brand templates. Remove an old one in the "Templates" part of the "Brand" panel, then save the new one.',
  },
  brand_template_not_found: {
    hu: 'Ez a márka-sablon már nincs meg (lehet, hogy közben törölték). Nyisd meg újra a „Márka” panelt, és válassz a listából.',
    en: 'This brand template no longer exists (it may have been removed meanwhile). Open the "Brand" panel again and pick one from the list.',
  },
  brand_template_unreadable: {
    hu: 'Ennek a márka-sablonnak a rajza nem olvasható, ezért nem lehet belőle új grafikát indítani. A sablon nem tűnt el: törölheted, és a jó rajzból újra elmentheted.',
    en: 'The drawing of this brand template cannot be read, so no new drawing can be started from it. The template is not gone: you can remove it and save it again from a good drawing.',
  },
  brand_template_failed: {
    hu: 'A sablonból nem sikerült elkészíteni az új grafikát, ezért semmi nem jött létre. Próbáld újra.',
    en: 'The new drawing could not be made from the template, so nothing was created. Please try again.',
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
  trash_bad_value: {
    hu: 'Nem derült ki, hogy törölni vagy visszaállítani kell-e a munkadarabot. Frissítsd az oldalt, és kattints újra.',
    en: 'It was not clear whether to delete or restore this work item. Refresh the page and click again.',
  },
  bad_folder_name: {
    hu: 'Ez a mappanév nem jó: ne legyen benne \\ / : * ? " < > | jel, és ne kezdődjön ponttal.',
    en: 'This folder name will not do: no \\ / : * ? " < > | characters, and it must not start with a dot.',
  },
  folder_required: {
    hu: 'Nem tudom elmenteni: előbb az 1. lépésben válaszd ki (vagy hozd létre) azt a mappát, amelyik alá a munkadarab kerül. Mappát nem hozok létre magamtól.',
    en: 'I cannot save this yet: first, in step 1, choose (or create) the folder the work item goes under. I do not create folders on my own.',
  },
  folder_is_box: {
    hu: 'Ez a munkadarabok közös mappája, ezt nem lehet törölni. Csak a benne lévő mappákat.',
    en: 'This is the shared folder for all work items and cannot be deleted. Only the folders inside it can.',
  },
  folder_box_rename: {
    hu: 'Ez a munkadarabok közös mappája, ezt nem lehet átnevezni. Csak a benne lévő mappákat.',
    en: 'This is the shared folder for all work items and cannot be renamed. Only the folders inside it can.',
  },
  folder_exists: {
    hu: 'Ilyen nevű mappa már van ezen a helyen. Válassz másik nevet.',
    en: 'A folder with this name already exists here. Choose another name.',
  },
  folder_has_items: {
    hu: 'Ebben a mappában több munkadarab anyaga van együtt, ezért nem nevezhető át (az útvonalaik elromlanának). Egy munkadarab saját mappáját viszont átnevezheted: a munkadarab neve vele együtt változik.',
    en: 'This folder holds the material of several work items, so it cannot be renamed (their paths would break). A folder that belongs to a single work item can be renamed, and the work item takes the new name with it.',
  },
  folder_gone: {
    hu: 'A kiválasztott mappa már nincs meg (átnevezték vagy törölték). Válassz újra mappát.',
    en: 'The chosen folder is gone (renamed or deleted). Choose a folder again.',
  },
  pin_bad_value: {
    hu: 'Nem derült ki, hogy kitűzni vagy levenni kell-e a csillagot. Frissítsd az oldalt, és kattints újra a csillagra.',
    en: 'It was not clear whether to pin or unpin this item. Refresh the page and click the star again.',
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
  timeline_not_video: {
    hu: 'Az idővonal csak videó típusú munkadarabon van. Hozz létre egy videó munkadarabot.',
    en: 'The timeline only exists on a video work item. Create a video work item.',
  },
  timeline_bad_shape: {
    hu: 'Az idővonal adatai nem érthetők. Töltsd újra az oldalt, és próbáld újra.',
    en: 'The timeline data could not be understood. Reload the page and try again.',
  },
  timeline_bad_op: {
    hu: 'Ez a művelet nem érthető vagy üres. Próbáld újra.',
    en: 'That operation is not understood or empty. Try again.',
  },
  timeline_not_found: {
    hu: 'Ez az elem nem található az idővonalon (lehet, hogy közben törölték). Töltsd újra az oldalt.',
    en: 'That element is not on the timeline (it may have been removed meanwhile). Reload the page.',
  },
  timeline_too_many: {
    hu: 'Az idővonalon legfeljebb 100 klip, 500 felirat és 50 kép-rátét lehet.',
    en: 'The timeline can hold at most 100 clips, 500 subtitles and 50 picture overlays.',
  },
  timeline_bad_time: {
    hu: 'Az időpontok nem jók: a kezdet és a vég másodperc legyen (például 12,5), és a vég legalább 0,1 másodperccel legyen a kezdet után.',
    en: 'The times are not valid: start and end must be seconds (for example 12.5), and the end at least 0.1 seconds after the start.',
  },
  timeline_bad_media: {
    hu: 'Ez a fájl nem használható itt. Klipnek videót (mp4, mov, webm), zenének hangfájlt (mp3, m4a, wav), rátétnek képet (png, jpg) válassz a projekt mappájából.',
    en: 'This file cannot be used here. Pick a video (mp4, mov, webm) as a clip, an audio file (mp3, m4a, wav) as music, a picture (png, jpg) as an overlay, from the project folder.',
  },
  timeline_text_required: {
    hu: 'Írd be a felirat szövegét.',
    en: 'Type the subtitle text.',
  },
  timeline_text_too_long: {
    hu: 'A felirat túl hosszú (legfeljebb 300 karakter). Bontsd több feliratra.',
    en: 'The subtitle is too long (300 characters at most). Split it into several subtitles.',
  },
  timeline_bad_aspect: {
    hu: 'A kép formátuma csak 16:9 (fekvő), 9:16 (álló, Reels/Story) vagy 1:1 (négyzet) lehet.',
    en: 'The picture format can only be 16:9 (landscape), 9:16 (portrait, Reels/Story) or 1:1 (square).',
  },
  timeline_bad_value: {
    hu: 'Az érték nem jó: a hangerő és az átlátszóság 0 és 1 közötti szám, a rátét helye és szélessége 0 és 1 közötti arány.',
    en: 'The value is not valid: volume and opacity are numbers between 0 and 1, the overlay position and width are shares between 0 and 1.',
  },
  timeline_saved: {
    hu: 'Az idővonal elmentve, új verzióként.',
    en: 'The timeline is saved, as a new version.',
  },
  timeline_autosaved: {
    hu: 'Mentve. Verzió akkor lesz belőle, ha a „Verzió mentése” gombra nyomsz.',
    en: 'Saved. It becomes a version when you press "Save version".',
  },
  timeline_version_saved: {
    hu: 'Verzió mentve. Az idővonalon tovább dolgozhatsz, a visszavonás is megmaradt.',
    en: 'Version saved. You can keep working on the timeline, and undo still works.',
  },
  timeline_version_unchanged: {
    hu: 'Nincs új változás a legutóbbi verzió óta.',
    en: 'There is no new change since the last version.',
  },
  autosub_not_installed: {
    hu: 'A helyi beszédfelismerő nincs telepítve ezen a gépen, ezért nem tudok automatikus feliratot készíteni. A feliratokat addig is beírhatod kézzel. A telepítés a Képességek panelben található (hangüzenet-felismerés).',
    en: 'The local speech recogniser is not installed on this machine, so I cannot make automatic subtitles. You can still type them by hand. The installation is in the Capabilities panel (voice message recognition).',
  },
  autosub_old_toolkit: {
    hu: 'A gépen lévő beszédfelismerő csomag régebbi, és még nem tud időbélyeges felismerést. Futtasd újra a hangcsomag telepítőjét (scripts/install-voice.sh), utána működni fog.',
    en: 'The speech recogniser package on this machine is older and cannot recognise with times yet. Run the voice package installer again (scripts/install-voice.sh); then it will work.',
  },
  autosub_failed: {
    hu: 'A beszédfelismerés nem sikerült. A részletek megmondják, mit írt a program.',
    en: 'The speech recognition did not work. The details say what the program wrote.',
  },
  autosub_timeout: {
    hu: 'A beszédfelismerés túl sokáig tartott, ezért megszakítottam. Rövidebb idővonallal próbáld újra.',
    en: 'The speech recognition took too long, so I stopped it. Try again with a shorter timeline.',
  },
  autosub_too_long: {
    hu: 'Az idővonal túl hosszú az automatikus feliratnak (legfeljebb 30 perc beszéd). Készítsd el részletekben.',
    en: 'The timeline is too long for automatic subtitles (30 minutes at most). Do it in parts.',
  },
  autosub_bad_language: {
    hu: 'Az automatikus felirat nyelve magyar, angol vagy német lehet.',
    en: 'The language of the automatic subtitles can be Hungarian, English or German.',
  },
  autosub_no_speech: {
    hu: 'Nem találtam beszédet a klipekben, ezért nem került fel felirat.',
    en: 'I found no speech in the clips, so no subtitles were added.',
  },
  timeline_autosub_done: {
    hu: 'Kész az automatikus felirat. Nézd át: a beszédfelismerés téved, főleg nevekben és számokban. Szerkesztheted vagy törölheted őket.',
    en: 'The automatic subtitles are ready. Please check them: speech recognition makes mistakes, especially with names and numbers. You can edit or delete them.',
  },
  timeline_rendered: {
    hu: 'Kész a videó. Új fájl lett belőle a projekt mappájában, a régi videók érintetlenek.',
    en: 'The video is ready. It is a new file in the project folder; the old videos are untouched.',
  },
  render_empty: {
    hu: 'Az idővonalon még nincs klip, így nincs mit elkészíteni. Adj hozzá legalább egy videót.',
    en: 'There is no clip on the timeline yet, so there is nothing to make. Add at least one video.',
  },
  render_source_missing: {
    hu: 'Az egyik használt fájl nem található a lemezen. A részletek megmondják, melyik: tedd vissza, vagy vedd ki az idővonalról.',
    en: 'One of the files used cannot be found on disk. The details say which one: put it back or take it off the timeline.',
  },
  render_source_outside: {
    hu: 'Az egyik használt fájl nem a projekt mappájában van, ezért nem használható. A részletek megmondják, melyik.',
    en: 'One of the files used is not in the project folder, so it cannot be used. The details say which one.',
  },
  render_no_subtitle_filter: {
    hu: 'Ez a gép videóprogramja nem tud feliratot a képre írni. Vedd ki a feliratokat, vagy telepíts teljes ffmpeg-et (a Képességek panel megmondja, hogyan). A videó emiatt nem készült el, hogy ne feliratok nélkül kapd meg csendben.',
    en: 'This machine\'s video program cannot burn subtitles into the picture. Remove the subtitles, or install a full ffmpeg (the Capabilities panel says how). The video was not made, so you do not get it silently without subtitles.',
  },
  render_probe_failed: {
    hu: 'Nem tudtam megnézni, van-e hang az egyik videóban (az ffprobe nem válaszolt). A részletek megmondják, melyik fájl.',
    en: 'I could not check whether one of the videos has sound (ffprobe did not answer). The details say which file.',
  },
  video_nothing_to_undo: {
    hu: 'Nincs mit visszavonni: a legutóbbi verzió óta nem történt változás ezen az idővonalon.',
    en: 'There is nothing to undo: this timeline has not changed since the last version.',
  },
  video_nothing_to_redo: {
    hu: 'Nincs mit újra elvégezni: nincs visszavont lépés.',
    en: 'There is nothing to redo: no step has been undone.',
  },
  video_undo_conflict: {
    hu: 'Ezt a lépést nem vonom vissza, mert közben az idővonal más módon is megváltozott. A mostani idővonal érintetlen.',
    en: 'I am not undoing this step, because the timeline has changed in another way since. The timeline is untouched.',
  },
  video_draft_unreadable: {
    hu: 'Az idővonal munkapéldánya sérült az adatbázisban. A verziók érintetlenek: a verziólistából visszaállhatsz egyre.',
    en: 'The working copy of the timeline is damaged in the database. The versions are untouched: you can go back to one from the version list.',
  },
  video_nothing_to_version: {
    hu: 'Még nincs idővonal, így nincs miből verziót menteni. Adj hozzá egy klipet.',
    en: 'There is no timeline yet, so there is nothing to save as a version. Add a clip first.',
  },
  video_orphan_not_found: {
    hu: 'Ez az elhagyott munka már nem található.',
    en: 'That abandoned work is no longer there.',
  },
  video_missing: {
    hu: 'Az idővonal fájlja nem található a lemezen.',
    en: 'The timeline file cannot be found on disk.',
  },
  video_unreachable: {
    hu: 'Az idővonal fájljához nem látok oda (a Raktár vagy a mappa nem elérhető).',
    en: 'I cannot reach the timeline file (the Depot or the folder is not available).',
  },
  video_unreadable: {
    hu: 'Az idővonal fájlját nem tudtam elolvasni.',
    en: 'I could not read the timeline file.',
  },
  video_too_large: {
    hu: 'Az idővonal fájlja túl nagy.',
    en: 'The timeline file is too large.',
  },
  video_no_folder: {
    hu: 'A projektnek nincs mappája, ezért nincs hová menteni az idővonalat.',
    en: 'The project has no folder, so there is nowhere to save the timeline.',
  },
  video_no_depot: {
    hu: 'Nincs beállítva a Raktár ezen a gépen, ezért nincs hová menteni az idővonalat.',
    en: 'The Depot is not set up on this machine, so there is nowhere to save the timeline.',
  },
  render_clip_beyond_end: {
    hu: 'Az egyik vágás a videó vége után ér véget, ezért nem készítettem el, hogy ne kapj csendben rövidebb videót. A részletek megmondják, melyik fájl és milyen hosszú. Állítsd a vágás végét a fájl hosszán belülre.',
    en: 'One cut ends after the end of its video, so I did not make it, rather than silently give you a shorter video. The details say which file and how long it is. Set the end of the cut inside the length of the file.',
  },
  timeline_no_folder: {
    hu: 'A projektnek nincs mappája (vagy nem érem el), ezért nincs miből videót, hangot vagy képet választani. Állíts be mappát a projektnek, és tedd bele a fájlokat.',
    en: 'The project has no folder (or I cannot reach it), so there is nothing to pick videos, audio or pictures from. Set a folder for the project and put the files in it.',
  },
  deck_not_presentation: {
    hu: 'A diasor csak prezentáció típusú munkadarabon van. Hozz létre egy prezentációt.',
    en: 'The slide deck only exists on a presentation work item. Create a presentation.',
  },
  deck_bad_shape: {
    hu: 'A diasor adatát nem tudom értelmezni. Töltsd újra az oldalt, és próbáld újra.',
    en: 'The slide deck data could not be understood. Reload the page and try again.',
  },
  deck_bad_op: {
    hu: 'Ezt a módosítást nem tudom értelmezni. A részletek megmondják, melyik lépéssel van a baj.',
    en: 'I cannot read this change. The details say which step is the problem.',
  },
  deck_slide_not_found: {
    hu: 'Ez a dia nem található (lehet, hogy közben törölték). Töltsd újra az oldalt.',
    en: 'That slide is not there (it may have been removed meanwhile). Reload the page.',
  },
  deck_too_many: {
    hu: 'Egy prezentációban legfeljebb 100 dia lehet.',
    en: 'A presentation can hold at most 100 slides.',
  },
  deck_bad_layout: {
    hu: 'A dia elrendezése csak „cím”, „tartalom” vagy „üres” lehet.',
    en: 'The slide layout can only be "title", "content" or "blank".',
  },
  deck_bad_value: {
    hu: 'Az érték nem jó. A dia helye egy sorszám legyen (1 az első).',
    en: 'The value is not valid. The position of a slide must be a number (1 is the first).',
  },
  deck_bad_size: {
    hu: 'A prezentáció mérete csak 16:9 (szélesvásznú) vagy 4:3 lehet.',
    en: 'The presentation size can only be 16:9 (widescreen) or 4:3.',
  },
  deck_notes_too_long: {
    hu: 'A előadói jegyzet túl hosszú (legfeljebb 4000 karakter).',
    en: 'The speaker notes are too long (4000 characters at most).',
  },
  deck_saved: {
    hu: 'A prezentáció elmentve, új verzióként.',
    en: 'The presentation is saved, as a new version.',
  },
  deck_version_saved: {
    hu: 'Verzió mentve. A prezentáción tovább dolgozhatsz, a visszavonás is megmaradt.',
    en: 'Version saved. You can keep working on the presentation, and undo still works.',
  },
  deck_version_unchanged: {
    hu: 'Nincs új változás a legutóbbi verzió óta.',
    en: 'There is no new change since the last version.',
  },
  deck_exported: {
    hu: 'Kész a fájl. Új fájl lett belőle a projekt mappájában, a régi fájlok érintetlenek.',
    en: 'The file is ready. It is a new file in the project folder; the old files are untouched.',
  },
  deck_bad_format: {
    hu: 'Az exportálás csak PPTX (PowerPoint) vagy PDF lehet.',
    en: 'The export can only be PPTX (PowerPoint) or PDF.',
  },
  deck_export_empty: {
    hu: 'A prezentációban még nincs dia, így nincs mit exportálni. Adj hozzá legalább egy diát.',
    en: 'The presentation has no slide yet, so there is nothing to export. Add at least one slide.',
  },
  deck_export_failed: {
    hu: 'Az exportálás nem sikerült. A részletek megmondják, miért.',
    en: 'The export did not work. The details say why.',
  },
  deck_pdf_not_installed: {
    hu: 'A PDF-hez LibreOffice kell, de nincs telepítve ezen a gépen. A PPTX-et így is megkapod; a Képességek panel megmondja, hogyan telepítheted a LibreOffice-t.',
    en: 'The PDF needs LibreOffice, which is not installed on this machine. You can still get the PPTX; the Capabilities panel says how to install LibreOffice.',
  },
  deck_pdf_check_failed: {
    hu: 'A LibreOffice-t nem tudtam ellenőrizni, ezért a PDF nem készült el. A PPTX-et így is megkapod.',
    en: 'I could not check LibreOffice, so the PDF was not made. You can still get the PPTX.',
  },
  deck_pdf_timeout: {
    hu: 'A PDF készítése túl sokáig tartott, ezért megszakítottam. Próbáld újra, vagy kérj PPTX-et.',
    en: 'Making the PDF took too long, so I stopped it. Try again, or ask for the PPTX.',
  },
  deck_pdf_convert_failed: {
    hu: 'A LibreOffice nem tudta PDF-fé alakítani a prezentációt. Ha csak a LibreOffice szövegszerkesztő része (Writer) van telepítve, a bemutató része (Impress) is kell hozzá. A PPTX-et így is megkapod. A részletek megmondják, mit írt a program.',
    en: 'LibreOffice could not turn the presentation into a PDF. If only the text part of LibreOffice (Writer) is installed, the presentation part (Impress) is needed as well. You can still get the PPTX. The details say what the program wrote.',
  },
  deck_pdf_no_output: {
    hu: 'A LibreOffice lefutott, de nem készült PDF. Ha csak a LibreOffice szövegszerkesztő része (Writer) van telepítve, a bemutató része (Impress) is kell hozzá. A PPTX-et így is megkapod.',
    en: 'LibreOffice ran, but no PDF was made. If only the text part of LibreOffice (Writer) is installed, the presentation part (Impress) is needed as well. You can still get the PPTX.',
  },
  deck_pdf_missing_source: {
    hu: 'A PDF készítéséhez szükséges ideiglenes fájl eltűnt. Próbáld újra.',
    en: 'The temporary file needed for the PDF disappeared. Try again.',
  },
  deck_nothing_to_undo: {
    hu: 'Nincs mit visszavonni: a legutóbbi verzió óta nem történt változás ezen a prezentáción.',
    en: 'There is nothing to undo: this presentation has not changed since the last version.',
  },
  deck_nothing_to_redo: {
    hu: 'Nincs mit újra elvégezni: nincs visszavont lépés.',
    en: 'There is nothing to redo: no step has been undone.',
  },
  deck_undo_conflict: {
    hu: 'Ezt a lépést nem vonom vissza, mert közben a prezentáció más módon is megváltozott. A mostani prezentáció érintetlen.',
    en: 'I am not undoing this step, because the presentation has changed in another way since. The presentation is untouched.',
  },
  deck_draft_unreadable: {
    hu: 'A prezentáció munkapéldánya sérült az adatbázisban. A verziók érintetlenek: a verziólistából visszaállhatsz egyre.',
    en: 'The working copy of the presentation is damaged in the database. The versions are untouched: you can go back to one from the version list.',
  },
  deck_nothing_to_version: {
    hu: 'Még nincs prezentáció, így nincs miből verziót menteni. Adj hozzá egy diát.',
    en: 'There is no presentation yet, so there is nothing to save as a version. Add a slide first.',
  },
  deck_orphan_not_found: {
    hu: 'Ez az elhagyott munka már nem található.',
    en: 'That abandoned work is no longer there.',
  },
  deck_missing: {
    hu: 'A prezentáció fájlja nem található a lemezen.',
    en: 'The presentation file cannot be found on disk.',
  },
  deck_unreachable: {
    hu: 'A prezentáció fájljához nem látok oda (a Raktár vagy a mappa nem elérhető).',
    en: 'I cannot reach the presentation file (the Depot or the folder is not available).',
  },
  deck_unreadable: {
    hu: 'A prezentáció fájlját nem tudtam elolvasni.',
    en: 'I could not read the presentation file.',
  },
  deck_too_large: {
    hu: 'A prezentáció fájlja túl nagy.',
    en: 'The presentation file is too large.',
  },
  deck_no_folder: {
    hu: 'A projektnek nincs mappája, ezért nincs hová menteni a prezentációt.',
    en: 'The project has no folder, so there is nowhere to save the presentation.',
  },
  deck_no_depot: {
    hu: 'Nincs beállítva a Raktár ezen a gépen, ezért nincs hová menteni a prezentációt.',
    en: 'The Depot is not set up on this machine, so there is nowhere to save the presentation.',
  },
  canvas_autosaved: {
    hu: 'Mentve. Verzió akkor lesz belőle, ha a „Verzió mentése” gombra nyomsz.',
    en: 'Saved. It becomes a version when you press "Save version".',
  },
  canvas_nothing_to_undo: {
    hu: 'Nincs mit visszavonni: a legutóbbi verzió óta nem történt változás ezen a rajzon.',
    en: 'There is nothing to undo: this drawing has not changed since the last version.',
  },
  canvas_nothing_to_redo: {
    hu: 'Nincs mit újra elvégezni: nincs visszavont lépés.',
    en: 'There is nothing to redo: no step has been undone.',
  },
  canvas_undo_conflict: {
    hu: 'Ezt a lépést nem vonom vissza, mert közben az érintett elem megváltozott (például egy másik ablakban). A részletek megmondják, melyik; a mostani rajz érintetlen.',
    en: 'I am not undoing this step, because the element it touched has changed since (for example in another window). The details say which one; the drawing is untouched.',
  },
  canvas_draft_unreadable: {
    hu: 'A rajz munkapéldánya sérült az adatbázisban. A verziók érintetlenek: a verziólistából visszaállhatsz egyre.',
    en: 'The working copy of the drawing is damaged in the database. The versions are untouched: you can go back to one from the version list.',
  },
  canvas_nothing_to_version: {
    hu: 'Még nincs rajz, így nincs miből verziót menteni. Kezdd el a rajzot.',
    en: 'There is no drawing yet, so there is nothing to save as a version. Start the drawing first.',
  },
  canvas_version_saved: {
    hu: 'Verzió mentve. A rajzon tovább dolgozhatsz, a visszavonás is megmaradt.',
    en: 'Version saved. You can keep working on the drawing, and undo still works.',
  },
  canvas_version_named: {
    hu: 'A legutóbbi verzió óta nem változott semmi, ezért nem készült új: a mostani verzió kapta meg a nevet.',
    en: 'Nothing has changed since the last version, so no new one was made: the current version got the name.',
  },
  canvas_version_unchanged: {
    hu: 'A legutóbbi verzió óta nem változott semmi, ezért nem készült új verzió.',
    en: 'Nothing has changed since the last version, so no new version was made.',
  },
  canvas_orphan_not_found: {
    hu: 'Ez a félbehagyott munkapéldány már nincs meg (lehet, hogy egy másik ablakban már döntöttél róla). Frissítsd a rajzot.',
    en: 'This unsaved working copy is no longer there (perhaps you already dealt with it in another window). Refresh the drawing.',
  },
  canvas_orphan_restored: {
    hu: 'A félbehagyott munkából új verzió lett, most ez a jelenlegi.',
    en: 'The unsaved work became a new version, and it is now the current one.',
  },
  canvas_orphan_discarded: {
    hu: 'A félbehagyott munkapéldány törölve. A verziók érintetlenek.',
    en: 'The unsaved working copy was deleted. The versions are untouched.',
  },
  canvas_variant_made: {
    hu: 'Elkészült a(z) {name} változat, új verzióként. Az eredeti méret megmaradt az előző verzióban. Az elemeket arányosan rendeztem át; nézd át, és finomíts rajta (a Marvin is segít).',
    en: 'The {name} variant is ready, as a new version. The original size is kept in the previous version. The elements were rearranged proportionally; check them and fine-tune (Marvin can help).',
  },
  canvas_unknown_platform: {
    hu: 'Ilyen platformméretet nem ismerek. Válassz a listából.',
    en: 'I do not know this platform size. Pick one from the list.',
  },
  ai_edit_done: {
    hu: 'Kész: az AI-val szerkesztett kép új fájlként mentve ({name}), a régi megmaradt. Tényleges költség: {cost}. A Visszavonás (Ctrl+Z) visszateszi a régit.',
    en: 'Done: the AI-edited picture was saved as a new file ({name}); the old one is kept. Actual cost: {cost}. Undo (Ctrl+Z) puts the old one back.',
  },
  ai_edit_sensitive: {
    hu: 'Ez a munkadarab (vagy a projektje) érzékenynek van jelölve, ezért a kép nem mehet ki külső AI-szolgáltatóhoz. Az AI-képszerkesztés itt nem érhető el; kézzel minden szerkeszthető.',
    en: 'This work item (or its project) is marked sensitive, so the picture cannot go to an outside AI service. AI image editing is not available here; everything can be edited by hand.',
  },
  ai_edit_not_configured: {
    hu: 'Az AI-képszerkesztéshez Google Gemini API-kulcs kell. A Munkapad Képességek ablakában („AI-képszerkesztés”) be tudod írni; addig minden más működik.',
    en: 'AI image editing needs a Google Gemini API key. You can enter it in the Workbench Capabilities window ("AI image editing"); everything else works meanwhile.',
  },
  ai_edit_confirm_cost: {
    hu: 'Az AI-szerkesztés pénzbe kerül: előbb nézd meg a várható költséget, és azzal indítsd.',
    en: 'AI editing costs money: check the expected cost first and start it from there.',
  },
  ai_edit_no_instruction: { hu: 'Írd le egy mondatban, mit változtasson a képen.', en: 'Write in one sentence what to change on the picture.' },
  ai_edit_not_image: { hu: 'AI-szerkesztés csak képelemen fut. Válassz egy képet a rajzon.', en: 'AI editing only runs on a picture element. Pick a picture on the drawing.' },
  ai_edit_image_missing: { hu: 'A kép fájlját nem találom a Raktárban.', en: 'I cannot find the picture file in the Depot.' },
  ai_edit_bad_image: { hu: 'Ezt a képet nem tudom AI-val szerkeszteni (csak PNG, JPEG, WebP).', en: 'This picture cannot be edited with AI (PNG, JPEG, WebP only).' },
  ai_edit_too_large: { hu: 'A kép túl nagy az AI-szerkesztéshez (legfeljebb 12 MB).', en: 'The picture is too large for AI editing (12 MB at most).' },
  ai_edit_bad_key: { hu: 'A Google elutasította az API-kulcsot. Nézd meg a kulcsot és a fizetési beállítást az AI Studióban.', en: 'Google rejected the API key. Check the key and its billing in AI Studio.' },
  ai_edit_quota: { hu: 'A Google-kerete most elfogyott vagy túl sok volt a kérés. Próbáld később; a kézi szerkesztés addig is működik.', en: 'Your Google quota ran out or there were too many requests. Try later; manual editing works meanwhile.' },
  ai_edit_bad_model: { hu: 'A beállított képmodellt a Google nem ismeri (lehet, hogy leállították). Állíts be másikat a Beállításokban.', en: 'Google does not know the configured image model (it may have been retired). Set another one in Settings.' },
  ai_edit_no_image: { hu: 'A modell nem adott vissza képet (gyakran tartalmi szűrő miatt). A részletekben a saját válasza.', en: 'The model returned no picture (often because of a content filter). Its own answer is in the details.' },
  ai_edit_timeout: { hu: 'Az AI-szerkesztés nem készült el 2 percen belül. Próbáld újra.', en: 'The AI edit did not finish within 2 minutes. Try again.' },
  ai_edit_network: { hu: 'Nem értem el a Google szolgáltatását (hálózat). Próbáld újra.', en: 'I could not reach the Google service (network). Try again.' },
  ai_edit_failed: { hu: 'Az AI-szerkesztés nem sikerült. A részletekben a szolgáltató üzenete.', en: 'The AI edit failed. The provider message is in the details.' },
  ai_edit_write_failed: { hu: 'Az új képet nem tudtam elmenteni a projekt mappájába.', en: 'I could not save the new picture into the project folder.' },
  intake_empty: { hu: 'Írd le egy mondatban, mit szeretnél, vagy válassz egy gombot.', en: 'Describe in one sentence what you want, or pick a button.' },
  intake_ask: {
    hu: 'Nem vagyok biztos benne, melyik legyen. Válaszd ki, és a mondatodat továbbadom a Marvinnak.',
    en: 'I am not sure which one it should be. Pick one, and I pass your sentence on to Marvin.',
  },
  intake_ask_all: {
    hu: 'Ebből még nem tudom, mit hozzak létre. Milyen munka lesz? Válassz, és a mondatodat továbbadom a Marvinnak.',
    en: 'I cannot tell yet what to create from this. What kind of work is it? Pick one, and I pass your sentence on to Marvin.',
  },
  canvas_old_version: {
    hu: 'Régebbi verziót nem lehet közvetlenül szerkeszteni. Állítsd vissza a verziólistából, és utána szerkeszd.',
    en: 'An older version cannot be edited directly. Restore it from the version list, then edit it.',
  },
  send_bad_to: {
    hu: 'Adj meg egy érvényes email-címet a címzettnek (például: nev@pelda.hu). Egyszerre egy címzett.',
    en: 'Give a valid email address for the recipient (for example: name@example.com). One recipient at a time.',
  },
  send_subject_too_long: {
    hu: `A tárgy túl hosszú (legfeljebb ${SEND_SUBJECT_MAX} karakter).`,
    en: `The subject is too long (${SEND_SUBJECT_MAX} characters at most).`,
  },
  send_message_too_long: {
    hu: `Az üzenet túl hosszú (legfeljebb ${SEND_MESSAGE_MAX} karakter).`,
    en: `The message is too long (${SEND_MESSAGE_MAX} characters at most).`,
  },
  send_no_source: {
    hu: 'Ennek a munkadarabnak nincs elérhető eredeti fájlja, amit csatolni lehetne. Válaszd a nyomtatható lapot mellékletnek.',
    en: 'This work item has no reachable original file to attach. Pick the printable page as the attachment.',
  },
  send_write_failed: {
    hu: 'A mellékletet nem tudtam elkészíteni. A pontos hibát a részletek mutatják.',
    en: 'The attachment could not be prepared. The details show the exact error.',
  },
  send_sent: {
    hu: 'Elküldve. A levél a bekötött Google-fiókodról ment ki.',
    en: 'Sent. The email went out from your connected Google account.',
  },
  send_no_mail_account: {
    hu: 'Nincs bekötött Google-fiók, amiről a levél kimehetne, ezért semmi nem ment ki. Kösd be a fiókodat a Beállítások → Fiókok oldalon (Google, levélküldési joggal), és próbáld újra.',
    en: 'There is no connected Google account to send from, so nothing went out. Connect your account under Settings → Accounts (Google, with permission to send email) and try again.',
  },
  send_failed: {
    hu: 'A levél NEM ment ki. A pontos hibát a részletek mutatják.',
    en: 'The email did NOT go out. The details show the exact error.',
  },
  send_requested: {
    hu: 'A küldés jóváhagyásra vár. Semmi nem ment ki: jóváhagyás után a fő ágens küldi el, elutasításnál nem történik semmi.',
    en: 'The send is waiting for approval. Nothing has gone out: after approval the main agent sends it, on rejection nothing happens.',
  },
  docedit_unsupported: {
    hu: 'Ez a munkadarab nem Word-jellegű dokumentum (docx, doc, odt, rtf), ezért ezzel a szerkesztővel nem nyitható meg.',
    en: 'This work item is not a Word-type document (docx, doc, odt, rtf), so it cannot be opened in this editor.',
  },
  docedit_old_version: {
    hu: 'Csak a legújabb verzió szerkeszthető. Ha egy régebbiből folytatnád, előbb állítsd vissza a Verziók listában.',
    en: 'Only the newest version can be edited. To continue from an older one, restore it first in the Versions list.',
  },
  docedit_stale: {
    hu: 'Amíg szerkesztetted, a dokumentumnak új verziója lett (máshonnan mentették). Hogy semmi ne vesszen el, nem írtam felül: nyisd meg újra a szerkesztőt.',
    en: 'While you were editing, the document got a new version (saved from elsewhere). So that nothing is lost it was not overwritten: open the editor again.',
  },
  docedit_empty: {
    hu: 'Üres dokumentumot nem mentek el. Ha tényleg törölni akarod a tartalmát, írj bele legalább egy sort.',
    en: 'An empty document is not saved. If you really want to clear it, write at least one line.',
  },
  docedit_too_large: {
    hu: `A dokumentum a képeivel együtt túl nagy ahhoz, hogy itt mentsem (legfeljebb ${Math.floor(DOC_EDIT_HTML_MAX / (1024 * 1024))} MB).`,
    en: `The document with its images is too large to save here (${Math.floor(DOC_EDIT_HTML_MAX / (1024 * 1024))} MB at most).`,
  },
  docedit_not_installed: {
    hu: 'A dokumentum szerkesztéséhez a LibreOffice kell, és az ezen a gépen nincs telepítve. Linuxon: „sudo apt install libreoffice-writer”, Windowson/macOS-en a libreoffice.org oldaláról telepíthető. Ha máshova telepítetted, add meg az útvonalát a Munkapad „Mi működik ezen a gépen?” paneljén.',
    en: 'Editing the document needs LibreOffice, and it is not installed on this machine. On Linux: "sudo apt install libreoffice-writer", on Windows/macOS from libreoffice.org. If you installed it elsewhere, give its path on the Workbench "What works on this machine?" panel.',
  },
  docexport_not_installed: {
    hu: 'A Word/LibreOffice formátumokhoz a LibreOffice kell, és az ezen a gépen nincs telepítve. Linuxon: „sudo apt install libreoffice-writer”, Windowson/macOS-en a libreoffice.org oldaláról telepíthető. A PDF, a kép és a HTML export enélkül is működik.',
    en: 'The Word/LibreOffice formats need LibreOffice, and it is not installed on this machine. On Linux: "sudo apt install libreoffice-writer", on Windows/macOS from libreoffice.org. The PDF, image and HTML exports work without it.',
  },
  docexport_bad_format: {
    hu: 'Ismeretlen exportformátum.',
    en: 'Unknown export format.',
  },
  docedit_check_failed: {
    hu: 'Nem tudtam megállapítani, van-e LibreOffice ezen a gépen, tehát ez NEM azt jelenti, hogy nincs. A pontos hibaüzenet a részleteknél olvasható.',
    en: 'It could not be determined whether LibreOffice is on this machine, so this does NOT mean it is missing. The exact error is in the details.',
  },
  docedit_timeout: {
    hu: 'Az átalakítás túl sokáig tartott, ezért leállítottam. Nagy vagy sérült dokumentumnál fordul elő; próbáld újra.',
    en: 'The conversion took too long, so it was stopped. This happens with very large or damaged documents; try again.',
  },
  docedit_convert_failed: {
    hu: 'Az átalakítás nem sikerült. A pontos hibaüzenet a részleteknél olvasható, okot nem találgatok helyette.',
    en: 'The conversion failed. The exact error is in the details; no cause is guessed in its place.',
  },
  docedit_no_output: {
    hu: 'Az átalakító lefutott, de nem keletkezett fájl. Ez általában sérült vagy jelszóval védett dokumentumnál fordul elő.',
    en: 'The converter ran but produced no file. This usually happens with a damaged or password-protected document.',
  },
  pdfedit_unsupported: {
    hu: 'Ez a munkadarab nem PDF, ezért a PDF-szerkesztő nem nyitható meg rajta.',
    en: 'This work item is not a PDF, so the PDF editor cannot be opened on it.',
  },
  pdfedit_bad_pdf: {
    hu: 'A mentendő fájl nem ép PDF, ezért nem mentettem el. Próbáld újra a mentést.',
    en: 'The file to save is not a valid PDF, so it was not saved. Try saving again.',
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
  asset_duplicate: {
    hu: 'Ez a fájl már megvan ennek a munkadarabnak az anyagai között.',
    en: 'This file is already among the materials of this work item.',
  },
  asset_unsupported: {
    hu: 'Ilyen fájlt nem tölthetsz fel anyagnak (futtatható program vagy telepítő).',
    en: 'This kind of file cannot be added as a material (a program or an installer).',
  },
  asset_limit: {
    hu: 'Ennek a munkadarabnak már túl sok anyaga van. Nyiss egy új munkadarabot, vagy vegyél le a listáról régieket.',
    en: 'This work item already has too many materials. Open a new work item or remove old ones from the list.',
  },
  outline_not_found: {
    hu: 'Ez a fejezet vagy bekezdés már nincs meg.',
    en: 'This section or block no longer exists.',
  },
  outline_bad_input: {
    hu: 'Hibás adat: a cím vagy a szöveg nem lehet üres, és nem lehet túl hosszú sem (egy bekezdés legfeljebb 20 000 karakter). A részletek megmondják, melyik a baj.',
    en: 'Invalid input: the title or the text cannot be empty, and cannot be too long either (a paragraph is 20,000 characters at most). The details say which one it is.',
  },
  outline_too_many: {
    hu: 'Ez a dokumentum már túl nagy. Oszd több munkadarabra.',
    en: 'This document is already too large. Split it into several work items.',
  },
  outline_claim_not_in_text: {
    hu: 'Az állítás nem szerepel szó szerint a bekezdésben.',
    en: 'The claim is not a verbatim part of the block.',
  },
  outline_rewrite_stale: {
    hu: 'Ez a bekezdés megváltozott, amióta a javaslat készült, ezért a javaslat már nem illik rá. Vesd el, és kérj újat.',
    en: 'This block changed since the proposal was made, so the proposal no longer fits it. Dismiss it and ask for a new one.',
  },
  privacy_bad_input: {
    hu: 'Hibás kérés: a "sensitive" mező igen/nem értéket vár.',
    en: 'Bad request: the "sensitive" field takes a yes/no value.',
  },
  privacy_owner_only: {
    hu: 'Az „Érzékeny” jelölést csak te kapcsolhatod ki, a saját kattintásoddal. Az Agent csak bekapcsolni tudja.',
    en: 'Only you can turn the "Sensitive" mark off, with your own click. The Agent can only turn it on.',
  },
  variant_bad_input: {
    hu: 'Ismeretlen nyelv. Válassz a listából, vagy adj meg egy kétbetűs nyelvkódot (például fr).',
    en: 'Unknown language. Pick one from the list or give a two-letter language code (for example fr).',
  },
  variant_outline_empty: {
    hu: 'Ennek a dokumentumnak még nincs vázlata, ezért nincs mit lefordítani.',
    en: 'This document has no outline yet, so there is nothing to translate.',
  },
  variant_variant_of_variant: {
    hu: 'Ez már egy nyelvi változat. Új nyelvi változatot az eredetiből készíts.',
    en: 'This is already a language version. Make a new language version from the original.',
  },
  doc_tool_unknown: {
    hu: 'Ismeretlen dokumentum-eszköz (csak a doc.* eszközök érhetők el itt).',
    en: 'Unknown document tool (only the doc.* tools are available here).',
  },
  doc_tool_not_allowed: {
    hu: 'Ehhez a művelethez az Agentnek most nincs önálló joga (autonómia-beállítás).',
    en: 'The Agent has no autonomous right for this action now (autonomy setting).',
  },
  outline_empty: {
    hu: 'Ennek a dokumentumnak még nincs vázlata, ezért nincs miből PDF-et készíteni.',
    en: 'This document has no outline yet, so there is nothing to make a PDF from.',
  },
  outline_not_ready: {
    hu: 'Még nem véglegesíthető: a „Véglegesítés előtti ellenőrzés” listán van még megoldatlan pont. A piszkozat PDF addig is elkészíthető.',
    en: 'It cannot be finalized yet: the "Check before finalizing" list still has open points. The draft PDF can be made in the meantime.',
  },
  outline_changed: {
    hu: 'A dokumentum közben megváltozott. Frissítettem a vázlatot: nézd át újra, és utána véglegesítsd.',
    en: 'The document changed in the meantime. The outline is refreshed: review it again, then finalize it.',
  },
  outline_not_reviewed: {
    hu: 'Előbb nyisd meg és nézd át a dokumentumot a „Megnyitom és átnézem” gombbal. Ha azóta módosult, újra meg kell nyitnod.',
    en: 'First open and review the document with the "Open and review" button. If it changed since, open it again.',
  },
  outline_accept_required: {
    hu: 'A véglegesítéshez pipáld be, hogy átnézted a dokumentumot, és a tartalmáért felelősséget vállalsz.',
    en: 'To finalize, tick that you reviewed the document and take responsibility for its content.',
  },
  outline_finalize_owner_only: {
    hu: 'Véglegesíteni csak te tudsz, a saját kattintásoddal. Az Agent a piszkozatot tudja elkészíteni.',
    en: 'Only you can finalize, with your own click. The Agent can make the draft.',
  },
  docpdf_not_installed: {
    hu: 'A PDF elkészítéséhez a LibreOffice kell, és ezen a gépen nincs telepítve. Enélkül a vázlat szerkeszthető és ellenőrizhető, csak PDF nem készül belőle. Telepítés: Linuxon „sudo apt install libreoffice-writer”, Windowson és macOS-en a libreoffice.org oldaláról. Ha máshová telepítetted, a Munkapad „Mi működik ezen a gépen?” paneljén add meg az útvonalát.',
    en: 'Making the PDF needs LibreOffice, and it is not installed on this machine. Without it the outline can still be edited and checked, only no PDF is made. To install: on Linux "sudo apt install libreoffice-writer", on Windows and macOS from libreoffice.org. If you installed it elsewhere, give its path in the Workbench "What works on this machine?" panel.',
  },
  docpdf_check_failed: {
    hu: 'Nem tudtam megállapítani, van-e LibreOffice ezen a gépen, tehát ez NEM azt jelenti, hogy nincs. A pontos hibaüzenet a részleteknél olvasható.',
    en: 'It could not be determined whether LibreOffice is on this machine, so this does NOT mean it is missing. The exact error is in the details.',
  },
  docpdf_timeout: {
    hu: 'A PDF elkészítése túl sokáig tartott, ezért leállítottam. Próbáld újra.',
    en: 'Making the PDF took too long, so it was stopped. Try again.',
  },
  docpdf_annex_missing: {
    hu: 'Ennek a mellékletnek a fájlja nincs meg a projekt mappájában: {label}. Tedd vissza a fájlt, vagy vedd le a mellékletek közül.',
    en: 'The file of this annex is not in the project folder: {label}. Put the file back, or remove it from the annexes.',
  },
  docpdf_annex_unsupported: {
    hu: 'Ebből a mellékletből nem tudok PDF-et készíteni, mert ez a fájlfajta nem alakítható át: {label}. Melléklet lehet PDF, Word- vagy LibreOffice-dokumentum, kép (JPG, PNG) vagy szövegfájl.',
    en: 'No PDF can be made from this annex, because this kind of file cannot be converted: {label}. An annex can be a PDF, a Word or LibreOffice document, an image (JPG, PNG) or a text file.',
  },
  docpdf_annex_convert_failed: {
    hu: 'Ezt a mellékletet nem sikerült PDF-fé alakítani: {label}. A pontos hibaüzenet a részleteknél olvasható.',
    en: 'This annex could not be converted to PDF: {label}. The exact error is in the details.',
  },
  docpdf_merge_not_installed: {
    hu: 'A mellékletek egyesítéséhez a Poppler „pdfunite” programja kell, és ezen a gépen nincs meg. Linuxon: „sudo apt install poppler-utils”, macOS-en: „brew install poppler”. Melléklet nélkül a PDF enélkül is elkészül.',
    en: 'Joining the annexes needs the Poppler "pdfunite" program, and it is not on this machine. On Linux: "sudo apt install poppler-utils", on macOS: "brew install poppler". Without annexes the PDF is made anyway.',
  },
  docpdf_merge_failed: {
    hu: 'A PDF-ek egyesítése nem sikerült. A pontos hibaüzenet a részleteknél olvasható.',
    en: 'Joining the PDFs failed. The exact error is in the details.',
  },
  docpdf_failed: {
    hu: 'A PDF elkészítése nem sikerült. A pontos hibaüzenet a részleteknél olvasható, okot nem találgatok helyette.',
    en: 'Making the PDF failed. The exact error is in the details; no cause is guessed in its place.',
  },
  docx_not_installed: {
    hu: 'A Word-fájl elkészítéséhez a LibreOffice kell, és ezen a gépen nincs telepítve. Telepítés: Linuxon „sudo apt install libreoffice-writer”, Windowson és macOS-en a libreoffice.org oldaláról. Ha máshová telepítetted, a Munkapad „Mi működik ezen a gépen?” paneljén add meg az útvonalát.',
    en: 'Making the Word file needs LibreOffice, and it is not installed on this machine. To install: on Linux "sudo apt install libreoffice-writer", on Windows and macOS from libreoffice.org. If you installed it elsewhere, give its path in the Workbench "What works on this machine?" panel.',
  },
  docx_check_failed: {
    hu: 'Nem tudtam megállapítani, van-e LibreOffice ezen a gépen, tehát ez NEM azt jelenti, hogy nincs. A pontos hibaüzenet a részleteknél olvasható.',
    en: 'It could not be determined whether LibreOffice is on this machine, so this does NOT mean it is missing. The exact error is in the details.',
  },
  docx_timeout: {
    hu: 'A Word-fájl elkészítése túl sokáig tartott, ezért leállítottam. Próbáld újra.',
    en: 'Making the Word file took too long, so it was stopped. Try again.',
  },
  docx_failed: {
    hu: 'A Word-fájl elkészítése nem sikerült. A pontos hibaüzenet a részleteknél olvasható, okot nem találgatok helyette.',
    en: 'Making the Word file failed. The exact error is in the details; no cause is guessed in its place.',
  },
  outline_duplicate: {
    hu: 'Ez a fájl már szerepel a mellékletek között.',
    en: 'This file is already one of the annexes.',
  },
  outline_file_missing: {
    hu: 'Ez a fájl nincs meg a projekt mappájában. Előbb töltsd fel az anyagok közé.',
    en: 'This file is not in the project folder. Upload it to the materials first.',
  },
  outline_owner_only: {
    hu: 'Ezt csak te erősítheted meg, a saját kattintásoddal.',
    en: 'Only you can confirm this, with your own click.',
  },
  deadline_owner_only: {
    hu: 'A határidőt csak te veheted fel teendőnek, a saját kattintásoddal.',
    en: 'Only you can add a deadline as a to-do, with your own click.',
  },
  deadline_gone: {
    hu: 'Ez a határidő már nincs a listán (közben változott az irat vagy az anyagok listája). Frissítem a listát.',
    en: 'This deadline is no longer on the list (the document or the materials changed). Refreshing the list.',
  },
  deadline_not_relative: {
    hu: 'Ennek a határidőnek az irat megnevezi a napját, nem kell kiszámolni.',
    en: 'The document names the day of this deadline; there is nothing to compute.',
  },
  deadline_bad_trigger: {
    hu: 'Add meg a kézbesítés (kézhezvétel) napját a naptárban.',
    en: 'Pick the day of delivery (receipt) in the calendar.',
  },
  deadline_workdays: {
    hu: 'Ez a határidő munkanapban számít, és a munkaszüneti napokat a Marvin nem ismeri, ezért nem tesz javaslatot. Add meg te a határidő napját.',
    en: 'This deadline counts in working days, and Marvin does not know the public holidays, so it makes no proposal. Enter the day of the deadline yourself.',
  },
  deadline_needs_due: {
    hu: 'Ennek a határidőnek az irat nem nevezi meg a napját. Add meg a határidő napját, és utána veszem fel teendőnek.',
    en: 'The document does not name the day of this deadline. Enter the day of the deadline, then I add it as a to-do.',
  },
  deadline_bad_due: {
    hu: 'A határidő napja nem érvényes dátum. Válaszd ki a naptárban.',
    en: 'The day of the deadline is not a valid date. Pick it in the calendar.',
  },
  deadline_already: {
    hu: 'Ebből a határidőből már van teendő. A Teendők között találod.',
    en: 'This deadline is already a to-do. You find it among the to-dos.',
  },
  outline_consistency_gone: {
    hu: 'Ez az eltérés már nincs a dokumentumban (közben javították). Frissítem a listát.',
    en: 'This mismatch is no longer in the document (it was fixed in the meantime). Refreshing the list.',
  },
  searchable_not_pdf: {
    hu: 'Kereshető másolat csak PDF-ből készülhet.',
    en: 'Only a PDF can get a searchable copy.',
  },
  searchable_not_installed: {
    hu: 'Ezen a gépen nincs telepítve az OCRmyPDF, ezért nem tudok kereshető másolatot készíteni.',
    en: 'OCRmyPDF is not installed on this machine, so no searchable copy can be made.',
  },
  searchable_failed: {
    hu: 'A kereshető másolat nem készült el.',
    en: 'The searchable copy could not be made.',
  },
  court_bad_input: {
    hu: 'Ilyen célbíróság-profil nincs.',
    en: 'There is no such court profile.',
  },
  court_owner_only: {
    hu: 'Azt, hogy a hivatalos forrást megnézted, csak te jelezheted, a saját kattintásoddal.',
    en: 'Only you can confirm, with your own click, that you looked at the official source.',
  },
  court_owner_only_rules: {
    hu: 'Szabályfrissítést elfogadni vagy elvetni, és a figyelmeztetés idejét átállítani csak te tudsz, a saját kattintásoddal.',
    en: 'Only you can accept or reject a rule update, or change the reminder time, with your own click.',
  },
  court_file_broken: {
    hu: 'A célbíróság-profilok fájlja hibás, ezért nem írok bele (a kézi javításaid elvesznének). Javítsd ki a fájlt, vagy nevezd át, és a beépített profilok maradnak.',
    en: 'The court profile file is broken, so I do not write to it (your manual fixes would be lost). Fix the file, or rename it and the built-in profiles stay.',
  },
  court_settings_bad: {
    hu: 'A figyelmeztetés ideje 30 és 3650 nap között lehet.',
    en: 'The reminder time can be between 30 and 3650 days.',
  },
  court_proposal_not_found: {
    hu: 'Ez a szabályfrissítési javaslat már nincs meg.',
    en: 'This rule update proposal no longer exists.',
  },
  court_proposal_not_open: {
    hu: 'Erről a javaslatról már döntöttél, vagy újabb javaslat váltotta fel.',
    en: 'This proposal was already decided, or a newer proposal replaced it.',
  },
  court_no_profile: {
    hu: 'Ennél a munkadarabnál nincs kiválasztva célbíróság. Válassz egyet, és utána ellenőrzöm.',
    en: 'No target court is chosen for this work item. Choose one and I will check.',
  },
  court_no_final: {
    hu: 'Még nincs végleges változat. Az ellenőrzés a véglegesítéskor, a kész fájlokon fut.',
    en: 'There is no final version yet. The check runs on the finished files when you finalize.',
  },
  court_file_missing: {
    hu: 'A végleges változat egyik fájlja már nincs meg a mappában, ezért nem tudom újra ellenőrizni. Véglegesítsd újra.',
    en: 'One file of the final version is no longer in the folder, so I cannot check it again. Finalize again.',
  },
  court_not_installed: {
    hu: 'Ezen a gépen nincs telepítve a Poppler (pdfinfo, pdffonts, pdftotext, pdfdetach), ezért a fájlokat nem tudom gépi úton ellenőrizni.',
    en: 'Poppler (pdfinfo, pdffonts, pdftotext, pdfdetach) is not installed on this machine, so the files cannot be checked by machine.',
  },
  court_annex_not_found: {
    hu: 'Ez a melléklet már nincs a jegyzékben.',
    en: 'This annex is no longer on the list.',
  },
  court_fix_not_pdf: {
    hu: 'Kereshető változat csak PDF-mellékletből készülhet. Ezt a mellékletet szkenneld be újra szöveggel, vagy cseréld PDF-re.',
    en: 'Only a PDF annex can get a searchable copy. Scan this annex again with text, or replace it with a PDF.',
  },
  redact_not_pdf: {
    hu: 'Kitakart másolat csak PDF-ből készülhet.',
    en: 'Only a PDF can get a redacted copy.',
  },
  redact_not_installed: {
    hu: 'Ezen a gépen nincs telepítve a Poppler (pdftoppm, pdftotext), ezért nem tudok kitakart másolatot készíteni.',
    en: 'Poppler (pdftoppm, pdftotext) is not installed on this machine, so no redacted copy can be made.',
  },
  redact_too_many_pages: {
    hu: 'Ez az irat túl hosszú a kitakaráshoz (legfeljebb 300 oldal). Bontsd kisebb részekre.',
    en: 'This document is too long to redact (at most 300 pages). Split it into smaller parts.',
  },
  redact_nothing_selected: {
    hu: 'Nincs kijelölve semmi, amit ki kellene takarni.',
    en: 'Nothing is selected for redaction.',
  },
  redact_verify_failed: {
    hu: 'A kész másolatot ellenőriztem, és egy kitakart szöveg még kiolvasható volt belőle, ezért nem tartottam meg. Semmi nem került ki.',
    en: 'I checked the finished copy and a redacted text could still be read from it, so I did not keep it. Nothing went out.',
  },
  redact_failed: {
    hu: 'A kitakart másolat nem készült el.',
    en: 'The redacted copy could not be made.',
  },
  document_bad_path: {
    hu: 'Ez az út nem egy fájlra mutat a projekt mappáján belül.',
    en: 'This path does not point to a file inside the project folder.',
  },
  shared_duplicate: {
    hu: 'Ez a fájl már megvan a projekt közös tárában.',
    en: 'This file is already in the shared materials of the project.',
  },
  no_shared_folder: {
    hu: 'Ennek a projektnek még nincs közös tára. Tölts fel bele egy fájlt, és az létrehozza.',
    en: 'This project has no shared materials yet. Upload a file there and it will be created.',
  },
  not_shared: {
    hu: 'Ez a fájl nem a projekt közös tárában van.',
    en: 'This file is not in the shared materials of the project.',
  },
  asset_in_use: {
    hu: 'Ezt a fájlt más is használja ({users}), ezért nem törlöm a mappából. Csak levenni lehet.',
    en: 'This file is used elsewhere too ({users}), so it is not deleted from the folder. It can only be removed from the list.',
  },
  asset_outside: {
    hu: 'Ez a fájl nem a projekt mappájában van, ezért innen nem törölhető. Csak levenni lehet.',
    en: 'This file is not in the folder of the project, so it cannot be deleted from here. It can only be removed from the list.',
  },
  delete_failed: {
    hu: 'A fájlt nem sikerült törölni a mappából. Lehet, hogy egy program épp nyitva tartja: zárd be, és próbáld újra.',
    en: 'The file could not be deleted from the folder. A program may be keeping it open: close it and try again.',
  },
  no_item_folder: {
    hu: 'Ennek a munkadarabnak még nincs saját mappája. Adj hozzá egy fájlt, és az létrehozza.',
    en: 'This work item has no folder of its own yet. Add a file and it will be created.',
  },
  bad_place: {
    hu: 'Ismeretlen hely: ezt a mappát nem tudom megnyitni.',
    en: 'Unknown place: this folder cannot be opened.',
  },
  open_no_file_manager: {
    hu: 'Ezen a gépen nincs fájlkezelő, amit meg lehetne nyitni. Használd az Intéző gombot.',
    en: 'This machine has no file manager that can be opened. Use the Explorer button instead.',
  },
  open_open_failed: {
    hu: 'A fájlkezelőt nem sikerült megnyitni ezen a gépen. Próbáld újra, vagy használd az Intéző gombot.',
    en: 'The file manager could not be opened on this machine. Try again, or use the Explorer button.',
  },
  open_not_found: {
    hu: 'Ez a mappa már nincs meg a lemezen.',
    en: 'This folder no longer exists on the disk.',
  },
  asset_not_found: {
    hu: 'Ez az anyag már nincs a munkadarab listáján.',
    en: 'This material is no longer on the list of the work item.',
  },
  folder_name: {
    hu: 'A munkadarab nevéből nem lehet mappanevet készíteni. Nevezd át a munkadarabot, és próbáld újra.',
    en: 'No folder name can be made from the name of the work item. Rename the work item and try again.',
  },
  folder_taken: {
    hu: 'Ezt a mappát már egy másik munkadarab használja. Válassz másikat.',
    en: 'This folder is already used by another work item. Pick another one.',
  },
  move_failed: {
    hu: 'A fájlt nem sikerült áthelyezni a munkadarab mappájába. A munkadarab és a fájl a régi helyén maradt.',
    en: 'The file could not be moved into the folder of the work item. The work item and the file stayed where they were.',
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
  table_unsupported: {
    hu: 'Ezt a fájlt nem tudom táblázatként szerkeszteni. Táblázatként az .xlsx, .xlsm, .csv és .tsv fájl nyitható meg; a régi .xls-t nyisd meg Excelben, és mentsd .xlsx-ként.',
    en: 'This file cannot be edited as a table. The .xlsx, .xlsm, .csv and .tsv files open as a table; open an old .xls in Excel and save it as .xlsx.',
  },
  table_bad_file: {
    hu: 'A fájl nem olvasható táblázatként: nem ép Excel-munkafüzet (lehet, hogy sérült, jelszóval védett vagy csak a kiterjesztése .xlsx).',
    en: 'The file cannot be read as a table: it is not a valid Excel workbook (it may be damaged, password-protected, or only named .xlsx).',
  },
  table_no_sheets: {
    hu: 'Ebben a munkafüzetben nincs szerkeszthető munkalap (csak diagramlap, vagy üres).',
    en: 'This workbook has no editable worksheet (only chart sheets, or empty).',
  },
  table_too_big: {
    hu: `Ez a táblázat túl nagy a Munkapadon való szerkesztéshez (legfeljebb ${TABLE_MAX_ROWS} sor, ${TABLE_MAX_COLS} oszlop, ${TABLE_MAX_CELLS} cella). Töltsd le, szerkeszd Excelben, és töltsd vissza új verzióként.`,
    en: `This table is too large to edit on the Workbench (at most ${TABLE_MAX_ROWS} rows, ${TABLE_MAX_COLS} columns, ${TABLE_MAX_CELLS} cells). Download it, edit it in Excel and upload it back as a new version.`,
  },
  table_not_utf8: {
    hu: 'A CSV-fájl nem UTF-8 kódolású (valószínűleg régi Windowsos Excel-mentés), ezért az ékezetek elromlanának. Nyisd meg Excelben, és mentsd "CSV UTF-8" formátumban.',
    en: 'The CSV file is not UTF-8 encoded (probably an old Windows Excel export), so accented letters would break. Open it in Excel and save it as "CSV UTF-8".',
  },
  table_bad_input: {
    hu: 'A mentendő táblázat hiányos vagy hibás. Frissítsd az oldalt, és próbáld újra.',
    en: 'The table to save is incomplete or malformed. Reload the page and try again.',
  },
  table_cell_too_long: {
    hu: 'Az egyik cellában túl hosszú a szöveg (egy cellába legfeljebb 32767 karakter fér).',
    en: 'One of the cells holds too much text (a cell can hold at most 32767 characters).',
  },
  table_sheets_changed: {
    hu: 'A munkafüzet lapjai közben megváltoztak, ezért nem mentem el -- különben rossz lapra írnám. Nyisd meg újra a táblázatot.',
    en: 'The workbook sheets changed in the meantime, so it was not saved -- it would write to the wrong sheet. Open the table again.',
  },
  table_no_change: {
    hu: 'Nem változott semmi, ezért nem készült új verzió.',
    en: 'Nothing changed, so no new version was made.',
  },
  table_stale: {
    hu: 'Közben új verzió készült ebből a munkadarabból, ezért nem írom felül. A módosításaidat másold ki, nyisd meg újra a táblázatot, és vidd át.',
    en: 'A newer version of this work item was made in the meantime, so it will not be overwritten. Copy your changes, open the table again and apply them.',
  },
  table_old_version: {
    hu: 'Ez egy régebbi verzió: megnézni lehet, szerkeszteni a legfrissebbet lehet.',
    en: 'This is an older version: you can look at it; editing works on the latest one.',
  },
  version_stale: {
    hu: 'Közben új verzió készült ebből a munkadarabból, ezért nem írom felül. Másold ki, amit írtál, nyisd meg újra a munkadarabot, és csináld meg rajta újra a módosítást.',
    en: 'A newer version of this work item was made in the meantime, so it will not be overwritten. Copy what you wrote, open the work item again and redo the change on it.',
  },
  image_edit_stale: {
    hu: 'Közben új verzió készült ebből a képből, ezért nem írom felül. Zárd be a szerkesztőt, nyisd meg újra, és csináld meg rajta újra a módosítást.',
    en: 'A newer version of this image was made in the meantime, so it will not be overwritten. Close the editor, open it again and redo the change on it.',
  },
  post_bad_platform: {
    hu: 'Ismeretlen platform-méret. Válassz egyet a poszt-előnézet listájából.',
    en: 'Unknown platform size. Choose one from the post preview list.',
  },
  post_not_image: {
    hu: 'A mentendő tartalom nem PNG vagy JPEG kép, ezért nem mentem el.',
    en: 'The content to save is not a PNG or JPEG image, so it was not saved.',
  },
  post_wrong_size: {
    hu: 'A kép mérete nem egyezik a választott platforméval, ezért nem mentem el. Próbáld újra a poszt-előnézetből.',
    en: 'The image size does not match the chosen platform, so it was not saved. Try again from the post preview.',
  },
  post_too_large: {
    hu: 'A kép túl nagy a mentéshez (legfeljebb 30 MB). Próbáld JPG-ben.',
    en: 'The image is too large to save (at most 30 MB). Try JPG.',
  },
  post_empty: {
    hu: 'A mentendő kép üres volt. Próbáld újra.',
    en: 'The image to save was empty. Try again.',
  },
  image_edit_not_image: {
    hu: 'A mentendő tartalom nem PNG, JPEG vagy WebP kép, ezért nem mentem el.',
    en: 'The content to save is not a PNG, JPEG or WebP image, so it was not saved.',
  },
  image_edit_unsupported: {
    hu: 'Ennek a munkadarabnak a forrása nem kép, ezért itt nem szerkeszthető képként.',
    en: 'The source of this work item is not an image, so it cannot be edited as an image here.',
  },
  video_stale: {
    hu: 'Közben új verzió készült ebből a videóból, ezért nem mentem el. Nyisd meg újra a munkadarabot, és próbáld újra.',
    en: 'A newer version of this video was made in the meantime, so it was not saved. Open the work item again and try again.',
  },
  video_not_video: {
    hu: 'Ennek a munkadarabnak a forrása nem videó, ezért itt nem vágható.',
    en: 'The source of this work item is not a video, so it cannot be cut here.',
  },
  video_bad_time: {
    hu: 'Az időpont nem jó. Írd be így: 0:05 (perc:másodperc) vagy 5 (másodperc); a vége legyen később, mint az eleje.',
    en: 'The time is not right. Type it like 0:05 (minutes:seconds) or 5 (seconds); the end must come after the start.',
  },
  video_no_ffmpeg: {
    hu: 'A vágáshoz és a képkocka mentéséhez az FFmpeg nevű ingyenes program kell, és ezen a gépen nincs meg. A lejátszás enélkül is működik. A Képességek panelen leírom, hogyan teheted fel.',
    en: 'Cutting and saving a frame need a free program called FFmpeg, and this computer does not have it. Playback works without it. The Capabilities panel explains how to install it.',
  },
  video_ffmpeg_check_failed: {
    hu: 'Az FFmpeg-et nem tudtam elindítani, ezért most nem tudok vágni. Nézd meg a Képességek panelen, mi a baj vele.',
    en: 'FFmpeg could not be started, so cutting is not possible right now. Check the Capabilities panel to see what is wrong with it.',
  },
  video_busy: {
    hu: 'Ezen a videón már fut egy vágás. Várd meg, amíg elkészül.',
    en: 'A cut is already running on this video. Wait until it finishes.',
  },
  video_failed: {
    hu: 'Az FFmpeg nem tudta elkészíteni a fájlt, ezért nem készült új verzió. A pontos hibaüzenet lent látszik.',
    en: 'FFmpeg could not make the file, so no new version was made. The exact error is shown below.',
  },
  video_timeout: {
    hu: 'A vágás túl sokáig tartott, ezért leállítottam; nem készült új verzió. Próbálj rövidebb részt vágni.',
    en: 'The cut took too long, so it was stopped; no new version was made. Try cutting a shorter part.',
  },
  video_no_output: {
    hu: 'Nem készült fájl. Lehet, hogy az időpont a videó vége után van.',
    en: 'No file was made. The time may be after the end of the video.',
  },
  table_title_required: {
    hu: 'Adj nevet az új táblázatnak.',
    en: 'Give the new table a name.',
  },
  capability_saved: {
    hu: 'Elmentve, és azonnal újra megmértem.',
    en: 'Saved, and measured again right away.',
  },
}

/** Kozben keszult-e ujabb verzio? (#406 bugkereses 6+7.) A route elejen
 *  betoltott `item` az `await readJson/readBody` ELOTTI pillanatkep: ket
 *  egyszerre mento ful kozul a masodik azzal meg atmenne, es az elso modositasa
 *  csendben kiesne. Ezert az await UTAN a DB-bol ujraolvassuk. Az ellenorzes
 *  es a mentes kozott nincs tobb await, tehat nincs kozbeekelodes. */
function versionIsStale(itemId: string, base: unknown): boolean {
  const fresh = getWorkItem(itemId)
  return !fresh || String(base ?? '') !== (fresh.current_version_id || '')
}

/** Ahol a `base_version` nem kotelezo: ha a kliens kuldi, szamon kerjuk; ha
 *  nem (regebbi felulet, API-hivo), a korabbi viselkedes marad. */
function optionalBaseIsStale(itemId: string, base: unknown): boolean {
  if (base == null || base === '') return false
  return versionIsStale(itemId, base)
}

/** Gepi kod -> EMBERI mondat. Ismeretlen kodnal a kodot adjuk vissza, hogy
 *  soha ne legyen ures a mondat (az ures uzenet rosszabb a nyers kodnal). */
/**
 * A munkadarab anyagai a felulet szamara: a mappa friss allapotaval, es az
 * iratok (PDF, irodai fajl, fotozott irat, e-mail) olvasasi allapotaval. A meg
 * nem olvasott iratok feldolgozasa itt indul el, a hatterben (1/A, K-1.1).
 */
function assetsOut(itemId: string): ReturnType<typeof withDocState> {
  const list = listWorkItemAssetsSynced(itemId)
  try { startPendingDocReads(list) } catch { /* a lista akkor is jojjon */ }
  return withDocState(list)
}

/** A munkadarab dokumentummodellje a veglegesites elotti ellenorzessel, vagy null, ha nincs. */
type OutlineOut = ReturnType<typeof documentOutline> & {
  check: ReturnType<typeof documentCheck>
  consistency: ReturnType<typeof consistencyIssues>
  annexes: ReturnType<typeof listAnnexes>
  settings: ReturnType<typeof docSettings> & { schemes: typeof ANNEX_SCHEMES; modes: typeof ANNEX_MODES }
} & Partial<ReturnType<typeof finalizationState>>

/**
 * A celbirosag-allapot. `check_current`: az utolso ellenorzes a mostani vegleges
 * valtozat fajljain futott; `rules_current`: es a profil ma ervenyes szabalyverzioja
 * szerint (ha azota uj verziot fogadtal el, ujra kell ellenorizni).
 */
function courtOut(itemId: string): ReturnType<typeof itemCourtState> & { check_current: boolean; rules_current: boolean } {
  const st = itemCourtState(itemId)
  const f = listFinals(itemId)[0]
  const check_current = !!st.check && !!f && st.check.version_id === f.version_id && st.check.result.profile_id === st.profile_id
  return { ...st, check_current, rules_current: check_current && !!st.profile && st.check!.result.version === st.profile.version }
}

function outlineOut(itemId: string): OutlineOut | null {
  if (!hasDocModel(itemId)) return null
  const item = getWorkItem(itemId)
  const resolve = item ? resolverFor(item) : undefined
  return {
    ...documentOutline(itemId),
    check: documentCheck(itemId, resolve),
    consistency: consistencyIssues(itemId),
    annexes: listAnnexes(itemId, resolve),
    settings: { ...docSettings(itemId), schemes: ANNEX_SCHEMES, modes: ANNEX_MODES },
    ...(item ? finalizationState(item) : {}),
    ...(item ? langOut(item) : {}),
  }
}

/** NYELVI VALTOZATOK (K-1.27 ... K-1.31): az eredetinel a valtozatai, a valtozatnal a fejezetek allapota, a szoszedet, a visszaforditasok. */
function langOut(item: { id: string; project_id: string }): { variant: ReturnType<typeof variantInfo>; variants: ReturnType<typeof variantsSummary>; glossary: ReturnType<typeof listGlossary>; backchecks: ReturnType<typeof backchecks> } {
  const variant = variantInfo(item.id)
  return { variant, variants: variant ? [] : variantsSummary(item.id), glossary: listGlossary(item.project_id), backchecks: variant ? backchecks(item.id) : [] }
}

/** A vazlat valasza akkor is, ha meg nincs fejezet (ures vazlat + ellenorzes). */
function outlineOrEmpty(itemId: string): NonNullable<ReturnType<typeof outlineOut>> | { sections: never[]; check: ReturnType<typeof documentCheck> } {
  const item = getWorkItem(itemId)
  return outlineOut(itemId) ?? { sections: [], check: documentCheck(itemId, item ? resolverFor(item) : undefined) }
}

/** Egy PDF-keszitesi hiba kodja a felhasznalonak (a LibreOffice-hiany kulon mondat). */
function docPdfCode(code: string): string {
  if (/^(annex_missing|annex_unsupported|annex_convert_failed|merge_not_installed|merge_failed)$/.test(code)) return 'docpdf_' + code
  return code === 'not_installed' ? 'docpdf_not_installed'
    : code === 'check_failed' ? 'docpdf_check_failed'
    : code === 'timeout' ? 'docpdf_timeout' : 'docpdf_failed'
}

function docPdfStatus(code: string): number {
  return code === 'docpdf_not_installed' || code === 'docpdf_check_failed' || code === 'docpdf_merge_not_installed' ? 501
    : code === 'docpdf_timeout' ? 504
    : code === 'docpdf_annex_missing' || code === 'docpdf_annex_unsupported' ? 409 : 500
}

/** PDF-keszitesi hiba valasza: emberi mondat (a melleklet jelevel, ha arrol szol) + a valodi hibauzenet. */
function docPdfFail(res: RouteContext['res'], raw: string, lang: 'hu' | 'en', detail: string | null, label?: string, extra: Record<string, unknown> = {}): true {
  const code = docPdfCode(raw)
  json(res, { error: code, message: msg(code, lang).replace('{label}', label || '?'), detail: detail || null, ...extra }, docPdfStatus(code))
  return true
}

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

/** Az atalakito (LibreOffice / Poppler) hibaja a dokumentum-szerkesztonel
 *  (#444): a kodot a MERES adja, a `detail` a valodi hibauzenet. */
function docEditFail(res: RouteContext['res'], r: { code: string; detail: string | null }, lang: 'hu' | 'en'): true {
  const status = r.code === 'not_installed' || r.code === 'check_failed' ? 501 : r.code === 'timeout' ? 504 : 500
  return failDetail(res, status, 'docedit_' + r.code, lang, r.detail)
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
/** A tulajdonos sajat kattintasa: bejelentkezett dashboard-munkamenet. Ugynok
 *  (token), federacios tars, eszkozkulcs NEM az -- azok jovahagyasra mennek. */
function isOwnerClick(ctx: RouteContext): boolean {
  return ctx.auth?.kind === 'session'
}

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
  // #461: work item snapshot files. Status for the settings line; the owner's button rebuilds missing items.
  if (path === '/api/workbench/snapshot/status' && method === 'GET') {
    json(res, snapshotStatus())
    return true
  }
  if (path === '/api/workbench/snapshot/restore' && method === 'POST') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    sweepSnapshots({ force: true }) // first save what is there, so a rebuild never races a stale file
    const r = restoreFromFolders({ adoptOrphans: body['adopt_orphans'] === true, deep: body['deep'] === true })
    json(res, { ok: true, ...r })
    return true
  }

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
  // KANBAN (TG 1836 B): the work items on the Kanban board and the project
  // Kanban tab too, framed as work items. `project` is optional.
  if (path === '/api/workbench/board-items' && method === 'GET') {
    json(res, { items: listBoardWorkItems(url.searchParams.get('project')) })
    return true
  }

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

  // ATADOCSOMAG (#406, 12. pont): elobb a terv (mi kerul bele, mi hianyzik),
  // utana a letoltes. Semmi nem irodik a lemezre, semmi nem megy ki sehova.
  if ((path === '/api/workbench/handoff' || path === '/api/workbench/handoff/download') && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const scope = url.searchParams.get('scope') || 'done'
    if (!isHandoffScope(scope)) return fail(res, 400, 'handoff_bad_scope', lang)
    if (!getProject(pid)) return fail(res, 404, 'project_not_found', lang)
    if (path === '/api/workbench/handoff') {
      json(res, { plan: planHandoff(pid, scope), max_bytes: HANDOFF_MAX_BYTES })
      return true
    }
    const r = buildHandoffZip(pid, scope, lang)
    if (!r.ok) return fail(res, r.code === 'project_not_found' ? 404 : r.code === 'handoff_too_large' ? 413 : 409, r.code, lang)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDispositionHeader(r.filename, 'attachment'),
      'Content-Length': r.zip.length,
      'Cache-Control': 'private, no-store',
    })
    res.end(r.zip)
    return true
  }

  // HETI OSSZEFOGLALO (#406, 13. pont): a folyo het elo + a mentett hetek.
  // A megnyitas maga potolja a hianyzo mult heti osszefoglalot.
  if (path === '/api/workbench/weekly' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const now = Math.floor(Date.now() / 1000)
    let ensured: string
    try { ensured = ensureLastWeekSummary(project.id, now) } catch { ensured = 'failed' }
    json(res, {
      current: currentWeekSummary(project.id, now),
      weeks: listWeeklySummaries(project.id),
      last_week: ensured,
    })
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

  // BRAND KIT (v4 spec K-4.1..K-4.3): one brand per project. The check only
  // reads the drawing and lists deviations; it never changes it.
  if (path === '/api/workbench/brand' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    // Three states, kept apart: nothing stored yet, a brand, and a stored brand
    // that cannot be read (the panel then says so, and saving replaces it).
    let brand: ReturnType<typeof getBrand> = null
    let unreadable = false
    try { brand = getBrand(project.id) } catch (e) {
      if (!(e instanceof BrandUnreadableError)) return fail(res, 500, 'brand_read_failed', lang)
      unreadable = true
    }
    json(res, {
      brand: brand ?? { ...emptyBrand(), project_id: project.id, updated_at: 0 },
      exists: brand != null || unreadable,
      unreadable,
      // K-4.1: the drawings saved as the brand's templates (kept apart from the brand row).
      templates: listBrandTemplates(project.id),
      limits: {
        max_colors: BRAND_MAX_COLORS, max_notes: BRAND_MAX_NOTES, note_max_chars: BRAND_NOTE_MAX_CHARS, fonts: BRAND_FONTS, corners: LOGO_CORNERS,
        max_templates: BRAND_MAX_TEMPLATES, template_name_max: BRAND_TEMPLATE_NAME_MAX,
      },
    })
    return true
  }
  if (path === '/api/workbench/brand' && method === 'PUT') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const pid = typeof body['project'] === 'string' ? body['project'].trim() : ''
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = saveBrand(project.id, body['brand'])
    if (!r.ok) return fail(res, 400, 'brand_' + r.code, lang)
    json(res, { brand: r.brand })
    return true
  }
  if (path === '/api/workbench/brand/check' && method === 'GET') {
    const it = getWorkItem((url.searchParams.get('item') || '').trim())
    if (!it) return fail(res, 404, 'brand_item_not_found', lang)
    let brand: ReturnType<typeof getBrand>
    try { brand = getBrand(it.project_id) } catch (e) {
      return fail(res, 500, e instanceof BrandUnreadableError ? 'brand_unreadable' : 'brand_read_failed', lang)
    }
    const c = readCanvas(it.id)
    if (!c.ok) return failDetail(res, c.code === 'not_found' ? 404 : 409, c.code, lang, c.detail)
    const findings = c.exists ? checkCanvasBrand(c.doc, brand, getProject(it.project_id)?.folder_path) : []
    json(res, {
      // A saved but empty brand has nothing to compare with: "no deviations" would be a false all-clear.
      has_brand: brand != null && !brandIsEmpty(brand),
      has_canvas: c.exists,
      findings: findings.map((f) => ({ code: f.code, object: f.object, message: f.message[lang] })),
    })
    return true
  }

  // BRAND TEMPLATES (K-4.1): a drawing saved as the starting point of the next ones.
  //   POST   /api/workbench/brand/templates {item, name, replace}   -- the drawing of a work item becomes a template
  //   POST   /api/workbench/brand/templates/<id>/use {project, title} -- a new drawing (work item) from the template
  //   DELETE /api/workbench/brand/templates/<id>?project=             -- the template goes, the drawings made from it stay
  // The list itself comes with GET /api/workbench/brand.
  const brandTemplateFail = (code: string, detail: string | null): true => {
    const own = code.startsWith('template_') || code === 'too_many_templates'
    const status = code === 'template_not_found' || code === 'not_found' ? 404 : code === 'template_failed' ? 500
      : code === 'template_name_required' || code === 'template_name_too_long' || code === 'title_too_long' ? 400 : 409
    return failDetail(res, status, own ? 'brand_' + code : code, lang, detail)
  }
  if (path === '/api/workbench/brand/templates' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const it = getWorkItem(typeof body['item'] === 'string' ? body['item'].trim() : '')
    if (!it) return fail(res, 404, 'brand_template_item_not_found', lang)
    const project = getProject(it.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = brandTemplateFromItem(it, body['name'], { replace: body['replace'] === true, createdBy: actor(ctx) })
    if (!r.ok) return brandTemplateFail(r.code, r.detail)
    json(res, { ok: true, template: r.template, replaced: r.replaced, templates: listBrandTemplates(project.id) }, r.replaced ? 200 : 201)
    return true
  }
  const brandTemplateMatch = path.match(/^\/api\/workbench\/brand\/templates\/([^/]+)(\/use)?$/)
  if (brandTemplateMatch && (brandTemplateMatch[2] ? method === 'POST' : method === 'DELETE')) {
    const body = brandTemplateMatch[2] ? await readJson(req) : {}
    if (!body) return fail(res, 400, 'bad_json', lang)
    const rawPid = brandTemplateMatch[2] ? body['project'] : url.searchParams.get('project')
    const pid = typeof rawPid === 'string' ? rawPid.trim() : ''
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const templateId = decodeURIComponent(brandTemplateMatch[1])
    if (!brandTemplateMatch[2]) {
      if (!deleteBrandTemplate(project.id, templateId)) return fail(res, 404, 'brand_template_not_found', lang)
      json(res, { ok: true, templates: listBrandTemplates(project.id) })
      return true
    }
    const r = createFromBrandTemplate(project, templateId, { title: body['title'], createdBy: actor(ctx), source: 'owner' })
    if (!r.ok) return brandTemplateFail(r.code, r.detail)
    json(res, { ok: true, item: r.item, versions: [r.version], template: r.template }, 201)
    return true
  }

  // KIS TEENDOK HATARIDOVEL (#406, 14. pont). Naptar: szabvanyos .ics fajl,
  // amit barmely naptar felvesz -- semmi nem megy ki a geprol magatol.
  if (path === '/api/workbench/todos' && method === 'GET') {
    // Ha kozben dontottek egy naptar-jegyrol, a lista mar a kimenetelt mutassa.
    try { await settleTodoCalendarApprovals() } catch { /* a lista ettol meg jon */ }
    const itemId = (url.searchParams.get('item') || '').trim()
    if (itemId) {
      const it = getWorkItem(itemId)
      if (!it) return fail(res, 404, 'todo_item_not_found', lang)
      json(res, { todos: listItemTodos(it.id), max_chars: TODO_TEXT_MAX })
      return true
    }
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    json(res, { todos: listProjectTodos(project.id), max_chars: TODO_TEXT_MAX })
    return true
  }
  // TEENDO-EMLEKEZTETO (#406, otlet a5ecabbe): beallitas + allapot + proba.
  // Csak a tulajdonos SAJAT csatornajara megy, masnak soha.
  if (path === '/api/workbench/todo-reminder' && method === 'GET') {
    json(res, { reminder: getReminderStatus() })
    return true
  }
  if (path === '/api/workbench/todo-reminder' && method === 'PUT') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const r = setReminderSettings({
      enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : undefined,
      days_before: 'days_before' in body ? body['days_before'] : undefined,
      time: 'time' in body ? body['time'] : undefined,
    })
    if (!r.ok) return fail(res, 400, 'todo_reminder_' + r.code, lang)
    json(res, { reminder: getReminderStatus() })
    return true
  }
  if (path === '/api/workbench/todo-reminder/test' && method === 'POST') {
    const text = lang === 'en'
      ? 'Test: this is where Marveen will remind you of the Workbench to-dos before their due date.'
      : 'Próba: ide fog szólni a Marveen a Munkapad teendőiről a határidő előtt.'
    let outcome: 'sent' | 'no_channel'
    try { outcome = await sendOwnerChannelChecked(text) } catch (err) {
      return failDetail(res, 502, 'todo_reminder_send_failed', lang, (err instanceof Error ? err.message : String(err)).slice(0, 200))
    }
    if (outcome === 'no_channel') return fail(res, 409, 'todo_reminder_no_channel', lang)
    json(res, { ok: true })
    return true
  }
  if (path === '/api/workbench/todos' && method === 'POST') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const it = typeof body['item_id'] === 'string' ? getWorkItem(body['item_id']) : undefined
    if (!it) return fail(res, 404, 'todo_item_not_found', lang)
    const project = getProject(it.project_id)
    if (project && project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = addTodo({ work_item_id: it.id, text: body['text'], due_date: body['due_date'], repeat: body['repeat'], by: actor(ctx), source: 'owner' })
    if (!r.ok) return fail(res, r.code === 'too_many' ? 409 : r.code === 'item_not_found' ? 404 : 400, 'todo_' + r.code, lang)
    json(res, { todo: r.todo, todos: listItemTodos(it.id) })
    return true
  }
  // BETEKINTO LINK (#406, 18. pont): letrehozas a `permission_change` kapun
  // at -- a tulajdonos sajat kattintasa azonnal el (kiveve az 1-es "csak
  // jelez" szintet) --, visszavonas azonnal. A nyilvanos lap a `workbench-share-view.ts`-ben.
  if (path === '/api/workbench/shares' && method === 'GET') {
    const project = getProject(String(url.searchParams.get('project') || ''))
    if (!project) return fail(res, 404, 'share_project_not_found', lang)
    try { settleShareApprovals() } catch { /* a lista akkor is jojjon */ }
    json(res, { shares: listProjectShares(project.id), public_base: DASHBOARD_PUBLIC_URL ? DASHBOARD_PUBLIC_URL.replace(/\/$/, '') : null })
    return true
  }
  if (path === '/api/workbench/shares' && method === 'POST') {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const r = requestShare({
      kind: body['kind'], project_id: body['project'], work_item_id: body['item_id'], scope: body['scope'], days: body['days'],
      lang: lang === 'en' ? 'en' : 'hu', actor: actor(ctx), owner: isOwnerClick(ctx),
    })
    if (!r.ok) {
      if (r.code === 'project_archived') return fail(res, 409, 'project_archived', lang)
      if (r.code === 'blocked') return fail(res, 403, 'share_blocked', lang)
      return fail(res, r.code.endsWith('not_found') ? 404 : 400, 'share_' + r.code, lang)
    }
    json(res, { state: r.state, share: r.share, shares: listProjectShares(r.share.project_id) })
    return true
  }
  const shareRevoke = path.match(/^\/api\/workbench\/shares\/([^/]+)\/revoke$/)
  if (shareRevoke && method === 'POST') {
    const had = getShare(decodeURIComponent(shareRevoke[1]))
    if (!had) return fail(res, 404, 'share_not_found', lang)
    revokeShare(had.id)
    json(res, { shares: listProjectShares(had.project_id) })
    return true
  }
  // VIDEOMUNKA (#406, 19. pont): van-e FFmpeg. A lejatszashoz nem kell.
  // The video, audio and picture files in a project folder: what the timeline pickers offer.
  if (path === '/api/workbench/media' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const r = listProjectMedia(project)
    if (!r.ok) return failDetail(res, 409, 'timeline_no_folder', lang, r.detail || null)
    json(res, { files: r.files, truncated: r.truncated })
    return true
  }
  if (path === '/api/workbench/video-status' && method === 'GET') {
    const st = await videoToolStatus()
    json(res, { video: { state: st.state, message: st.state === 'ok' ? null : msg(st.state === 'check_failed' ? 'video_ffmpeg_check_failed' : 'video_no_ffmpeg', lang), detail: st.detail } })
    return true
  }
  // GOOGLE NAPTAR (#406, 14. pont B): csak a tulajdonos kattintasara,
  // teendonkent, a `calendar_write` jovahagyasi kapun at.
  // A PROJEKT "Erzekeny" jelolese (#441, K-1.32): minden munkadarabjara all.
  if (path === '/api/workbench/privacy' && (method === 'GET' || method === 'PUT')) {
    const pid = (url.searchParams.get('project') || '').trim()
    const project = pid ? getProject(pid) : undefined
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (method === 'PUT') {
      const body = await readJson(req)
      if (!body || typeof body['sensitive'] !== 'boolean') return fail(res, 400, 'privacy_bad_input', lang)
      if (body['sensitive'] === false && !isOwnerClick(ctx)) return fail(res, 403, 'privacy_owner_only', lang)
      setProjectSensitive(project.id, body['sensitive'] === true, actor(ctx))
    }
    json(res, { ok: true, privacy: privacyState(project.id, null), sensitive_items: sensitiveItemIds(project.id) })
    return true
  }
  if (path === '/api/workbench/gcal-status' && method === 'GET') {
    json(res, { gcal: gcalStatus() })
    return true
  }
  const gcalMatch = path.match(/^\/api\/workbench\/todos\/([^/]+)\/gcal$/)
  if (gcalMatch && method === 'POST') {
    const td = getTodo(decodeURIComponent(gcalMatch[1]))
    if (!td) return fail(res, 404, 'todo_not_found', lang)
    const project = getProject(td.project_id)
    if (project && project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = await requestTodoCalendar(td.id, lang === 'en' ? 'en' : 'hu', actor(ctx))
    if (!r.ok) {
      if (r.code === 'not_found') return fail(res, 404, 'todo_not_found', lang)
      if (r.code === 'no_due') return fail(res, 409, 'todo_no_due', lang)
      if (r.code === 'blocked') return fail(res, 403, 'todo_gcal_blocked', lang)
      if (r.code === 'failed') return failDetail(res, 502, 'todo_gcal_failed', lang, (r.detail || '').slice(0, 300))
      return fail(res, r.code === 'check_failed' ? 503 : 409, 'todo_gcal_' + r.code, lang)
    }
    json(res, { state: r.state, approval_id: r.state === 'pending' ? r.approval_id : null, todo: getTodo(td.id), todos: listItemTodos(td.work_item_id) })
    return true
  }
  const todoIcsAll = path === '/api/workbench/todos/ics' && method === 'GET'
  const todoMatch = path.match(/^\/api\/workbench\/todos\/([^/]+)(\/ics)?$/)
  if (todoIcsAll || (todoMatch && method === 'GET' && todoMatch[2])) {
    let rows: { id: string; text: string; due_date: string | null; item_title: string }[]
    let projectName: string
    let fileBase: string
    if (todoIcsAll) {
      const project = getProject((url.searchParams.get('project') || '').trim())
      if (!project) return fail(res, 404, 'project_not_found', lang)
      rows = listProjectTodos(project.id).filter((x) => x.due_date && x.done_at == null)
      if (!rows.length) return fail(res, 409, 'todo_none_due', lang)
      projectName = project.name
      fileBase = project.name
    } else {
      const td = getTodo(decodeURIComponent(todoMatch![1]))
      if (!td) return fail(res, 404, 'todo_not_found', lang)
      if (!td.due_date) return fail(res, 409, 'todo_no_due', lang)
      const it = getWorkItem(td.work_item_id)
      const project = getProject(td.project_id)
      rows = [{ ...td, item_title: it ? it.title : '' }]
      projectName = project ? project.name : ''
      fileBase = td.text.slice(0, 40)
    }
    const ics = Buffer.from(todosToIcs(rows, projectName, lang === 'en' ? 'en' : 'hu'), 'utf-8')
    const name = (fileBase.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim() || 'teendo') + '.ics'
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': contentDispositionHeader(name, 'attachment'),
      'Content-Length': ics.length,
      'Cache-Control': 'private, no-store',
    })
    res.end(ics)
    return true
  }
  if (todoMatch && !todoMatch[2] && (method === 'PATCH' || method === 'DELETE')) {
    const td = getTodo(decodeURIComponent(todoMatch[1]))
    if (!td) return fail(res, 404, 'todo_not_found', lang)
    const project = getProject(td.project_id)
    if (project && project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    if (method === 'DELETE') {
      deleteTodo(td.id)
      json(res, { ok: true, todos: listItemTodos(td.work_item_id) })
      return true
    }
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    const r = updateTodo(td.id, {
      text: 'text' in body ? body['text'] : undefined,
      due_date: 'due_date' in body ? (body['due_date'] ?? '') : undefined,
      done: typeof body['done'] === 'boolean' ? body['done'] : undefined,
      repeat: 'repeat' in body ? (body['repeat'] ?? '') : undefined,
    })
    if (!r.ok) return fail(res, r.code === 'not_found' ? 404 : 400, 'todo_' + r.code, lang)
    json(res, { todo: r.todo, next: r.next, todos: listItemTodos(td.work_item_id) })
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

  // A PROJEKT KOZOS TARA (#441, v4 spec K-0.19): a logo, a markaelemek egyszer
  // vannak meg a projektben; a munkadarabhoz csak hivatkozaskent kerulnek
  // (POST .../items/<id>/assets/link), masolat nem keszul.
  //   GET  /api/workbench/shared?project=<id>               -- a kozos tar fajljai
  //   POST /api/workbench/shared?project=<id>&name=...      -- egy fajl (nyers bajtok); `force=1`: ugyanaz a tartalom ujra
  if (path === '/api/workbench/shared' && (method === 'GET' || method === 'POST')) {
    const project = getProject((url.searchParams.get('project') || '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (method === 'GET') {
      json(res, listSharedFiles(project))
      return true
    }
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
    const r = uploadSharedFile(project, url.searchParams.get('name') || '', data, {
      force: url.searchParams.get('force') === '1', lang,
    })
    if (!r.ok) {
      if (r.code === 'shared_duplicate') {
        json(res, { error: r.code, message: msg(r.code, lang), existing: r.existing }, 409)
        return true
      }
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      const status = r.code === 'write_failed' ? 500 : r.code === 'not_found' ? 404 : 400
      return failDetail(res, status, code, lang, 'message' in r ? (r.message || null) : null)
    }
    json(res, { ok: true, file: r.file, renamed: r.renamed, ...listSharedFiles(project) }, 201)
    return true
  }

  // MAPPA MEGNYITASA (#443, Boss 2026-09-29): az Anyagok, a Kozos tar, a
  // Verziok es egy anyag-sor mappaja egy gombnyomassal -- az Intezoben (a
  // valasz a mappa raktar-relativ utja, a felulet oda lep), vagy a gep sajat
  // fajlkezelojeben (Windows Explorer / Finder / asztali fajlkezelo).
  //   GET  /api/workbench/file-manager  -- {kind}: melyik fajlkezelo erheto el
  //   POST /api/workbench/open-folder   -- {project, item?, place, asset?, app: 'intezo'|'system'}
  if (path === '/api/workbench/file-manager' && method === 'GET') {
    json(res, { kind: fileManagerKind() })
    return true
  }
  if (path === '/api/workbench/open-folder' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const project = getProject(String(body['project'] ?? '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const itemId = String(body['item'] ?? '').trim()
    const item = itemId ? (getWorkItem(itemId) ?? null) : null
    if (itemId && !item) return fail(res, 404, 'not_found', lang)
    const r = workbenchPlace(project, item, body['place'], body['asset'])
    if (!r.ok) return fail(res, r.code === 'bad_place' ? 400 : 404, r.code, lang)
    if (body['app'] === 'system') {
      const o = await openInFileManager(r.abs)
      if (!o.ok) return fail(res, o.code === 'not_found' ? 404 : o.code === 'no_file_manager' ? 409 : 500, 'open_' + o.code, lang)
      json(res, { ok: true, path: r.dirRel })
      return true
    }
    json(res, { ok: true, path: r.dirRel, select: r.select, project: { id: project.id, name: project.name } })
    return true
  }

  // #454: a new folder inside the project's work items box (the picker's "New folder").
  // Ketnyelvu fordito (#467): ugyanaz a motor, mint az e-mail fordito (kulcs, gyorsitotar, nyelvlista) --
  // csak nem levelhez kotott. A hosszu szoveg bekezdes-hatarokon darabolodik (a modell valasza korlatos).
  if (path === '/api/workbench/translate' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const text = String(body['text'] ?? '')
    if (!text.trim()) return fail(res, 400, 'translate_empty', lang)
    if (text.length > 30_000) return fail(res, 413, 'translate_too_long', lang)
    const apiKey = getSecret('openrouter-fleet-key')
    if (!apiKey) return fail(res, 503, 'translate_no_key', lang)
    const targetLang = resolveTargetLang(String(body['target_lang'] ?? ''))
    const sourceLang = String(body['source_lang'] ?? 'auto')
    const pieces: string[] = []
    let cur = ''
    for (const para of text.split(/\n{2,}/)) {
      if (cur && cur.length + para.length > 3000) { pieces.push(cur); cur = para } else cur = cur ? cur + '\n\n' + para : para
    }
    if (cur.trim()) pieces.push(cur)
    const out: string[] = []
    let detected = 'unknown'
    let allCached = true
    for (const piece of pieces) {
      const r = await translateEmailContent(piece, '', apiKey, { targetLang, sourceLang })
      if (r.translation.startsWith(TRANSLATION_FAILED_MARKER)) return fail(res, 502, 'translate_failed', lang)
      if (detected === 'unknown' && r.sourceLang !== 'unknown') detected = r.sourceLang
      if (!r.fromCache) allCached = false
      out.push(r.translation)
    }
    json(res, { translation: out.join('\n\n'), source_lang: detected, target_lang: targetLang, from_cache: allCached, langs: Object.keys(SUPPORTED_TRANSLATION_LANGS) })
    return true
  }

  if (path === '/api/workbench/folders' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const project = getProject(String(body.project_id ?? '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = makeWorkFolder(project, body.parent, body.name)
    if (!r.ok) return failDetail(res, r.code === 'write_failed' ? 500 : 400, r.code === 'folder_name' ? 'bad_folder_name' : r.code, lang, r.message || null)
    json(res, { ok: true, folder: r.folder, created: r.created, work_folders: listWorkFolders(project) }, 201)
    return true
  }

  // Rename a plain folder of the box (never one a work item lives in: its paths are in the registry).
  if (path === '/api/workbench/folders/rename' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const project = getProject(String(body.project_id ?? '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = renameWorkFolder(project, body.folder, body.name)
    if (!r.ok) {
      const code = r.code === 'folder_name' ? 'bad_folder_name' : r.code === 'folder_is_box' ? 'folder_box_rename' : r.code === 'no_box' ? 'folder_gone' : r.code
      return failDetail(res, r.code === 'write_failed' ? 500 : r.code === 'folder_exists' || r.code === 'folder_has_items' ? 409 : 400, code, lang, r.message || null)
    }
    json(res, { ok: true, folder: r.folder, renamed: r.renamed, item: r.item ?? null, items: listWorkItems(project.id), work_folders: listWorkFolders(project) })
    return true
  }

  // A folder is deleted only when empty (no file, no subfolder, no work item in it): nothing goes with it.
  if (path === '/api/workbench/folders' && method === 'DELETE') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const project = getProject(String(body.project_id ?? '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = deleteWorkFolder(project, body.folder)
    if (!r.ok) {
      if (r.code === 'folder_not_empty') {
        const n = { items: r.items ?? 0, files: r.files ?? 0, folders: r.folders ?? 0 }
        const parts = (l: 'hu' | 'en'): string => [
          n.items ? (l === 'hu' ? `${n.items} munkadarab` : `${n.items} work item(s)`) : '',
          n.files ? (l === 'hu' ? `${n.files} fájl` : `${n.files} file(s)`) : '',
          n.folders ? (l === 'hu' ? `${n.folders} almappa` : `${n.folders} subfolder(s)`) : '',
        ].filter(Boolean).join(', ')
        const text = lang === 'en'
          ? `This folder is not empty (${parts('en') || 'something is still in it'}). Move or delete those first, then the folder can go.`
          : `Ez a mappa nem üres (${parts('hu') || 'van még benne valami'}). Előbb tedd át vagy töröld őket, utána törölhető a mappa.`
        json(res, { error: 'folder_not_empty', message: text, ...n }, 409)
        return true
      }
      return fail(res, r.code === 'write_failed' ? 500 : 400, r.code === 'no_box' ? 'folder_gone' : r.code, lang)
    }
    json(res, { ok: true, folder: r.folder, work_folders: listWorkFolders(project) })
    return true
  }

  // BELEPO (#441, K-3.1): "Mit szeretnel letrehozni?" -- egy mondat vagy egy
  // gomb. `kind` nelkul a mondatbol talaljuk ki a munkatipust; ha nem biztos,
  // NEM hozunk letre semmit, hanem visszakerdezunk (`ask`), a lehetseges
  // tipusokkal. A mondatot a felulet utana az Agentnek adja at.
  if (path === '/api/workbench/intake' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const project = getProject(String(body['project_id'] ?? '').trim())
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const text = String(body['text'] ?? '').trim().slice(0, 4000)
    let kind = String(body['kind'] ?? '') as IntakeKindAny
    if (!(INTAKE_KINDS as readonly string[]).includes(kind)) {
      if (!text) return fail(res, 400, 'intake_empty', lang)
      const g = guessIntakeKind(text)
      if (!g.sure) {
        json(res, { ok: true, ask: true, options: g.options, message: msg(g.options.length === INTAKE_KINDS.length ? 'intake_ask_all' : 'intake_ask', lang) })
        return true
      }
      kind = g.kind
    }
    // The folder picked in step 1 ('' = the default box).
    let intakeFolder: string | null = null
    if (String(body['folder'] ?? '').trim()) {
      const c = workFolderTarget(project, body['folder'])
      if (!c.ok) return fail(res, 400, c.code === 'no_box' ? 'folder_gone' : c.code, lang)
      intakeFolder = c.folder
    }
    // Step 2 needs step 1: nothing is filed into a folder nobody chose, and no folder is made on the side.
    if (!intakeFolder && projectFileTarget(project, '').ok) return fail(res, 400, 'folder_required', lang)
    const title = String(body['title'] ?? '').trim().slice(0, 200) || intakeTitle(text, kind, lang)
    // A jegyzet (md) kerese: a munkadarab SAJAT .md fajlt kap a mappajaban, es ez a tartalma --
    // az ugynok ebbe ir, a jobb oldal ezt mutatja. (Nincs projektmappa -> fajl nelkul, mint eddig.)
    let noteFile: { rel: string; name: string } | null = null
    if (kind === 'note' && projectFileTarget(project, intakeFolder ?? '').ok) {
      const w = writeProjectNote(project, intakeFolder ?? '', title, '', 'md')
      if (!w.ok) return failDetail(res, w.code === 'write_failed' ? 500 : 400, MESSAGES['upload_' + w.code] ? 'upload_' + w.code : w.code, lang, 'message' in w ? (w.message || null) : null)
      noteFile = { rel: w.rel, name: w.name }
    }
    const r = createWorkItem({
      project_id: project.id, type: kind === 'note' ? 'note' : INTAKE_TYPE[kind], title,
      prompt: text || undefined, container_folder: intakeFolder, source_path: noteFile ? noteFile.rel : undefined, created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, {
      ok: true, ask: false, kind, item: r.item, versions: [r.version], text, file: noteFile,
      message: null,
    }, 201)
    return true
  }

  if (path !== '/api/workbench/items' && !path.startsWith('/api/workbench/items/')) return false

  if (path === '/api/workbench/items' && method === 'GET') {
    const pid = (url.searchParams.get('project') || '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    // #454: old main/sub links become folders (no-op once done).
    try { migrateSubItemsToFolders() } catch (e) { logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[workbench] sub item -> folder migration failed') }
    json(res, {
      project: { id: project.id, name: project.name, archived: project.archived_at != null, sensitive: projectSensitive(project.id) },
      sensitive_items: sensitiveItemIds(project.id),
      work_folders: listWorkFolders(project),
      items: listWorkItems(project.id),
      deleted: listDeletedWorkItems(project.id),
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
    // #454: "Which folder should it go in?" -- '' = the project's default box.
    let containerFolder: string | null = null
    if (String(body.folder ?? '').trim()) {
      const c = workFolderTarget(project, body.folder)
      if (!c.ok) return fail(res, 400, c.code === 'no_box' ? 'folder_gone' : c.code, lang)
      containerFolder = c.folder
    }
    // A typed "new folder" name is made for real right now (it used to need the
    // extra button), inside the picked folder, and the item goes into it.
    let ownFolder: string | null = null
    let folderExisted = false
    const newFolderName = String(body.new_folder ?? '').trim()
    if (newFolderName) {
      const mf = makeWorkFolder(project, containerFolder ?? '', newFolderName)
      if (!mf.ok) {
        const code = mf.code === 'no_box' ? 'folder_gone' : mf.code === 'folder_name' ? 'bad_folder_name' : mf.code
        return failDetail(res, mf.code === 'write_failed' ? 500 : 400, code, lang, 'message' in mf ? (mf.message || null) : null)
      }
      ownFolder = mf.folder
      containerFolder = mf.folder
      folderExisted = !mf.created
    }
    // Step 2 needs step 1: no folder chosen (or typed) -> nothing is saved, and none is made on the side.
    if (containerFolder === null && projectFileTarget(project, '').ok) return fail(res, 400, 'folder_required', lang)
    const r = createWorkItem({
      project_id: project.id,
      type: body.type,
      title: body.title,
      status: body.status,
      source_path: body.source_path,
      prompt: body.prompt,
      container_folder: containerFolder,
      created_by: actor(ctx),
    })
    if (!r.ok) return fail(res, 400, r.code, lang)
    if (ownFolder) assignWorkItemFolder(r.item.id, ownFolder)
    // #471: a deck made from an existing folder of pictures owns that folder, so renaming one renames the other.
    // A folder another item already owns stays a plain container (adoptExistingFolder refuses it).
    if (!ownFolder && body.adopt_folder === true && containerFolder && containerFolder.includes('/')) adoptExistingFolder(r.item, project, containerFolder)
    json(res, { ok: true, item: getWorkItem(r.item.id) ?? r.item, versions: [r.version], folder_existed: folderExisted }, 201)
    return true
  }

  // UJ TABLAZAT (#406, 15. pont): egy ures .xlsx a projekt mappajaba, es egy
  // uj munkadarab ra. Friss telepitesen igy a feluletrol is lehet tablazattal
  // kezdeni -- nem kell hozza sem Excel, sem feltoltes.
  if (path === '/api/workbench/items/new-table' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const pid = String(body['project_id'] ?? '').trim()
    if (!pid) return fail(res, 400, 'project_required', lang)
    const project = getProject(pid)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    if (project.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const title = String(body['title'] ?? '').trim()
    if (!title) return fail(res, 400, 'table_title_required', lang)
    // #454: the form's "Which folder?" field holds for a new table too: the .xlsx
    // goes straight into the chosen folder (no extra folder is made).
    let folder: string | null = null
    let folderCreated = false
    let folderExisted = false
    let containerFolder: string | null = null
    const newFolderName = String(body['new_folder'] ?? '').trim()
    // Step 2 needs step 1: no folder chosen (or typed) -> nothing is saved, and none is made on the side.
    if (!String(body['folder'] ?? '').trim() && !newFolderName && projectFileTarget(project, '').ok) return fail(res, 400, 'folder_required', lang)
    if (String(body['folder'] ?? '').trim() || newFolderName) {
      let c = workFolderTarget(project, body['folder'])
      if (!c.ok) return fail(res, 400, c.code === 'no_box' ? 'folder_gone' : c.code, lang)
      if (newFolderName) {
        const mf = makeWorkFolder(project, c.folder, newFolderName)
        if (!mf.ok) {
          const code = mf.code === 'no_box' ? 'folder_gone' : mf.code === 'folder_name' ? 'bad_folder_name' : mf.code
          return failDetail(res, mf.code === 'write_failed' ? 500 : 400, code, lang, 'message' in mf ? (mf.message || null) : null)
        }
        c = { ok: true, folder: mf.folder }
        folderExisted = !mf.created
      }
      containerFolder = c.folder
      folder = c.folder
    }
    const out = writeProjectFile(project, folder, `${title.replace(/\.xlsx$/i, '')}.xlsx`, blankXlsx(lang === 'en' ? 'Sheet1' : 'Munka1'))
    if (!out.ok) {
      // The EMPTY folder just made for it is not left behind as an orphan.
      if (folder && folderCreated) {
        const t = projectFileTarget(project, folder)
        if (t.ok) { try { rmdirSync(t.dirAbs) } catch { /* nem ures / nem torolheto: marad */ } }
      }
      const code = MESSAGES['upload_' + out.code] ? 'upload_' + out.code : out.code
      return failDetail(res, out.code === 'write_failed' ? 500 : 400, code, lang, 'message' in out ? (out.message || null) : null)
    }
    const r = createWorkItem({ project_id: project.id, type: 'document', title, source_path: out.rel, container_folder: containerFolder, created_by: actor(ctx) })
    if (!r.ok) return fail(res, 400, r.code, lang)
    json(res, { ok: true, item: r.item, versions: [r.version], file: out, folder, renamed: out.renamed, name: out.name, folder_existed: folderExisted }, 201)
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
    // #441 (K-0.10): a feltoltesbol szuletett munkadarab SAJAT mappat kap a
    // projekt mappajaban, a munkadarab nevevel -- a fajl oda kerul, nem
    // omlesztve a projekt fomappajaba. Ha a hivo kifejezetten megad egy
    // almappat (`sub`), az marad.
    const title = titleFromFileName(name)
    const explicitSub = url.searchParams.get('sub')
    let folder: string | null = null
    let folderCreated = false
    if (!explicitSub) {
      const f = makeFreshFolder(project, title)
      if (!f.ok) {
        const code = MESSAGES['upload_' + f.code] ? 'upload_' + f.code : f.code
        return failDetail(res, f.code === 'write_failed' ? 500 : 400, code, lang, 'message' in f ? (f.message || null) : null)
      }
      folder = f.folder
      folderCreated = f.created
    }
    const out = writeProjectFile(project, folder ?? explicitSub, name, data)
    if (!out.ok) {
      // A most nyitott, URES mappat nem hagyjuk ott arvanak.
      if (folder && folderCreated) {
        const t = projectFileTarget(project, folder)
        if (t.ok) { try { rmdirSync(t.dirAbs) } catch { /* nem ures / nem torolheto: marad */ } }
      }
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
    if (folder) assignWorkItemFolder(r.item.id, folder)
    registerAsset(r.item.id, out.rel, out.name, sha256Of(data), out.bytes, actor(ctx))
    const item = getWorkItem(r.item.id) ?? r.item
    json(res, { ok: true, item, versions: [r.version], file: out, folder, renamed: out.renamed, name: out.name }, 201)
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
    const assets = assetsOut(item.id)
    json(res, {
      item,
      versions: listWorkItemVersionsView(item.id),
      parts: listWorkItemParts(item.id),
      part_kinds: WORK_ITEM_PART_KINDS,
      assets,
      approval: workItemApprovalState(item.id),
      project: project ? { id: project.id, name: project.name, archived: project.archived_at != null } : null,
      outline: outlineOut(item.id),
      deadlines: itemDeadlines(item.id, assets),
      privacy: privacyState(item.project_id, item.id),
      court: courtOut(item.id),
    })
    return true
  }

  // CELBIROSAG-PROFIL (#441, 7.4, K-1.36, K-1.37).
  //   GET  .../court                     -- a valasztott profil, a valaszthatok, az utolso ellenorzes
  //   PUT  .../court {profile_id|null}    -- profil valasztasa
  //   POST .../court/check                -- ujraellenorzes a legutobbi vegleges fajlokon
  //   POST .../court/checked {profile_id} -- a tulajdonos megnezte a hivatalos forrast (datum frissul)
  //   POST .../court/fix {annex_id}       -- kereshető masolat a mellekletrol, a jegyzek arra mutat
  //   PUT  .../court/settings {max_age_days}      -- ennyi nap utan kerdez ra a valtozasra (tulajdonos)
  //   POST .../court/proposals/<id>/accept|reject -- az Agent szabalyfrissitesi javaslata (tulajdonos)
  if (segs[1] === 'court') {
    if (segs.length === 2 && method === 'GET') {
      json(res, { court: courtOut(item.id) })
      return true
    }
    const owner = getProject(item.project_id)
    if (!owner) return fail(res, 404, 'project_not_found', lang)
    if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (segs.length === 2 && method === 'PUT') {
      const r = setItemProfile(item.id, body['profile_id'])
      if (!r.ok) return failDetail(res, 400, 'court_bad_input', lang, r.detail)
      json(res, { ok: true, court: courtOut(item.id) })
      return true
    }
    if (segs.length === 3 && segs[2] === 'check' && method === 'POST') {
      if (!itemCourtState(item.id).available) return fail(res, 424, 'court_not_installed', lang)
      const r = await recheckFinal(item)
      if (!r.ok) return failDetail(res, r.code === 'court_file_missing' ? 404 : 409, r.code, lang, r.detail)
      json(res, { ok: true, court: courtOut(item.id) })
      return true
    }
    if (segs.length === 3 && segs[2] === 'checked' && method === 'POST') {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'court_owner_only', lang)
      const r = markProfileChecked(String(body['profile_id'] ?? ''))
      if (!r.ok) return r.code === 'file_broken' ? failDetail(res, 409, 'court_file_broken', lang, r.detail) : fail(res, 404, 'court_bad_input', lang)
      json(res, { ok: true, court: courtOut(item.id) })
      return true
    }
    if (segs.length === 3 && segs[2] === 'settings' && method === 'PUT') {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'court_owner_only_rules', lang)
      const r = setMaxAgeDays(body['max_age_days'])
      if (!r.ok) return r.code === 'file_broken' ? failDetail(res, 409, 'court_file_broken', lang, r.detail) : failDetail(res, 400, 'court_settings_bad', lang, r.detail)
      json(res, { ok: true, court: courtOut(item.id) })
      return true
    }
    if (segs.length === 5 && segs[2] === 'proposals' && (segs[4] === 'accept' || segs[4] === 'reject') && method === 'POST') {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'court_owner_only_rules', lang)
      const r = segs[4] === 'accept' ? acceptProposal(segs[3]) : rejectProposal(segs[3])
      if (!r.ok) {
        if (r.code === 'file_broken') return failDetail(res, 409, 'court_file_broken', lang, r.detail)
        return fail(res, r.code === 'not_found' ? 404 : 409, r.code === 'not_found' ? 'court_proposal_not_found' : 'court_proposal_not_open', lang)
      }
      json(res, { ok: true, court: courtOut(item.id) })
      return true
    }
    if (segs.length === 3 && segs[2] === 'fix' && method === 'POST') {
      const a = listAnnexes(item.id).find((x) => x.id === String(body['annex_id'] ?? ''))
      if (!a) return fail(res, 404, 'court_annex_not_found', lang)
      if (!/\.pdf$/i.test(a.path)) return fail(res, 400, 'court_fix_not_pdf', lang)
      if (!searchableCopyAvailable()) return fail(res, 424, 'searchable_not_installed', lang)
      const resolve = (p: string) => resolveProjectFile(owner, p)
      const src = resolve(a.path)
      if (!src) return fail(res, 404, 'asset_not_found', lang)
      const dirAbs = dirnamePath(src.abs)
      const dest = freeFileName(dirAbs, searchableName(src.name, lang))
      const r = await makeSearchableCopy(src.abs, joinPath(dirAbs, dest))
      if (!r.ok) return failDetail(res, 500, 'searchable_failed', lang, r.detail)
      const relDir = a.path.split('/').slice(0, -1).join('/')
      const newPath = relDir ? `${relDir}/${r.name}` : r.name
      const set = setAnnexPath(item.id, a.id, newPath, resolve)
      if (!set.ok) return failDetail(res, 500, 'searchable_failed', lang, set.detail)
      json(res, { ok: true, annex_id: a.id, path: newPath, court: courtOut(item.id), outline: outlineOut(item.id), assets: assetsOut(item.id) }, 201)
      return true
    }
    return fail(res, 404, 'court_bad_input', lang)
  }

  // ADATVEDELEM (#441, 7.3, K-1.32 ... K-1.34): "Erzekeny" jeloles es a kimeno adatok naploja.
  //   GET .../privacy                 -- az allapot + mi ment ki, hova, mikor (K-1.33)
  //   PUT .../privacy {sensitive}     -- bekapcsolni barki (szigoritas), KIKAPCSOLNI csak a tulajdonos kattintasa
  if (segs.length === 2 && segs[1] === 'privacy' && method === 'GET') {
    json(res, { privacy: privacyState(item.project_id, item.id), egress: egressLog(item.id), ai_cost: itemAiCost(item.id), ocr: 'local' })
    return true
  }
  if (segs.length === 2 && segs[1] === 'privacy' && method === 'PUT') {
    const body = await readJson(req)
    if (!body || typeof body['sensitive'] !== 'boolean') return fail(res, 400, 'privacy_bad_input', lang)
    if (body['sensitive'] === false && !isOwnerClick(ctx)) return fail(res, 403, 'privacy_owner_only', lang)
    setItemSensitive(item.id, body['sensitive'] === true, actor(ctx))
    json(res, { ok: true, privacy: privacyState(item.project_id, item.id) })
    return true
  }

  // HATARIDOK ES IDOPONTOK AZ IRATOKBOL (#441, 1/A, K-1.17). A kezdonaptol
  // szamitott hataridot a Marveen nem szamolja ki magatol: a tulajdonos megadja
  // a kezbesites napjat, a Marveen javasol, a tulajdonos hagyja jova.
  //   GET    .../deadlines                          -- a lista, forrassal
  //   POST   .../deadlines/<key>/propose {trigger}  -- javaslat (nem ir semmit)
  //   POST   .../deadlines/<key>/todo {due?}        -- teendo lesz belole
  //   POST/DELETE .../deadlines/<key>/dismiss       -- "nem vonatkozik ram" / visszahozas
  if (segs[1] === 'deadlines') {
    const assets = listWorkItemAssetsSynced(item.id)
    if (segs.length === 2 && method === 'GET') {
      json(res, { deadlines: itemDeadlines(item.id, assets) })
      return true
    }
    const key = segs[2] || ''
    if (segs.length !== 4 || !key) return false
    const owner = getProject(item.project_id)
    if (!owner) return fail(res, 404, 'project_not_found', lang)
    if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    // A teendo es a jovahagyott nap a tulajdonos dontese (az agentnek sajat teendo-eszkoze van).
    if (!isOwnerClick(ctx)) return fail(res, 403, 'deadline_owner_only', lang)
    const body = method === 'DELETE' ? {} : await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const gone = (): true => {
      json(res, { error: 'deadline_gone', message: msg('deadline_gone', lang), deadlines: itemDeadlines(item.id, assets) }, 404)
      return true
    }
    if (segs[3] === 'propose' && method === 'POST') {
      const d = itemDeadlines(item.id, assets).find((x) => x.key === key)
      if (!d) return gone()
      if (!d.relative) return fail(res, 400, 'deadline_not_relative', lang)
      if (d.relative.unit === 'workday') return fail(res, 400, 'deadline_workdays', lang)
      const p = proposeDue(String(body['trigger'] ?? ''), d.relative.amount, d.relative.unit)
      if (!p) return fail(res, 400, 'deadline_bad_trigger', lang)
      json(res, { proposal: p })
      return true
    }
    if (segs[3] === 'todo' && method === 'POST') {
      const r = deadlineToTodo(item.id, assets, key, { due: body['due'], by: actor(ctx), lang })
      if (!r.ok) {
        if (r.code === 'not_found') return gone()
        if (r.code === 'todo_failed') return fail(res, r.detail === 'too_many' ? 409 : 400, 'todo_' + (r.detail || 'bad_due_date'), lang)
        return fail(res, r.code === 'already' ? 409 : 400, 'deadline_' + r.code, lang)
      }
      json(res, { ok: true, todo: r.todo, deadlines: itemDeadlines(item.id, assets), todos: listItemTodos(item.id) }, 201)
      return true
    }
    if (segs[3] === 'dismiss' && (method === 'POST' || method === 'DELETE')) {
      if (!dismissDeadline(item.id, assets, key, method === 'POST', actor(ctx))) return gone()
      json(res, { ok: true, deadlines: itemDeadlines(item.id, assets) })
      return true
    }
    return false
  }

  // DOKUMENTUMMODELL (#441, 1/A, K-1.14 ... K-1.16, K-1.22): a tulajdonos
  // kezi szerkesztese es a megerositesek. Az agent a doc.* eszkozokkel
  // ugyanezt a modellt szerkeszti.
  //   GET    .../outline                         -- vazlat + veglegesites elotti ellenorzes
  //   POST   .../outline/sections {title}        PATCH/DELETE .../outline/sections/<id>
  //   POST   .../outline/blocks {section, text}  PATCH/DELETE .../outline/blocks/<id>
  //   POST   .../outline/claims/<id>/confirm     -- CSAK a tulajdonos kattintasa (K-1.9)
  //   POST/DELETE .../outline/consistency/<key>/ack -- elteres szandekosnak jelolese (K-1.19), CSAK a tulajdonos
  if (segs[1] === 'outline') {
    const owner = getProject(item.project_id)
    if (!owner) return fail(res, 404, 'project_not_found', lang)
    if (segs.length === 2 && method === 'GET') {
      try { recheckPendingSources(item.id, sourceWorldFor(owner, item.id)) } catch { /* a vazlat akkor is jojjon */ }
      json(res, { outline: outlineOrEmpty(item.id) })
      return true
    }
    // PISZKOZAT PDF (K-1.21): barmikor, vizjellel -- OLVASAS, archivalt projektben is.
    // `review=<ujjlenyomat>`: a tulajdonos a "Megnyitom es atnezem" gombbal nyitotta
    // meg; ha a tartalom ugyanaz, amit a kepernyon latott, az atnezest rogzitjuk
    // (K-1.22). Vegleges PDF itt NEM keszul: az csak a veglegesitessel.
    if (segs.length === 3 && segs[2] === 'pdf' && method === 'GET') {
      if (!hasDocModel(item.id)) return fail(res, 404, 'outline_empty', lang)
      const r = await renderDraft(item, lang)
      if (!r.ok) return docPdfFail(res, r.code, lang, r.detail, r.label)
      const review = url.searchParams.get('review')
      if (review && review === r.hash && isOwnerClick(ctx)) recordReview(item.id, r.hash, actor(ctx))
      const download = url.searchParams.get('download') === '1'
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(r.pdf.length),
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(draftFileName(item, lang))}`,
      })
      res.end(r.pdf)
      return true
    }
    // SZERKESZTHETO DOCX (K-1.26): ugyanabbol a modellbol, barmikor -- OLVASAS, archivalt projektben is.
    if (segs.length === 3 && segs[2] === 'docx' && method === 'GET') {
      if (!hasDocModel(item.id)) return fail(res, 404, 'outline_empty', lang)
      const r = await renderDocx(item, lang)
      if (!r.ok) {
        const code = r.code === 'not_installed' || r.code === 'check_failed' || r.code === 'timeout' ? 'docx_' + r.code : 'docx_failed'
        return failDetail(res, code === 'docx_timeout' ? 504 : code === 'docx_failed' ? 500 : 501, code, lang, r.detail)
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Length': String(r.docx.length),
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(docxFileName(item))}`,
      })
      res.end(r.docx)
      return true
    }
    // TECHNIKAI NYOM (K-1.23/b): ki, mikor, mit irt, ellenorzott, erositett meg -- letoltheto JSON.
    if (segs.length === 3 && segs[2] === 'trail' && method === 'GET') {
      const body = JSON.stringify(documentTrail(item), null, 2)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.title + ' - nyom.json')}`,
      })
      res.end(body)
      return true
    }
    if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    // VEGLEGESITES (K-1.22, K-1.23): csak a tulajdonos sajat kattintasa, ellenorzes +
    // atnezes + felelossegvallalas utan. Verziot keszit, a PDF a munkadarab mappajaba kerul.
    if (segs.length === 3 && segs[2] === 'finalize' && method === 'POST') {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'outline_finalize_owner_only', lang)
      const body = await readJson(req)
      if (!body) return fail(res, 400, 'bad_json', lang)
      const r = await finalizeDocument(item, { accept: body['accept'], hash: body['hash'], by: actor(ctx), lang })
      if (!r.ok) {
        if (!r.code.startsWith('outline_')) return docPdfFail(res, r.code === 'docpdf_failed' && r.convert ? r.convert : r.code, lang, r.detail, r.label, { outline: outlineOut(item.id) })
        const status = r.code === 'outline_empty' ? 404 : r.code === 'outline_accept_required' ? 400 : 409
        json(res, { error: r.code, message: msg(r.code, lang), detail: r.detail, outline: outlineOut(item.id) }, status)
        return true
      }
      json(res, { ok: true, final: r.final, file: r.asset_path, outline: outlineOut(item.id), assets: assetsOut(item.id), court: courtOut(item.id) })
      return true
    }
    const body = method === 'DELETE' ? {} : await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const done = (r: { ok: true } | { ok: false; code: string; detail: string }, created = false): true => {
      if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 400, 'outline_' + r.code, lang, r.detail)
      if (method !== 'GET') scheduleOutlineMirror(item.id)
      json(res, { ok: true, outline: outlineOrEmpty(item.id) }, created ? 201 : 200)
      return true
    }
    const sub = segs[2] || ''
    const id = segs[3] || ''
    // NYELVI VALTOZAT (K-1.27): kulon munkadarab, fejezetenkent osszekotve; a forditast az agent vegzi.
    if (sub === 'variants' && segs.length === 3 && method === 'POST') {
      const r = createVariant(item, body['lang'], actor(ctx))
      if (!r.ok) return failDetail(res, r.code === 'outline_empty' ? 409 : 400, 'variant_' + r.code, lang, r.detail)
      json(res, { ok: true, existing: r.existing, item: { id: r.item.id, title: r.item.title }, outline: outlineOrEmpty(item.id) }, r.existing ? 200 : 201)
      return true
    }
    // SZOSZEDET (K-1.29): ugyenkent (a projektben) rogzitett forditasok.
    if (sub === 'glossary' && segs.length === 3 && method === 'POST') {
      return done(addGlossaryTerm(item.project_id, { term: body['term'], translation: body['translation'], lang: body['lang'], note: body['note'] }, actor(ctx)), true)
    }
    if (sub === 'glossary' && segs.length === 4 && method === 'DELETE') return done(removeGlossaryTerm(item.project_id, id))
    // VISSZAFORDITAS (K-1.30): a tulajdonos elvetheti (az agent ujat keszithet).
    if (sub === 'backchecks' && segs.length === 4 && method === 'DELETE') return done(removeBackTranslation(item.id, id))
    if (sub === 'sections' && segs.length === 3 && method === 'POST') return done(addSection(item.id, body['title'], { status: body['status'], position: typeof body['position'] === 'number' ? body['position'] : undefined }), true)
    if (sub === 'sections' && segs.length === 4 && method === 'PATCH') return done(updateSection(item.id, id, { title: body['title'], status: body['status'], position: body['position'] }))
    if (sub === 'sections' && segs.length === 4 && method === 'DELETE') return done(removeSection(item.id, id))
    if (sub === 'blocks' && segs.length === 3 && method === 'POST') {
      return done(addBlock(item.id, String(body['section'] ?? ''), { kind: body['kind'], text: body['text'], position: body['position'], author: 'owner' }), true)
    }
    if (sub === 'blocks' && segs.length === 4 && method === 'PATCH') return done(updateBlock(item.id, id, { text: body['text'], kind: body['kind'], section: body['section'], position: body['position'], author: 'owner' }))
    if (sub === 'blocks' && segs.length === 4 && method === 'DELETE') return done(removeBlock(item.id, id))
    // MELLEKLETJEGYZEK (K-1.18): a szovegbeli hivatkozasok a listahoz igazodnak.
    if (sub === 'annexes' && segs.length === 3 && method === 'POST') {
      const resolve = resolverFor(item)
      if (!resolve) return fail(res, 404, 'project_not_found', lang)
      return done(addAnnex(item.id, { path: body['path'], title: body['title'], position: body['position'] }, resolve, actor(ctx)), true)
    }
    if (sub === 'annexes' && segs.length === 4 && method === 'PATCH') return done(updateAnnex(item.id, id, { title: body['title'], position: body['position'] }))
    if (sub === 'annexes' && segs.length === 4 && method === 'DELETE') return done(removeAnnex(item.id, id))
    if (sub === 'settings' && segs.length === 3 && method === 'PATCH') {
      return done(setDocSettings(item.id, { annex_scheme: body['annex_scheme'], annex_prefix: body['annex_prefix'], annex_mode: body['annex_mode'] }))
    }
    if (sub === 'claims' && segs.length === 5 && segs[4] === 'confirm' && method === 'POST') {
      // Egy agent (tokennel) nem erosithet meg: a megerosites a tulajdonos szava.
      if (!isOwnerClick(ctx)) return fail(res, 403, 'outline_owner_only', lang)
      return done(confirmOwnerClaim(item.id, id, actor(ctx), lang))
    }
    // ATIRASI JAVASLAT (K-1.20): az agent javasol (doc.proposeRewrite), a tulajdonos
    // SAJAT kattintasa fogadja el vagy veti el -- az agent a sajat javaslatat nem fogadhatja el.
    if (sub === 'blocks' && segs.length >= 5 && segs[4] === 'rewrite') {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'outline_owner_only', lang)
      if (segs.length === 6 && segs[5] === 'accept' && method === 'POST') {
        const r = acceptRewrite(item.id, id)
        if (!r.ok && r.code === 'rewrite_stale') {
          json(res, { error: 'outline_rewrite_stale', message: msg('outline_rewrite_stale', lang), outline: outlineOrEmpty(item.id) }, 409)
          return true
        }
        return done(r)
      }
      if (segs.length === 5 && method === 'DELETE') return done(dismissRewrite(item.id, id))
    }
    // KOVETKEZETESSEG (K-1.19): egy jelzett elteres "szandekos" -- csak a tulajdonos
    // kattintasa (az agent a szoveget javithatja, a jelzest nem nemithatja el).
    if (sub === 'consistency' && segs.length === 5 && segs[4] === 'ack' && (method === 'POST' || method === 'DELETE')) {
      if (!isOwnerClick(ctx)) return fail(res, 403, 'outline_owner_only', lang)
      if (method === 'DELETE') {
        unackConsistencyIssue(item.id, id)
        return done({ ok: true })
      }
      if (!ackConsistencyIssue(item.id, id, actor(ctx))) {
        json(res, { error: 'outline_consistency_gone', message: msg('outline_consistency_gone', lang), outline: outlineOrEmpty(item.id) }, 404)
        return true
      }
      return done({ ok: true })
    }
    return false
  }

  // A TELJES ERTEKU UGYNOK (kod-hid) a doc.* eszkozoket ezen at eri el -- ugyanaz
  // a vegrehajtas es ugyanaz az autonomia-kapu, mint a Munkapad agentjenel.
  // Csak a doc.* eszkozok: a tobbihez a kod-hidnak sajat eszkozei vannak. A
  // tulajdonosi megerosites NEM eszkoz, itt sem erheto el.
  if (segs.length === 2 && segs[1] === 'doc-tool' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const name = String(body['tool'] ?? '')
    const tool = name.startsWith('doc.') ? getTool(name) : undefined
    if (!tool) return fail(res, 400, 'doc_tool_unknown', lang)
    const decision = decideTool(tool, MAIN_AGENT_ID)
    if (decision.kind !== 'allow') return fail(res, 403, 'doc_tool_not_allowed', lang)
    const input = (body['input'] && typeof body['input'] === 'object' ? body['input'] : {}) as Record<string, unknown>
    const r = executeTool(name, { ...input, id: item.id }, { projectId: item.project_id, workItemId: item.id, lang })
    if (tool.autonomyCategory) auditWorkbench({ agent: MAIN_AGENT_ID, tool: name, op: 'doc-tool', target: item.id, cwd: item.project_id })
    json(res, r, r.ok ? 200 : 400)
    return true
  }

  // ANYAGOK (#441, v4 spec K-0.14 ... K-0.18): egy MEGLEVO munkadarabhoz
  // csatolt fajlok. A fajl a munkadarab SAJAT mappajaba kerul (ha meg nincs,
  // most keszul a munkadarab nevevel), es nem lesz belole uj munkadarab.
  //   GET    .../assets            -- a lista (tamogatasi allapottal)
  //   POST   .../assets?name=...   -- egy fajl (nyers bajtok); `force=1`: ugyanaz a tartalom ujra
  //   DELETE .../assets/<id>       -- levetel a listarol (a fajl a mappaban MARAD)
  //   POST   .../tidy              -- az omlesztett forrasfajl a munkadarab mappajaba
  if (segs.length === 2 && segs[1] === 'assets' && method === 'GET') {
    ensureAssetTables()
    json(res, { assets: assetsOut(item.id), folder: getWorkItem(item.id)?.folder ?? null })
    return true
  }
  if (segs.length === 2 && segs[1] === 'assets' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (!owner) return fail(res, 404, 'project_not_found', lang)
    if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
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
    const r = attachAsset(item, url.searchParams.get('name') || '', data, {
      force: url.searchParams.get('force') === '1',
      createdBy: actor(ctx),
    })
    if (!r.ok) {
      if (r.code === 'asset_duplicate') {
        json(res, { error: r.code, message: msg(r.code, lang), existing: r.existing }, 409)
        return true
      }
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      const status = r.code === 'write_failed' ? 500 : r.code === 'not_found' ? 404 : 400
      return failDetail(res, status, code, lang, 'message' in r ? (r.message || null) : null)
    }
    json(res, {
      ok: true, asset: r.asset, folder: r.folder, folder_created: r.folderCreated,
      renamed: r.renamed, name: r.asset.name, assets: assetsOut(item.id),
    }, 201)
    return true
  }
  // IRAT OLDALANKENT (1/A, K-1.1/K-1.2): a teljes erteku ugynok (kod-hid) is
  // ugyanazt az oldal-szoveget kapja, mint a Munkapad agentje.
  //   GET .../document?path=<projekt-relativ>            -- attekintes (oldalak, modszer, megbizhatosag)
  //   GET .../document?path=...&from=3&to=5              -- oldalak szo szerint, [fajl:oldal] jelolessel
  //   POST .../document/verify {path, page, quote}       -- gepi idezet-ellenorzes (K-1.12)
  //   POST .../document/searchable {path}                -- kereshető masolat (K-1.4), megvarja
  //   POST .../document/redact/scan {path, terms}        -- mi takarodna ki (K-1.35)
  //   POST .../document/redact {path, terms, skip}       -- kitakart masolat, megvarja
  const redactRoute = method === 'POST' && segs[2] === 'redact' && (segs.length === 3 || (segs.length === 4 && segs[3] === 'scan'))
  if (segs[1] === 'document' && ((segs.length === 2 && method === 'GET') || redactRoute || (segs.length === 3 && method === 'POST' && (segs[2] === 'verify' || segs[2] === 'searchable')))) {
    const owner = getProject(item.project_id)
    if (!owner) return fail(res, 404, 'project_not_found', lang)
    const body = method === 'POST' ? await readJson(req) : null
    if (method === 'POST' && !body) return fail(res, 400, 'bad_json', lang)
    const rel = String((body ? body['path'] : url.searchParams.get('path')) || '').replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    const name = parts.pop() || ''
    if (!name || name === '.' || name === '..') return fail(res, 400, 'document_bad_path', lang)
    const target = projectFileTarget(owner, parts.join('/'))
    if (!target.ok) return fail(res, 404, 'asset_not_found', lang)
    const abs = joinPath(target.dirAbs, name)
    let real = ''
    try { real = realpathSync(abs) } catch { return fail(res, 404, 'asset_not_found', lang) }
    const root = projectFileTarget(owner, '')
    let base = ''
    try { base = root.ok ? realpathSync(root.dirAbs) : '' } catch { base = '' }
    if (!base || !real.startsWith(base + pathSep)) return fail(res, 400, 'document_bad_path', lang)
    if (redactRoute) {
      if (!/\.pdf$/i.test(name)) return fail(res, 400, 'redact_not_pdf', lang)
      const redactFail = (r: { code: string; detail: string }): true => {
        const status = r.code === 'not_installed' ? 424 : r.code === 'too_many_pages' || r.code === 'nothing_selected' ? 400 : 500
        const code = `redact_${r.code === 'not_pdf' ? 'not_pdf' : r.code}`
        return failDetail(res, status, code, lang, r.detail)
      }
      if (segs.length === 4) {
        const r = await scanForRedaction(real, body?.['terms'])
        if (!r.ok) return redactFail(r)
        json(res, { ok: true, path: rel, ...r.data })
        return true
      }
      if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
      const dest = freeFileName(target.dirAbs, redactedName(name, lang))
      const r = await makeRedactedCopy(real, joinPath(target.dirAbs, dest), { terms: body?.['terms'], skip: body?.['skip'] })
      if (!r.ok) return redactFail(r)
      json(res, {
        ok: true, name: r.name, path: parts.length ? `${parts.join('/')}/${r.name}` : r.name,
        redacted: r.redacted, pages: r.pages, searchable: r.searchable, unreadable_pages: r.unreadable_pages, assets: assetsOut(item.id),
      }, 201)
      return true
    }
    if (segs.length === 3 && segs[2] === 'searchable') {
      if (owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
      if (!/\.pdf$/i.test(name)) return fail(res, 400, 'searchable_not_pdf', lang)
      if (!searchableCopyAvailable()) return fail(res, 424, 'searchable_not_installed', lang)
      const dest = freeFileName(target.dirAbs, searchableName(name, lang))
      const r = await makeSearchableCopy(real, joinPath(target.dirAbs, dest))
      if (!r.ok) return failDetail(res, 500, 'searchable_failed', lang, r.detail)
      json(res, { ok: true, name: r.name, path: parts.length ? `${parts.join('/')}/${r.name}` : r.name, assets: assetsOut(item.id) }, 201)
      return true
    }
    const retry = url.searchParams.get('retry') === '1'
    const from = Number(url.searchParams.get('from') || 0)
    const r = segs.length === 3
      ? verifyQuote(real, name, Number(body?.['page'] || 0), String(body?.['quote'] ?? ''))
      : from > 0
        ? documentPagesText(real, name, from, Number(url.searchParams.get('to') || from), { retry })
        : documentOverview(real, name, { retry })
    if (!r.ok) {
      json(res, { error: r.code, detail: r.detail }, r.code === 'processing' ? 202 : r.code === 'missing' ? 404 : r.code === 'failed' ? 500 : 400)
      return true
    }
    json(res, { ok: true, path: rel, ...r.data })
    return true
  }
  // K-0.19: egy kozos tarban allo fajl hivatkozaskent az anyagok koze.
  if (segs.length === 3 && segs[1] === 'assets' && segs[2] === 'link' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = linkSharedAsset(item, body['path'], actor(ctx))
    if (!r.ok) return fail(res, r.code === 'not_found' ? 404 : 400, r.code === 'not_found' ? 'asset_not_found' : r.code, lang)
    json(res, { ok: true, asset: r.asset, already: r.already, assets: assetsOut(item.id) }, r.already ? 200 : 201)
    return true
  }
  if (segs.length === 3 && segs[1] === 'assets' && method === 'DELETE') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    // `?file=1`: LEVETEL + VEGLEGES TORLES -- a fajl a mappabol is torlodik
    // (Boss, 2026-09-29, 1884); anelkul csak levetel, a fajl a mappaban marad.
    if (url.searchParams.get('file') === '1') {
      const d = deleteAssetFile(item.id, segs[2] || '')
      if (!d.ok) {
        if (d.code === 'asset_in_use') {
          json(res, { error: d.code, message: msg(d.code, lang).replace('{users}', (d.users || []).join(', ')), users: d.users }, 409)
          return true
        }
        return fail(res, d.code === 'asset_not_found' ? 404 : d.code === 'delete_failed' ? 500 : 400, d.code, lang)
      }
      json(res, { ok: true, deleted: true, assets: assetsOut(item.id) })
      return true
    }
    if (!unlinkAsset(item.id, segs[2] || '')) return fail(res, 404, 'asset_not_found', lang)
    json(res, { ok: true, assets: assetsOut(item.id) })
    return true
  }
  // ATNEVEZES (#441, K-0.11): a munkadarab uj neve, es vele a mappaja is.
  if (segs.length === 2 && segs[1] === 'rename' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const r = renameWorkItem(item, body['title'])
    if (!r.ok) return fail(res, r.code === 'folder_exists' ? 409 : 400, r.code, lang)
    json(res, { ok: true, item: r.item, folder_rename: r.folder, items: listWorkItems(item.project_id), assets: assetsOut(item.id) })
    return true
  }
  // Files an existing item (and its folder) into another folder of the box.
  if (segs.length === 2 && segs[1] === 'folder' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    const r = moveWorkItemToFolder(item, body ? body['folder'] : '')
    if (!r.ok) {
      const code = r.code === 'no_box' ? 'folder_gone' : r.code
      return failDetail(res, r.code === 'move_failed' ? 500 : 400, code, lang, r.message || null)
    }
    json(res, { ok: true, moved: r.moved, reason: r.reason ?? null, folder: r.folder, item: getWorkItem(item.id), work_folders: listWorkFolders(owner as NonNullable<typeof owner>), items: listWorkItems(item.project_id) })
    return true
  }
  if (segs.length === 2 && segs[1] === 'tidy' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    const r = tidyWorkItemIntoFolder(item, { folder: body ? body['folder'] : undefined })
    if (!r.ok) {
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      return failDetail(res, r.code === 'move_failed' || r.code === 'write_failed' ? 500 : 400, code, lang, 'message' in r ? (r.message || null) : null)
    }
    json(res, {
      ok: true, folder: r.folder, moved: r.moved, skipped: r.skipped,
      item: getWorkItem(item.id), versions: listWorkItemVersionsView(item.id), assets: assetsOut(item.id),
    })
    return true
  }

  // KITUZES (#406, 21bcb1f4): csillag a listan. A valasz a friss listat is
  // visszaadja, hogy a felulet ne sajat maga rendezzen (egy szabaly, egy hely).
  if (segs.length === 2 && segs[1] === 'pin' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    if (typeof body['pinned'] !== 'boolean') return fail(res, 400, 'pin_bad_value', lang)
    const updated = setWorkItemPinned(item.id, body['pinned'])
    if (!updated) return fail(res, 404, 'not_found', lang)
    json(res, { item: updated, items: listWorkItems(item.project_id) })
    return true
  }

  // LOMTAR (#443): torles = lomtarba teves, visszaallithato; a verziok es a
  // fajlok megmaradnak. A valasz mindket friss listat visszaadja.
  if (segs.length === 2 && segs[1] === 'trash' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { return fail(res, 400, 'bad_json', lang) }
    if (typeof body['deleted'] !== 'boolean') return fail(res, 400, 'trash_bad_value', lang)
    const updated = setWorkItemDeleted(item.id, body['deleted'])
    if (!updated) return fail(res, 404, 'not_found', lang)
    json(res, { item: updated, items: listWorkItems(item.project_id), deleted: listDeletedWorkItems(item.project_id) })
    return true
  }

  // VEGLEGES TORLES A LOMTARBOL (#443, "1A"): csak lomtarban levo darabra.
  if (segs.length === 2 && segs[1] === 'purge' && method === 'POST') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    tombstoneSnapshot(item)
    const r = purgeWorkItem(item.id)
    if (!r.ok) return r.code === 'item_not_found' ? fail(res, 404, 'not_found', lang) : fail(res, 409, r.code, lang)
    json(res, { ok: true, items: listWorkItems(r.projectId), deleted: listDeletedWorkItems(r.projectId) })
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
    if (action === 'submit') {
      // A jovahagyas a JELENLEGI verziorol szol. Rajznal a latott allapot a
      // munkapeldanyban allhat (K-2.2): elobb verzio lesz belole (K-2.3,
      // "veglegesiteskor"), kulonben a tulajdonos egy regebbi rajzot hagyna jova.
      const flushed = flushCanvasDraft(item, { reason: 'finalize', actor: who })
      if (flushed && !flushed.ok) return failDetail(res, 409, flushed.code, lang, flushed.detail)
      r = submitWorkItemForApproval(item.id, { actor: who, lang })
    }
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
    // Rajz-munkadarabnal a latott rajz a MUNKAPELDANYBAN all (K-2.2): az uj
    // verzio azt tartalmazza, nem a legutobbi verzio fajljat masolja le.
    if (!('source_path' in body)) {
      const flushed = flushCanvasDraft(item, { label: body['label'], reason: 'manual', actor: actor(ctx), prompt: body['prompt'] })
      if (flushed) {
        if (!flushed.ok) return failDetail(res, flushed.code === 'project_not_found' ? 404 : 409, flushed.code, lang, flushed.detail)
        json(res, { ok: true, item: flushed.item, version: flushed.version, versions: listWorkItemVersionsView(item.id) }, 201)
        return true
      }
    }
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

  // VERZIO TORLESE (#443): vegleges, a tulajdonos kerese szerint rakerdezes nelkul.
  if (segs.length === 3 && segs[1] === 'versions' && method === 'DELETE') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
    const r = deleteWorkItemVersion(segs[2] || '', item.id)
    if (!r.ok) return fail(res, r.code === 'version_not_found' || r.code === 'item_not_found' ? 404 : 409, r.code, lang)
    json(res, {
      ok: true, item: r.item, versions: listWorkItemVersionsView(item.id),
      // A jelenlegi torlesekor a munkadarab egy masik verziora allt at: annak
      // a reszei az elok, a felulet ezekkel tolti be ujra a szerkesztot.
      loaded: r.loaded ? { id: r.loaded.id, version_no: r.loaded.version_no } : null,
      parts: listWorkItemParts(item.id),
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

  // TABLAZAT (#406, 15. pont): a munkadarab .xlsx / .csv fajlja racskent.
  // OLVASAS, ezert archivalt projektben is megy (csak mentes nincs).
  if (segs.length === 2 && segs[1] === 'table' && method === 'GET') {
    const src = loadTableSource(item.id, url.searchParams.get('version'))
    if (!src.ok) return failDetail(res, src.code === 'not_found' ? 404 : 400, src.code, lang, src.detail || null)
    const tb = readTable(src.source.data, src.source.name)
    if (!tb.ok) return failDetail(res, 400, tb.code, lang, tb.detail || null)
    json(res, {
      ...tb.table,
      name: src.source.name, rel: src.source.rel,
      version_id: src.source.version_id, version_no: src.source.version_no, current: src.source.current,
      limits: { rows: TABLE_MAX_ROWS, cols: TABLE_MAX_COLS, cells: TABLE_MAX_CELLS },
    })
    return true
  }

  // EXPORT (#406, 6. pont): a munkadarab nyomtathato, onallo lapja -- a
  // bongeszo "Mentes PDF-kent" utja ebbol PDF-et csinal. OLVASAS, ezert
  // archivalt projektben is megy.
  if (segs.length === 2 && segs[1] === 'export.html' && method === 'GET') {
    const download = url.searchParams.get('download') === '1'
    const page = buildExportPage(item, url.searchParams.get('version'), lang, {
      toolbar: !download, autoPrint: !download && url.searchParams.get('print') === '1',
    })
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(page.html, 'utf-8')),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(page.fileName)}`,
    })
    res.end(page.html)
    return true
  }

  // EXPORT MAS DOKUMENTUMFORMATUMBA (Boss, TG 2243): ugyanaz a nyomtathato lap, de
  // docx / doc / odt / rtf / txt / epub fajlkent (LibreOffice). OLVASAS.
  if (segs.length === 2 && segs[1] === 'export-doc' && method === 'GET') {
    const fmt = (url.searchParams.get('fmt') || '').toLowerCase()
    const spec = Object.prototype.hasOwnProperty.call(DOC_EXPORT_FORMATS, fmt) ? DOC_EXPORT_FORMATS[fmt] : null
    if (!spec) return fail(res, 400, 'docexport_bad_format', lang)
    const page = buildExportPage(item, url.searchParams.get('version'), lang, { toolbar: false })
    const r = await htmlToExportBytes(page.html, fmt)
    if (!r.ok) {
      const status = r.code === 'not_installed' || r.code === 'check_failed' ? 501 : r.code === 'timeout' ? 504 : 500
      return failDetail(res, status, r.code === 'not_installed' ? 'docexport_not_installed' : 'docedit_' + r.code, lang, r.detail)
    }
    const base = page.fileName.replace(/\.[^./\\]+$/, '') || 'export'
    res.writeHead(200, {
      'Content-Type': spec.mime,
      'Content-Length': String(r.data.length),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base + '.' + fmt)}`,
    })
    res.end(r.data)
    return true
  }

  // DOKUMENTUM SZERKESZTESE A MUNKAPADON (#444, 1A): a .docx (doc/odt/rtf)
  // szerkesztheto HTML-kent. OLVASAS, ezert az archivalt-kapu ELOTT all; a
  // felulet archivalt projektben nem kinal szerkesztest, a mentes ugyis ott
  // akad meg. Csak a MOSTANI verzio: regit szerkeszteni = a kozben keszult
  // verziok csendes elvesztese lenne.
  if (segs.length === 2 && segs[1] === 'doc-html' && method === 'GET') {
    const p = buildPreview(item.id)
    const ext = p.kind === 'office' && p.rel ? docEditExt(p.name || p.rel) : null
    if (!ext || !p.rel) return fail(res, 400, 'docedit_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const r = await docToEditableHtml(abs)
    if (!r.ok) return docEditFail(res, r, lang)
    json(res, { ok: true, html: r.html, ext, name: p.name, base_version: item.current_version_id || null }, 200, { 'Cache-Control': 'private, no-store' })
    return true
  }

  // Archivalt projekt = CSAK OLVASHATO. Az olvasas (GET) marad, minden iras
  // ugyanazt az EMBERI mondatot kapja -- a felulet el is rejti a gombokat, de a
  // szabalyt a szerver tartja be, nem a kepernyo.
  if (method !== 'GET') {
    const owner = getProject(item.project_id)
    if (owner && owner.archived_at != null) return fail(res, 409, 'project_archived', lang)
  }

  // KULDES (#406, 6. pont; tulajdonos dontese 2026-09-27): a tulajdonos SAJAT
  // kattintasa (bejelentkezett munkamenet) AZONNAL kuld; minden mas hivo
  // (token, federacio, eszkoz, agens) a MEGLEVO jovahagyasi kapun at
  // `email_send` jegyet nyit. A valasztast itt a szerver teszi meg.
  if (segs.length === 2 && segs[1] === 'send-request' && method === 'POST') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const input = {
      to: body['to'], subject: body['subject'], message: body['message'],
      attachment: body['attachment'], version: body['version'], actor: actor(ctx), lang,
    }
    if (isOwnerClick(ctx)) {
      const s = await sendNow(item, input)
      if (!s.ok) {
        const status = s.code === 'send_write_failed' ? 500 : s.code === 'send_no_mail_account' ? 409 : s.code === 'send_failed' ? 502 : 400
        return failDetail(res, status, s.code, lang, s.detail || null)
      }
      json(res, { ok: true, status: 'sent', message_id: s.message_id, attachment: { name: s.attachment.name, kind: s.attachment.kind }, message: msg('send_sent', lang) }, 201)
      return true
    }
    const r = requestSendApproval(item, input)
    if (!r.ok) return failDetail(res, r.code === 'send_write_failed' ? 500 : 400, r.code, lang, r.detail || null)
    json(res, { ok: true, approval_id: r.approval_id, status: 'pending', attachment: { name: r.attachment.name, kind: r.attachment.kind }, message: msg('send_requested', lang) }, 201)
    return true
  }

  // TABLAZAT MENTESE (#406, 15. pont): UJ fajl a regi melle + UJ verzio. Csak
  // a mostani verziora, es csak ha kozben nem lett ujabb (`base_version`) --
  // kulonben egy masik mentes csendben elveszne.
  if (segs.length === 2 && segs[1] === 'table' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const base = String(body['base_version'] ?? '')
    if (!base || versionIsStale(item.id, base)) return fail(res, 409, 'table_stale', lang)
    const norm = normalizeSheets(body['sheets'])
    if (!norm.ok) return fail(res, 400, norm.code, lang)
    const src = loadTableSource(item.id)
    if (!src.ok) return failDetail(res, 400, src.code, lang, src.detail || null)
    const delimiter = typeof body['delimiter'] === 'string' ? body['delimiter'] : undefined
    const out = writeTable(src.source.data, src.source.name, norm.sheets, { delimiter, lang })
    if (!out.ok) return failDetail(res, out.code === 'table_no_change' ? 409 : 400, out.code, lang, out.detail || null)
    const r = saveBytesAsNewVersion(item, project, src.source.rel, out.data, { created_by: actor(ctx), prompt: body['prompt'], edit: 'table' })
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

  // KEPSZERKESZTES MENTESE (#406, 16. pont): a bongeszoben kesz kep (nyers
  // bajtok) UJ fajlba a regi melle + UJ verzio. `base_version`: kozben nem
  // lehetett ujabb verzio.
  if (segs.length === 2 && segs[1] === 'image-edit' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
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
    const fresh = getWorkItem(item.id)
    if (!fresh) return fail(res, 404, 'not_found', lang)
    const r = saveEditedImage(fresh, project, data, { baseVersion: url.searchParams.get('base_version'), created_by: actor(ctx) })
    if (!r.ok) {
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      const status = r.code === 'image_edit_stale' ? 409 : r.code === 'write_failed' ? 500 : 400
      return failDetail(res, status, code, lang, r.detail || null)
    }
    json(res, {
      ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id),
      file: r.file, renamed: r.file.renamed, name: r.file.name,
    }, 201)
    return true
  }

  // POSZT PLATFORM-KEPEK (#406, TG 6642/6653): a bongeszoben pontos meretre
  // vagott kep UJ fajlkent a projekt mappajaba; a betekinto link ezt kinalja.
  if (segs.length === 2 && segs[1] === 'post-files' && method === 'GET') {
    const files = listPostFiles(item.id).map((f) => ({
      id: f.id, platform: f.platform, name: f.name, rel: f.rel, bytes: f.bytes, created_at: f.created_at, available: f.available,
    }))
    json(res, { ok: true, files })
    return true
  }
  if (segs.length === 2 && segs[1] === 'post-files' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > POST_FILE_MAX_BYTES) return fail(res, 413, 'post_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: POST_FILE_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'post_too_large', lang)
      throw e
    }
    const r = savePostFile(item, project, url.searchParams.get('platform'), data, actor(ctx))
    if (!r.ok) return fail(res, r.code === 'write_failed' ? 500 : r.code === 'post_too_large' ? 413 : 400, r.code, lang)
    json(res, { ok: true, name: r.name, file: { id: r.file.id, platform: r.file.platform, rel: r.file.rel, bytes: r.file.bytes } }, 201)
    return true
  }

  // VIDEOMUNKA (#406, 19. pont): vagas -> UJ fajl + UJ verzio; kepkocka ->
  // UJ PNG + UJ kep munkadarab. Soha nem ir felul.
  if (segs.length === 2 && (segs[1] === 'video-trim' || segs[1] === 'video-frame') && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const fresh = getWorkItem(item.id)
    if (!fresh) return fail(res, 404, 'not_found', lang)
    const r = segs[1] === 'video-trim'
      ? await trimVideo(fresh, project, { start: body['start'], end: body['end'], baseVersion: body['base_version'], created_by: actor(ctx) })
      : await saveVideoFrame(fresh, project, { at: body['at'], baseVersion: body['base_version'], lang: lang === 'en' ? 'en' : 'hu', created_by: actor(ctx) })
    if (!r.ok) {
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      const status = r.code === 'video_stale' || r.code === 'video_busy' ? 409
        : r.code === 'video_no_ffmpeg' || r.code === 'video_ffmpeg_check_failed' ? 503
        : r.code === 'video_failed' || r.code === 'video_timeout' || r.code === 'write_failed' ? 500 : 400
      return failDetail(res, status, code, lang, r.detail || null)
    }
    if ('version' in r) {
      json(res, { ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id), file: r.file, name: r.file.name }, 201)
    } else {
      json(res, { ok: true, new_item: r.item, file: r.file, name: r.file.name }, 201)
    }
    return true
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
    if (optionalBaseIsStale(item.id, url.searchParams.get('base_version'))) return fail(res, 409, 'version_stale', lang)
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
  //   POST .../canvas/ops   -- STRUKTURALT modositas    -> munkapeldany (verzio NEM)
  //   POST .../canvas/undo | redo                      -> egy lepes vissza / elore
  //   POST .../canvas/version {label, reason}          -> UJ VERZIO a munkapeldanybol
  //   POST   .../canvas/orphans/<verzio>/restore       -> felbehagyott munka verziokent
  //   DELETE .../canvas/orphans/<verzio>               -> felbehagyott munka eldobasa
  //   GET  .../canvas.svg   -- a vaszon KEPE (elonezet es letoltes)
  //
  // A strukturalt muveleteket ugyanaz a modul vegzi, amit az agent toolja hiv
  // (`applyCanvasOps`), tehat a "tedd a cimet 30%-kal nagyobbra es kozepre"
  // pontosan ugyanazt csinalja gombbal es agenssel.
  //
  // v4 spec 8. fejezet (#441, K-2.1..K-2.3): a modositas AZONNAL mentodik a
  // munkapeldanyba, de verziot csak jelentos pont csinal -- igy a verziolista
  // nem telik meg szaz apro lepessel, es minden lepes visszavonhato.
  // ============================================================================
  const canvasArchived = (): boolean => {
    const owner = getProject(item.project_id)
    return !!owner && owner.archived_at != null
  }
  /** A munkapeldany allapota minden valaszban: a felulet EBBOL tudja, mit irjon
   *  ki ("Mentve" / "Nem mentett valtozas") es mi vonhato vissza. */
  const canvasState = (): Record<string, unknown> => {
    const r = readCanvas(item.id)
    return {
      draft: r.ok ? r.draft : null,
      history: canvasHistory(item.id),
      orphans: canvasOrphans(item.id),
    }
  }

  if (segs.length === 2 && segs[1] === 'canvas' && method === 'GET') {
    const r = readCanvas(item.id, url.searchParams.get('version'))
    if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 409, r.code, lang, r.detail)
    const fresh = getWorkItem(item.id) || item
    const onCurrent = !r.version_id || r.version_id === fresh.current_version_id
    json(res, {
      canvas: r.doc,
      // A KET NULLA KULON: "meg nincs rajz" (exists=false) sosem keveredik
      // ossze azzal, hogy "nem tudtam megnezni" (az fentebb hiba).
      exists: r.exists,
      rel: r.rel, name: r.name,
      version_id: r.version_id, version_no: r.version_no,
      limits: { max_objects: CANVAS_MAX_OBJECTS, text_max: CANVAS_TEXT_MAX, max_size: CANVAS_MAX_SIZE },
      summary: canvasSummary(r.doc),
      // Regi verzio nezesekor nincs munkapeldany es nincs mit visszavonni: az
      // a verzio sajat, lezart allapota.
      current: onCurrent,
      draft: r.draft,
      history: onCurrent ? canvasHistory(item.id) : null,
      orphans: canvasOrphans(item.id),
      // K-2.8 .. K-2.10: a platformmeretek (forrassal, ellenorzes napjaval) es
      // a mostani meretre illo platform (a biztonsagi zonaval).
      platforms: listCanvasPlatforms(),
      platform: platformForSize(r.doc.width, r.doc.height)?.id ?? null,
    })
    return true
  }

  if (segs.length === 2 && segs[1] === 'canvas.svg' && method === 'GET') {
    const r = readCanvas(item.id, url.searchParams.get('version'))
    if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 409, r.code, lang, r.detail)
    // K-2.13: "AI altal keszitett" jeloles a fajlban -- csak keresre (?ai_label=1).
    const svg = renderCanvasForItem(item, r.doc, { aiLabel: url.searchParams.get('ai_label') === '1' })
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
    if (optionalBaseIsStale(item.id, body['base_version'])) return fail(res, 409, 'version_stale', lang)
    // A teljes vaszon kuldese EXPLICIT mentes: a munkapeldanyba kerul (egy
    // visszavonhato lepeskent), es rogton verzio is lesz belole. Ha pontosan az
    // all mar a verzioban, nem gyartunk egy ugyanolyan masodikat.
    const commit = commitCanvasChange(item, parsed.doc, {
      source: 'owner', label: 'replace', actor: actor(ctx), sub: body['sub'], name: body['name'], prompt: body['prompt'],
    })
    if (!commit.ok) return failDetail(res, commit.code === 'project_not_found' ? 404 : 400, commit.code, lang, commit.detail)
    const v = saveCanvasVersion(getWorkItem(item.id) || item, {
      label: body['label'], reason: 'manual', actor: actor(ctx), prompt: body['prompt'],
    })
    if (!v.ok) return failDetail(res, v.code === 'project_not_found' ? 404 : 409, v.code, lang, v.detail)
    const save = v.save || commit.created
    const after = readCanvas(item.id)
    json(res, {
      ok: true, canvas: parsed.doc, item: v.item, version: v.version,
      versions: listWorkItemVersionsView(item.id),
      rel: save ? save.rel : (after.ok ? after.rel : null),
      name: save ? save.name : (after.ok ? after.name : null),
      renamed: save ? save.renamed : false,
      created: !!save,
      ...canvasState(),
      message: msg(save ? 'canvas_saved' : 'canvas_version_unchanged', lang),
    }, save ? 201 : 200)
    return true
  }

  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'ops' && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    if (optionalBaseIsStale(item.id, body['base_version'])) return fail(res, 409, 'version_stale', lang)
    // A munkapeldany a JELENLEGI verziora epul. Regi verziot csak
    // visszaallitas utan lehet szerkeszteni -- kulonben ket vonal keveredne.
    const wanted = body['version']
    if (wanted != null && wanted !== '' && String(wanted) !== (item.current_version_id || '')) {
      return fail(res, 409, 'canvas_old_version', lang)
    }
    const current = readCanvas(item.id)
    if (!current.ok) return failDetail(res, current.code === 'not_found' ? 404 : 409, current.code, lang, current.detail)
    const applied = applyCanvasOps(current.doc, body['ops'], { platform: canvasPlatform })
    if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
    // A csoport: egy szerkeszto-urlap egy megnyitasa, vagy egy huzas -- ezek
    // egy lepeskent vonhatok vissza, akarhany mentes ment is le kozben.
    const group = typeof body['group'] === 'string' ? body['group'].trim().slice(0, 80) : ''
    const commit = commitCanvasChange(item, applied.doc, {
      source: 'owner', grp: group ? `ui:${group}` : null, label: canvasOpsLabel(body['ops']),
      actor: actor(ctx), sub: body['sub'], name: current.name, prompt: body['prompt'],
    })
    if (!commit.ok) return failDetail(res, commit.code === 'project_not_found' ? 404 : 400, commit.code, lang, commit.detail)
    const fresh = getWorkItem(item.id) || item
    const created = commit.created
    json(res, {
      ok: true, canvas: applied.doc, applied: applied.applied, changed: commit.changed,
      item: fresh,
      version: created ? created.version : (fresh.current_version_id ? getWorkItemVersion(fresh.current_version_id) ?? null : null),
      versions: listWorkItemVersionsView(item.id),
      rel: created ? created.rel : current.rel,
      name: created ? created.name : current.name,
      renamed: created ? created.renamed : false,
      created: !!created,
      ...canvasState(),
      // Az ELSO mentes hozza letre a rajzot (fajl + verzio); utana a
      // modositas csak a munkapeldanyba megy.
      message: msg(created ? 'canvas_saved' : 'canvas_autosaved', lang),
    }, created ? 201 : 200)
    return true
  }

  if (segs.length === 3 && segs[1] === 'canvas' && (segs[2] === 'undo' || segs[2] === 'redo') && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const r = segs[2] === 'undo' ? undoCanvas(item, actor(ctx)) : redoCanvas(item, actor(ctx))
    if (!r.ok) return failDetail(res, r.code === 'not_found' ? 404 : 409, r.code, lang, r.detail)
    json(res, {
      ok: true, canvas: r.doc, step: { label: r.label, source: r.source },
      item: getWorkItem(item.id) || item,
      ...canvasState(),
    })
    return true
  }

  // VALTOZAT MAS PLATFORMRA (K-2.9): ugyanannak a munkadarabnak egy uj
  // verzioja az uj meretben, az elemek aranyosan atrendezve. Elotte a mostani
  // allapot verzio lesz (ha van benne verziozatlan munka) -- igy az eredeti
  // meret is megmarad, visszaallithato, osszehasonlithato.
  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'variant' && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const body = (await readJson(req)) || {}
    const pf = canvasPlatform(body['platform'])
    if (!pf) return failDetail(res, 400, 'canvas_unknown_platform', lang, String(body['platform'] ?? ''))
    const who = actor(ctx)
    const flushed = flushCanvasDraft(item, { reason: 'manual', actor: who })
    if (flushed && !flushed.ok) return failDetail(res, 409, flushed.code, lang, flushed.detail)
    const fresh = getWorkItem(item.id) || item
    const current = readCanvas(fresh.id)
    if (!current.ok) return failDetail(res, current.code === 'not_found' ? 404 : 409, current.code, lang, current.detail)
    if (!current.exists) return fail(res, 409, 'canvas_nothing_to_version', lang)
    const applied = applyCanvasOps(current.doc, [{ op: 'resize', platform: pf.id }], { platform: canvasPlatform })
    if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
    const commit = commitCanvasChange(fresh, applied.doc, { source: 'owner', label: 'resize', actor: who, name: current.name })
    if (!commit.ok) return failDetail(res, 409, commit.code, lang, commit.detail)
    const v = saveCanvasVersion(getWorkItem(item.id) || fresh, { label: pf.label[lang], reason: 'variant', actor: who })
    if (!v.ok) return failDetail(res, 409, v.code, lang, v.detail)
    json(res, {
      ok: true, canvas: applied.doc, item: v.item, version: v.version, created: v.created,
      versions: listWorkItemVersionsView(item.id),
      ...canvasState(),
      platforms: listCanvasPlatforms(), platform: pf.id,
      message: msg('canvas_variant_made', lang).replace('{name}', pf.label[lang]),
    }, 201)
    return true
  }

  // AI-KEPSZERKESZTES (K-2.11 .. K-2.13) egy kepelemen.
  //   GET  .../canvas/ai-edit  -- elerheto-e (kulcs, erzekenyseg) + varhato koltseg
  //   POST .../canvas/ai-edit {object_id, instruction, confirm_cost}
  // A POST csak `confirm_cost: true`-val fut: a tulajdonos LATTA az arat.
  const aiEditBlock = (): string | null => {
    if (privacyState(item.project_id, item.id).sensitive) return 'ai_edit_sensitive'
    if (!imageAiConfig()) return 'ai_edit_not_configured'
    return null
  }
  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'ai-edit' && method === 'GET') {
    const cfg = imageAiConfig()
    const block = aiEditBlock()
    const est = estimateImageEdit(cfg ? cfg.model : '', String(url.searchParams.get('instruction') || ''))
    json(res, {
      // A titkos kulcsbol CSAK az megy ki, hogy be van-e allitva -- az erteke soha.
      // Irni a Kepessegek ablak beallitas-utja tudja (capabilities/image_gen/setting).
      key_set: String(getEffectiveSettingValue('WORKBENCH_GEMINI_API_KEY') ?? '').trim() !== '',
      available: !block, reason: block, reason_message: block ? msg(block, lang) : null,
      model: cfg ? cfg.model : null, estimate_usd: cfg ? est.usd : null, price_source: est.source,
    })
    return true
  }
  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'ai-edit' && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const block = aiEditBlock()
    if (block) return fail(res, block === 'ai_edit_sensitive' ? 403 : 409, block, lang)
    const body = (await readJson(req)) || {}
    if (body['confirm_cost'] !== true) return fail(res, 400, 'ai_edit_confirm_cost', lang)
    const instruction = String(body['instruction'] ?? '').trim().slice(0, 1000)
    if (!instruction) return fail(res, 400, 'ai_edit_no_instruction', lang)
    const current = readCanvas(item.id)
    if (!current.ok) return failDetail(res, current.code === 'not_found' ? 404 : 409, current.code, lang, current.detail)
    const obj = current.doc.objects.find((o) => o.id === String(body['object_id'] ?? ''))
    if (!obj || obj.type !== 'image') return fail(res, 400, 'ai_edit_not_image', lang)
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const file = readCanvasImageFile(project, obj.src)
    if (!file.ok) return failDetail(res, 409, file.code, lang, file.detail)
    const cfg = imageAiConfig()!
    const out = await editImageWithAI({ bytes: file.bytes, mime: file.mime, instruction, cfg })
    if (!out.ok) {
      recordImageAiCall(item.id, { model: cfg.model, file: file.rel, instruction_chars: instruction.length, cost_usd: null, status: 'failed' })
      return failDetail(res, 502, out.code, lang, out.detail)
    }
    recordImageAiCall(item.id, { model: out.model, file: file.rel, instruction_chars: instruction.length, cost_usd: out.cost_usd, status: 'sent' })
    // UJ fajl a regi mellett, a regi nevebol ("auto.png" -> "auto-ai.png").
    const ext = out.mime === 'image/jpeg' ? '.jpg' : out.mime === 'image/webp' ? '.webp' : '.png'
    const base = (file.rel.split('/').pop() || 'kep').replace(/\.[^.]+$/, '').replace(/-ai(?: \(\d+\))?$/, '')
    const folder = project.folder_path || ''
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : ''
    const sub = folder && dir.startsWith(folder + '/') ? dir.slice(folder.length + 1) : null
    const written = writeProjectFile(project, sub, `${base}-ai${ext}`, out.bytes)
    if (!written.ok) return failDetail(res, 409, 'ai_edit_write_failed', lang, written.code)
    const at = Math.floor(Date.now() / 1000)
    const applied = applyCanvasOps(current.doc, [{ op: 'update', id: obj.id, patch: { src: written.rel, ai: { model: out.model, at, prompt: instruction } } }])
    if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
    const commit = commitCanvasChange(item, applied.doc, { source: 'owner', label: 'ai_edit', actor: actor(ctx), name: current.name })
    if (!commit.ok) return failDetail(res, 409, commit.code, lang, commit.detail)
    json(res, {
      ok: true, canvas: applied.doc, item: getWorkItem(item.id) || item,
      file: { rel: written.rel, name: written.name, previous: file.rel },
      cost_usd: out.cost_usd, model: out.model, model_note: out.note,
      ...canvasState(),
      message: msg('ai_edit_done', lang).replace('{name}', written.name).replace('{cost}', out.cost_usd == null ? '?' : `$${out.cost_usd.toFixed(3)}`),
    })
    return true
  }

  if (segs.length === 3 && segs[1] === 'canvas' && segs[2] === 'version' && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const body = (await readJson(req)) || {}
    const v = saveCanvasVersion(item, { label: body['label'], reason: body['reason'], actor: actor(ctx), prompt: body['prompt'] })
    if (!v.ok) return failDetail(res, v.code === 'project_not_found' || v.code === 'not_found' ? 404 : 409, v.code, lang, v.detail)
    const named = !v.created && typeof body['label'] === 'string' && body['label'].trim() !== ''
    json(res, {
      ok: true, created: v.created, item: v.item, version: v.version,
      versions: listWorkItemVersionsView(item.id),
      rel: v.save ? v.save.rel : null, name: v.save ? v.save.name : null, renamed: v.save ? v.save.renamed : false,
      ...canvasState(),
      message: msg(v.created ? 'canvas_version_saved' : named ? 'canvas_version_named' : 'canvas_version_unchanged', lang),
    }, v.created ? 201 : 200)
    return true
  }

  if (segs.length === 5 && segs[1] === 'canvas' && segs[2] === 'orphans' && segs[4] === 'restore' && method === 'POST') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    const r = restoreCanvasOrphan(item, segs[3] || '', actor(ctx))
    if (!r.ok) return failDetail(res, r.code === 'canvas_orphan_not_found' ? 404 : 409, r.code, lang, r.detail)
    const after = readCanvas(item.id)
    json(res, {
      ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id),
      canvas: after.ok ? after.doc : null,
      ...canvasState(),
      message: msg('canvas_orphan_restored', lang),
    }, 201)
    return true
  }

  if (segs.length === 4 && segs[1] === 'canvas' && segs[2] === 'orphans' && method === 'DELETE') {
    if (canvasArchived()) return fail(res, 409, 'project_archived', lang)
    if (!discardCanvasOrphan(item, segs[3] || '')) return fail(res, 404, 'canvas_orphan_not_found', lang)
    json(res, { ok: true, ...canvasState(), message: msg('canvas_orphan_discarded', lang) })
    return true
  }

  // ============================================================================
  // VIDEO TIMELINE (v4 spec phase 5, video): clips, subtitles, music, overlays.
  // Same shape as the canvas above: edits save at once to a working copy, only a
  // milestone makes a version, every step is undoable. The render makes a NEW mp4.
  // ============================================================================
  if (segs[1] === 'timeline') {
    if (item.type !== 'video') return fail(res, 409, 'timeline_not_video', lang)
    const store = timelineStore()
    const tlArchived = (): boolean => {
      const owner = getProject(item.project_id)
      return !!owner && owner.archived_at != null
    }
    const tlState = (): Record<string, unknown> => {
      const r = store.read(item.id)
      return { draft: r.ok ? r.draft : null, history: store.history(item.id), orphans: store.orphans(item.id) }
    }
    const tlStatus = (code: string): number => (/_(not_found|orphan_not_found)$/.test(code) ? 404 : 409)

    if (segs.length === 2 && method === 'GET') {
      const r = store.read(item.id, url.searchParams.get('version'))
      if (!r.ok) return failDetail(res, tlStatus(r.code), r.code, lang, r.detail)
      const fresh = getWorkItem(item.id) || item
      const onCurrent = !r.version_id || r.version_id === fresh.current_version_id
      const last = lastRenderOf(item.id)
      json(res, {
        timeline: r.doc, exists: r.exists, rel: r.rel, name: r.name, version_id: r.version_id, version_no: r.version_no,
        summary: timelineSummary(r.doc), duration: timelineDuration(r.doc), offsets: clipOffsets(r.doc),
        limits: { clips: TIMELINE_MAX_CLIPS, subtitles: TIMELINE_MAX_SUBTITLES, overlays: TIMELINE_MAX_OVERLAYS, text: TIMELINE_TEXT_MAX, min_clip: TIMELINE_MIN_CLIP, aspects: TIMELINE_ASPECTS },
        current: onCurrent, draft: r.draft,
        history: onCurrent ? store.history(item.id) : null, orphans: store.orphans(item.id),
        last_render: last ? { ...last, url: `/api/life/file?rel=${encodeURIComponent(last.rel)}&lang=${lang}`, current: !!r.version_id && last.version_id === r.version_id && !(r.draft && r.draft.since_version) } : null,
      })
      return true
    }

    if (segs.length === 3 && segs[2] === 'ops' && method === 'POST') {
      if (tlArchived()) return fail(res, 409, 'project_archived', lang)
      const body = await readJson(req)
      if (!body) return fail(res, 400, 'bad_json', lang)
      if (optionalBaseIsStale(item.id, body['base_version'])) return fail(res, 409, 'version_stale', lang)
      const current = store.read(item.id)
      if (!current.ok) return failDetail(res, tlStatus(current.code), current.code, lang, current.detail)
      const owner = getProject(item.project_id)
      const filled = owner ? await fillClipEnds(owner, body['ops']) : { ok: true as const, ops: body['ops'] }
      if (!filled.ok) {
        return failDetail(res, filled.code === 'video_no_ffmpeg' || filled.code === 'video_ffmpeg_check_failed' ? 503 : 400, filled.code, lang, ('detail' in filled && filled.detail) || null)
      }
      const applied = applyTimelineOps(current.doc, filled.ops)
      if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
      const group = typeof body['group'] === 'string' ? body['group'].trim().slice(0, 80) : ''
      const commit = store.commit(item, applied.doc, {
        source: 'owner', grp: group ? `ui:${group}` : null, label: opsLabel(body['ops']),
        actor: actor(ctx), name: current.name, prompt: body['prompt'],
      })
      if (!commit.ok) return failDetail(res, commit.code === 'project_not_found' ? 404 : 400, commit.code, lang, commit.detail)
      const fresh = getWorkItem(item.id) || item
      const created = commit.created
      json(res, {
        ok: true, timeline: applied.doc, applied: applied.applied, changed: commit.changed, item: fresh,
        versions: listWorkItemVersionsView(item.id), rel: created ? created.rel : current.rel, created: !!created,
        summary: timelineSummary(applied.doc), duration: timelineDuration(applied.doc), offsets: clipOffsets(applied.doc),
        ...tlState(), message: msg(created ? 'timeline_saved' : 'timeline_autosaved', lang),
      }, created ? 201 : 200)
      return true
    }

    if (segs.length === 3 && (segs[2] === 'undo' || segs[2] === 'redo') && method === 'POST') {
      if (tlArchived()) return fail(res, 409, 'project_archived', lang)
      const r = segs[2] === 'undo' ? store.undo(item, actor(ctx)) : store.redo(item, actor(ctx))
      if (!r.ok) return failDetail(res, tlStatus(r.code), r.code, lang, r.detail)
      json(res, {
        ok: true, timeline: r.doc, step: { label: r.label, source: r.source }, item: getWorkItem(item.id) || item,
        summary: timelineSummary(r.doc), duration: timelineDuration(r.doc), offsets: clipOffsets(r.doc), ...tlState(),
      })
      return true
    }

    if (segs.length === 3 && segs[2] === 'version' && method === 'POST') {
      if (tlArchived()) return fail(res, 409, 'project_archived', lang)
      const body = (await readJson(req)) || {}
      const v = store.saveVersion(item, { label: body['label'], reason: body['reason'], actor: actor(ctx) })
      if (!v.ok) return failDetail(res, tlStatus(v.code), v.code, lang, v.detail)
      json(res, {
        ok: true, created: v.created, item: v.item, version: v.version, versions: listWorkItemVersionsView(item.id),
        ...tlState(), message: msg(v.created ? 'timeline_version_saved' : 'timeline_version_unchanged', lang),
      }, v.created ? 201 : 200)
      return true
    }

    if (segs.length === 3 && segs[2] === 'autosubtitle' && method === 'POST') {
      if (tlArchived()) return fail(res, 409, 'project_archived', lang)
      const project = getProject(item.project_id)
      if (!project) return fail(res, 404, 'project_not_found', lang)
      const body = (await readJson(req)) || {}
      const language = String(body['language'] ?? 'hu') as AutoSubLang
      if (!(AUTOSUB_LANGS as readonly string[]).includes(language)) return fail(res, 400, 'autosub_bad_language', lang)
      const cur = store.read(item.id)
      if (!cur.ok) return failDetail(res, tlStatus(cur.code), cur.code, lang, cur.detail)
      const heard = await recogniseTimeline(project, item.id, cur.doc, language)
      if (!heard.ok) {
        const status = heard.code === 'autosub_not_installed' || heard.code === 'video_no_ffmpeg' || heard.code === 'video_ffmpeg_check_failed' ? 503
          : heard.code === 'autosub_too_long' || heard.code === 'autosub_bad_language' || heard.code === 'render_empty' ? 400
          : heard.code === 'video_busy' || heard.code === 'autosub_old_toolkit' ? 409 : 500
        return failDetail(res, status, heard.code, lang, heard.detail)
      }
      if (!heard.lines.length) {
        json(res, { ok: true, added: 0, skipped: heard.skipped, timeline: cur.doc, ...tlState(), message: msg('autosub_no_speech', lang) })
        return true
      }
      const applied = applySubtitleLines(cur.doc, heard.lines, body['replace'] === true)
      if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
      const commit = store.commit(item, applied.doc, {
        source: 'owner', grp: 'ui:autosubtitle', label: 'autoSubtitle', actor: actor(ctx), name: cur.name,
      })
      if (!commit.ok) return failDetail(res, commit.code === 'project_not_found' ? 404 : 400, commit.code, lang, commit.detail)
      json(res, {
        ok: true, added: applied.added, skipped: heard.skipped, timeline: applied.doc, changed: commit.changed, item: getWorkItem(item.id) || item,
        versions: listWorkItemVersionsView(item.id), summary: timelineSummary(applied.doc), duration: timelineDuration(applied.doc), offsets: clipOffsets(applied.doc),
        ...tlState(), message: msg('timeline_autosub_done', lang),
      }, commit.created ? 201 : 200)
      return true
    }

    if (segs.length === 3 && segs[2] === 'render' && method === 'POST') {
      if (tlArchived()) return fail(res, 409, 'project_archived', lang)
      const project = getProject(item.project_id)
      if (!project) return fail(res, 404, 'project_not_found', lang)
      const cur = store.read(item.id)
      if (!cur.ok) return failDetail(res, tlStatus(cur.code), cur.code, lang, cur.detail)
      const r = await renderTimeline(project, item.id, item.title, cur.doc)
      if (!r.ok) {
        const status = r.code === 'video_busy' ? 409
          : r.code === 'video_no_ffmpeg' || r.code === 'video_ffmpeg_check_failed' || r.code === 'render_no_subtitle_filter' ? 503
          : r.code === 'video_failed' || r.code === 'video_timeout' || r.code === 'write_failed' ? 500 : 400
        return failDetail(res, status, r.code, lang, ('detail' in r && r.detail) || null)
      }
      // The version that holds exactly the timeline that was rendered; the mp4 is recorded on it.
      const v = store.saveVersion(item, { reason: 'export', actor: actor(ctx), metadata: {} })
      const versionId = v.ok ? v.version.id : cur.version_id
      if (versionId) setWorkItemVersionMeta(versionId, { render: { rel: r.file.rel, name: r.file.name, seconds: r.seconds, bytes: r.file.bytes } })
      const last = lastRenderOf(item.id)
      json(res, {
        ok: true, file: r.file, seconds: r.seconds, item: getWorkItem(item.id) || item, versions: listWorkItemVersionsView(item.id),
        last_render: last ? { ...last, url: `/api/life/file?rel=${encodeURIComponent(last.rel)}&lang=${lang}`, current: true } : null,
        ...tlState(), message: msg('timeline_rendered', lang),
      }, 201)
      return true
    }
  }


  // ============================================================================
  // PRESENTATION DECK (v4 spec phase 5, presentation): slides, each one a canvas.
  // Same shape as the canvas and the video timeline: edits save at once to a
  // working copy, only a milestone makes a version, every step is undoable. The
  // export makes a NEW pptx or pdf file in the project folder.
  // ============================================================================
  if (segs[1] === 'deck') {
    if (item.type !== 'presentation') return fail(res, 409, 'deck_not_presentation', lang)
    const store = deckStore()
    const dkArchived = (): boolean => {
      const owner = getProject(item.project_id)
      return !!owner && owner.archived_at != null
    }
    const dkState = (): Record<string, unknown> => {
      const r = store.read(item.id)
      return { draft: r.ok ? r.draft : null, history: store.history(item.id), orphans: store.orphans(item.id) }
    }
    const dkStatus = (code: string): number => (/_(not_found|orphan_not_found)$/.test(code) ? 404 : 409)

    if (segs.length === 2 && method === 'GET') {
      const r = store.read(item.id, url.searchParams.get('version'))
      if (!r.ok) return failDetail(res, dkStatus(r.code), r.code, lang, r.detail)
      const fresh = getWorkItem(item.id) || item
      const onCurrent = !r.version_id || r.version_id === fresh.current_version_id
      json(res, {
        deck: r.doc, exists: r.exists, rel: r.rel, name: r.name, version_id: r.version_id, version_no: r.version_no,
        summary: deckSummary(r.doc),
        limits: { slides: DECK_MAX_SLIDES, notes: DECK_NOTES_MAX, sizes: DECK_SIZES, layouts: DECK_LAYOUTS, formats: DECK_EXPORT_FORMATS },
        current: onCurrent, draft: r.draft,
        history: onCurrent ? store.history(item.id) : null, orphans: store.orphans(item.id),
      })
      return true
    }

    // One slide as a picture (SVG): the thumbnails and the big view.
    if (segs.length === 4 && segs[2] === 'slide' && method === 'GET') {
      const r = store.read(item.id, url.searchParams.get('version'))
      if (!r.ok) return failDetail(res, dkStatus(r.code), r.code, lang, r.detail)
      const slide = r.doc.slides.find((s) => s.id === (segs[3] || '').replace(/\.svg$/i, ''))
      if (!slide) return fail(res, 404, 'deck_slide_not_found', lang)
      const svg = renderCanvasForItem(item, slide.canvas)
      // Thumbnails are asked for again at every redraw: the browser asks "is it still the same?" and gets a bodyless 304.
      const etag = `"${createHash('sha1').update(svg).digest('hex').slice(0, 24)}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' })
        res.end()
        return true
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(svg, 'utf-8')),
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      })
      res.end(svg)
      return true
    }

    if (segs.length === 3 && segs[2] === 'ops' && method === 'POST') {
      if (dkArchived()) return fail(res, 409, 'project_archived', lang)
      const body = await readJson(req)
      if (!body) return fail(res, 400, 'bad_json', lang)
      if (optionalBaseIsStale(item.id, body['base_version'])) return fail(res, 409, 'version_stale', lang)
      const current = store.read(item.id)
      if (!current.ok) return failDetail(res, dkStatus(current.code), current.code, lang, current.detail)
      const applied = applyDeckOps(current.doc, body['ops'])
      if (!applied.ok) return failDetail(res, 400, applied.code, lang, applied.detail)
      const group = typeof body['group'] === 'string' ? body['group'].trim().slice(0, 80) : ''
      const commit = store.commit(item, applied.doc, {
        source: 'owner', grp: group ? `ui:${group}` : null, label: opsLabel(body['ops']),
        actor: actor(ctx), name: current.name, prompt: body['prompt'],
      })
      if (!commit.ok) return failDetail(res, commit.code === 'project_not_found' ? 404 : 400, commit.code, lang, commit.detail)
      const created = commit.created
      json(res, {
        ok: true, deck: applied.doc, applied: applied.applied, changed: commit.changed, item: getWorkItem(item.id) || item,
        versions: listWorkItemVersionsView(item.id), rel: created ? created.rel : current.rel, created: !!created,
        summary: deckSummary(applied.doc), ...dkState(), message: msg(created ? 'deck_saved' : 'canvas_autosaved', lang),
      }, created ? 201 : 200)
      return true
    }

    if (segs.length === 3 && (segs[2] === 'undo' || segs[2] === 'redo') && method === 'POST') {
      if (dkArchived()) return fail(res, 409, 'project_archived', lang)
      const r = segs[2] === 'undo' ? store.undo(item, actor(ctx)) : store.redo(item, actor(ctx))
      if (!r.ok) return failDetail(res, dkStatus(r.code), r.code, lang, r.detail)
      json(res, { ok: true, deck: r.doc, step: { label: r.label, source: r.source }, item: getWorkItem(item.id) || item, summary: deckSummary(r.doc), ...dkState() })
      return true
    }

    if (segs.length === 3 && segs[2] === 'version' && method === 'POST') {
      if (dkArchived()) return fail(res, 409, 'project_archived', lang)
      const body = (await readJson(req)) || {}
      const v = store.saveVersion(item, { label: body['label'], reason: body['reason'], actor: actor(ctx) })
      if (!v.ok) return failDetail(res, dkStatus(v.code), v.code, lang, v.detail)
      json(res, {
        ok: true, created: v.created, item: v.item, version: v.version, versions: listWorkItemVersionsView(item.id),
        ...dkState(), message: msg(v.created ? 'deck_version_saved' : 'deck_version_unchanged', lang),
      }, v.created ? 201 : 200)
      return true
    }

    if (segs.length === 3 && segs[2] === 'export' && method === 'POST') {
      if (dkArchived()) return fail(res, 409, 'project_archived', lang)
      const body = (await readJson(req)) || {}
      const format = String(body['format'] ?? '') as DeckExportFormat
      if (!DECK_EXPORT_FORMATS.includes(format)) return fail(res, 400, 'deck_bad_format', lang)
      const project = getProject(item.project_id)
      if (!project) return fail(res, 404, 'project_not_found', lang)
      const cur = store.read(item.id)
      if (!cur.ok) return failDetail(res, dkStatus(cur.code), cur.code, lang, cur.detail)
      const r = await exportDeck(project, item.title, cur.rel, cur.doc, format)
      if (!r.ok) {
        const status = r.code === 'deck_export_empty' ? 400 : r.code === 'deck_pdf_not_installed' || r.code === 'deck_pdf_check_failed' ? 503 : 500
        return failDetail(res, status, r.code, lang, r.detail)
      }
      // The version that holds exactly the deck that was exported, with the file recorded on it.
      const v = store.saveVersion(item, { reason: 'export', actor: actor(ctx), metadata: {} })
      const versionId = v.ok ? v.version.id : cur.version_id
      if (versionId) setWorkItemVersionMeta(versionId, { export: { rel: r.file.rel, name: r.file.name, format: r.format, slides: r.slides, bytes: r.file.bytes } })
      json(res, {
        ok: true, file: r.file, format: r.format, slides: r.slides, warnings: r.warnings,
        url: `/api/life/file?rel=${encodeURIComponent(r.file.rel)}&lang=${lang}`,
        item: getWorkItem(item.id) || item, versions: listWorkItemVersionsView(item.id), ...dkState(), message: msg('deck_exported', lang),
      }, 201)
      return true
    }
  }


  // DOKUMENTUM MENTESE (#444, 1A): a szerkesztett HTML-bol UGYANABBAN a
  // formatumban uj fajl (.docx marad .docx) + UJ verzio; a regi erintetlen.
  if (segs.length === 2 && segs[1] === 'doc-html' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > DOC_EDIT_HTML_MAX) return fail(res, 413, 'docedit_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: DOC_EDIT_HTML_MAX })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'docedit_too_large', lang)
      throw e
    }
    const html = data.toString('utf-8')
    if (!html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim() && !/<img\b/i.test(html)) return fail(res, 400, 'docedit_empty', lang)
    const base = url.searchParams.get('base_version')
    if (versionIsStale(item.id, base)) return fail(res, 409, 'docedit_stale', lang)
    const p = buildPreview(item.id)
    const ext = p.kind === 'office' && p.rel ? docEditExt(p.name || p.rel) : null
    if (!ext || !p.rel) return fail(res, 400, 'docedit_unsupported', lang)
    const out = await htmlToDocBytes(html, ext)
    if (!out.ok) return docEditFail(res, out, lang)
    // A konverzio alatt (masodpercek) mashonnan is menthettek: ujra megnezzuk.
    if (versionIsStale(item.id, base)) return fail(res, 409, 'docedit_stale', lang)
    const fresh = getWorkItem(item.id)
    if (!fresh) return fail(res, 404, 'not_found', lang)
    const r = saveBytesAsNewVersion(fresh, project, p.rel, out.data, { created_by: actor(ctx), prompt: url.searchParams.get('prompt'), edit: 'document' })
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

  // PDF RAIRAS / KIEMELES / KITAKARAS (#444, 2A): a bongeszo rajzolja ra a
  // jeloleseket, es a lapokbol UJ PDF-et epit. A kitakaras igy VALODI: a
  // kitakart szoveg nincs benne az uj fajlban (a lap kepkent kerul bele). A
  // regi PDF es a regi verzio erintetlen.
  if (segs.length === 2 && segs[1] === 'pdf-edit' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > PROJECT_UPLOAD_MAX_BYTES) return fail(res, 413, 'upload_too_large', lang)
    let data: Buffer
    try {
      data = await readBody(req, { maxBytes: PROJECT_UPLOAD_MAX_BYTES })
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) return fail(res, 413, 'upload_too_large', lang)
      throw e
    }
    if (!looksLikePdf(data)) return fail(res, 400, 'pdfedit_bad_pdf', lang)
    const base = url.searchParams.get('base_version')
    if (versionIsStale(item.id, base)) return fail(res, 409, 'docedit_stale', lang)
    const p = buildPreview(item.id)
    if (p.kind !== 'pdf' || !p.rel) return fail(res, 400, 'pdfedit_unsupported', lang)
    const r = saveBytesAsNewVersion(item, project, p.rel, data, { created_by: actor(ctx), prompt: url.searchParams.get('prompt'), edit: 'pdf_annotate' })
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

  // PDF -> SZERKESZTHETO WORD (#444, 2B): az uj .docx a PDF melle kerul, es a
  // munkadarab UJ verzioja lesz -- innen a Word-szerkesztovel folytathato. A
  // PDF-et tartalmazo regi verzio megmarad.
  if (segs.length === 2 && segs[1] === 'pdf-to-docx' && method === 'POST') {
    const project = getProject(item.project_id)
    if (!project) return fail(res, 404, 'project_not_found', lang)
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad_json', lang)
    const base = String(body['base_version'] ?? '')
    if (versionIsStale(item.id, base)) return fail(res, 409, 'docedit_stale', lang)
    const p = buildPreview(item.id)
    if (p.kind !== 'pdf' || !p.rel) return fail(res, 400, 'pdfedit_unsupported', lang)
    const abs = resolveLifePath(p.rel)
    if (!abs) return fail(res, 404, 'convert_missing_source', lang)
    const out = await pdfToDocxBytes(abs)
    if (!out.ok) return docEditFail(res, out, lang)
    if (versionIsStale(item.id, base)) return fail(res, 409, 'docedit_stale', lang)
    const fresh = getWorkItem(item.id)
    if (!fresh) return fail(res, 404, 'not_found', lang)
    const fileName = String(p.name || 'dokumentum.pdf').replace(/\.[^.]+$/, '') + '.docx'
    const r = saveBytesAsNewVersion(fresh, project, p.rel, out.data, { created_by: actor(ctx), prompt: body['prompt'], edit: 'pdf_to_docx', fileName })
    if (!r.ok) {
      const code = MESSAGES['upload_' + r.code] ? 'upload_' + r.code : r.code
      return failDetail(res, r.code === 'write_failed' ? 500 : 400, code, lang, r.detail || null)
    }
    json(res, {
      ok: true, item: r.item, version: r.version, versions: listWorkItemVersionsView(item.id),
      file: r.file, renamed: r.file.renamed, name: r.file.name, via: out.via,
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
    if (optionalBaseIsStale(item.id, body['base_version'])) return fail(res, 409, 'version_stale', lang)
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

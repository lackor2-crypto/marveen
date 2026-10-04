/* AI MUNKAPAD -- felulet (kanban #336, 740b432a, 1. fazis: vaz + adatmodell).
 *
 * Kulon fajl, szandekosan: a Munkapad a Projektek modulra ul ra, de a kodja
 * nem keveredik bele az app.js-be (fork-barat -- az upstream-merge utkozes
 * igy egyetlen gombra es egy esemenyagra korlatozodik).
 *
 * Ami MOST mukodik: a harom paneles vaz, a munkadarabok listaja, uj
 * munkadarab letrehozasa a feluletrol, es a kontextus-panel. Ami MEG NEM: az
 * agent-chat (2. fazis) es a preview/editor (3. fazis) -- ezek a helyukon
 * allnak, kikapcsolva, kiirva hogy mikor jonnek.
 *
 * Az app.js-bol hasznalt globalisok: t, escapeHtml, escapeAttr, showToast,
 * _prjOpenProject.
 */
(function () {
  'use strict'

  var WB = {
    open: false,
    // VIDEOMUNKA (#406, 19. pont): FFmpeg-allapot es a mostani video vagas-urlapja.
    vidStatus: null,
    vidLoading: false,
    vid: null,
    // VEGLEGESITES (#441, K-1.22): a pipa ehhez a tartalom-ujjlenyomathoz tartozik; fut-e a keszites.
    docAccept: null,
    docFinalizing: false,
    projectId: null,
    project: null,
    items: null,
    selectedId: null,
    detail: null,
    formOpen: false,
    busy: false,
    // --- sablonok (#406, 11. pont) ---
    // null = meg nem jott meg; a hiba KULON all, nem "nincs sablon".
    templates: null,
    templatesLang: null,
    templatesError: null,
    tplBusy: null,
    error: null,
    // Mobilon egyszerre egy panel latszik; asztalin mind a harom.
    panel: 'items',
    // --- agent-chat (3. fazis) ---
    // Beszelgetesek KULCS szerint: a kivalasztott munkadarabe kulon, a
    // munkadarab nelkuli (projekt-szintu) kulon. Igy a valtogatas nem keveri
    // ossze oket, es nem is vesz el semmi.
    chat: {},
    chatStatus: null,
    chatStatusError: null,
    chatStreaming: false,
    chatAbort: null,
    chatWatch: null,
    chatReconnect: null,
    chatDraft: '',
    // A megnyitott munkadarabhoz most csatolt fajlok (#441), munkadarabonkent:
    // a chat beiro mezoje felett latszanak, es a kovetkezo uzenettel az agens
    // is megkapja oket. Boss, 2026-09-29: "csatoltam ket mellekletet, nem
    // tortent semmi, nem tudom hol van".
    chatAttached: {},
    chatSetupOpen: false,
    chatSetupBusy: false,
    chatConfig: null,
    chatModels: null,
    chatOllama: null,
    // --- reszek (vegyes munkadarab, 3. fazis) ---
    partEdit: null,
    partNewOpen: false,
    partNewDraft: '',
    dict: null,
    speaking: null,
    partBusy: false,
    // --- kepessegek / fuggosegek (8. fazis) ---
    // `caps === null` NEM azt jelenti, hogy nincs egy kepesseg sem: azt, hogy
    // meg nem kerdeztuk meg. A ketto kulon latszik a kepernyon is.
    capsOpen: false,
    caps: null,
    capsError: null,
    capsBusy: null,
    // --- rajzvaszon (9. fazis) ---
    // `canvas === null` = MEG NEM kerdeztuk meg (vagy hiba volt); a
    // `canvas.exists === false` = megkerdeztuk, es meg nincs rajz. A ketto
    // KULON allapot, kulon mondattal a kepernyon.
    canvas: null,
    canvasError: null,
    canvasBusy: false,
    canvasEdit: null,
    canvasStamp: null,
    // --- video timeline (v4 spec phase 5); `vt` because `tl` is the project timeline ---
    vt: null,
    vtMedia: null,
    vtBusy: false,
    vtRender: false,
    vtAuto: false,
    vtError: null,
    // --- presentation deck (v4 spec phase 5): each slide is a canvas ---
    deck: null,
    deckSlide: null,
    deckError: null,
    deckExporting: null,
    deckExported: null,
    // Melyik elemet jelolte ki a felhasznalo a vasznon (huzogatas, kartya
    // d4b05d82). Csak a KIEMELEST jelenti, a szerkeszto urlapot nem nyitja.
    canvasSel: null,
    // Tobb elem kijelolese az igazitashoz, elosztashoz, csoportositashoz
    // (K-2.5): elem-azonosito -> true. A lista pipajai es a Shift+kattintas.
    canvasPick: {},
    // A Ctrl+C-vel "vagolapra" tett elem azonositoja; a Ctrl+V masolatot ker.
    canvasClip: null,
    // Illesztes huzaskor (K-2.7): segedvonalakhoz (a vaszon szeleihez,
    // kozepehez es a tobbi elemhez) alapbol igen, racsra alapbol nem. A
    // valasztast a bongeszo megjegyzi.
    // Az Egyszeru nezet kerete (#462, 2. lepes): bal panel fule, megnyitott menu, chat-panel, nagyitas.
    frTab: readPref('wb.fr.tab', 'elements'),
    frMenu: null,
    frChat: readPref('wb.fr.chat', '1') === '1',
    frLive: false, // Elo nezet (#462): csak a kesz kep, kijelolo-pontok nelkul
    frZoom: Number(readPref('wb.fr.zoom', '100')) || 100,
    canvasSnap: readPref('wb.canvas.snap', '1') === '1',
    canvasGrid: readPref('wb.canvas.grid', '0') === '1',
    // A verziolista kinyitott "apro modositasok" csoportjai (K-2.4), a csoport
    // legregebbi verziojanak azonositojaval: uj verzio erkezesekor sem ugrik.
    verOpen: {},
    // --- PDF-nezegeto (kartya f7d423e7) ---
    // A kirajzolt lapok DOM-csomopontja TULELI a render()-t, ezert itt all,
    // nem a felulet HTML-jeben. A `pdfLib === null` = meg nem kertuk le a
    // konyvtarat; a betoltes HIBAJA kulon, a `pdf.error`-ban latszik.
    pdf: null,
    pdfLib: null,
    pdfLibPromise: null,
    // --- elonezet (4. fazis) ---
    preview: null,
    previewVersion: null,
    versionBusy: false,
    // --- kozvetlen szovegszerkesztes (#406, 4. pont) ---
    textEdit: null,
    // --- verziok egymas mellett (#406, 5. pont) ---
    // null = nincs nyitva; kulonben {itemId, left, right, pos, sides}.
    compare: null,
    // --- export + kuldes (#406, 6. pont) ---
    exportOpen: null,
    send: null,
    pngBusy: false,
    // --- osztott nezet (#406, 1. pont) ---
    // 'split' = bal oldalt a chat, jobb oldalt az ELO munkadarab (a szakmaban
    // bevett "chat + artifact" elrendezes); 'classic' = a harom panel, alatta a
    // chat. A valasztas a bongeszoben marad meg (nincs szerver-oldali allapot).
    layout: readLayout(),
    // --- kinezet: manualis | egyszeru (#462) ---
    view: readView(),
    shMore: false,      // egyszeru nezet: a "Technikai reszletek" terulet nyitva
    shDocTab: 'draft',  // egyszeru nezet, dokumentum: draft | preview | sources | gaps
    docDrafts: {},      // dokumentum-lap: mentetlen szoveg (kulcs: b:<id> | s:<id> | new:<sec>:<pos>)
    docMenu: null,      // dokumentum-lap: nyitott + / fogantyu menu
    docNew: null,       // dokumentum-lap: ures, uj sor a megadott helyen
    docFocus: null,     // dokumentum-lap: ujrarajzolas utan ide kerul a fokusz
    shFinal: false,     // egyszeru nezet, dokumentum: a veglesites lepesei nyitva
    liveTimer: null,
    // --- projekt-idovonal (#406, 7. pont) ---
    // `tl === null` = meg nem kerdeztuk meg; ures tomb = megkerdeztuk, es
    // tenyleg nincs esemeny. A `tlSources` a forrasok, amikbe NEM lattunk bele.
    tlOpen: false,
    tl: null,
    tlError: null,
    tlSources: [],
    tlMore: false,
    tlNext: null,
    tlBusy: false,
    // --- kereses a projektben (#406, 8. pont) ---
    // `search === null` = meg nem kerestunk; a hiba KULON all.
    searchOpen: false,
    searchQ: '',
    search: null,
    searchError: null,
    searchBusy: false,
    // --- jovahagyas munkadarabra (#406, 9. pont) ---
    approvalBusy: false,
    // --- heti osszefoglalo (#406, 13. pont) ---
    // `weekly === null` = meg nem toltottuk be; a hiba KULON all.
    wkOpen: false,
    weekly: null,
    wkError: null,
    wkShown: null,
    // --- kis teendok hataridovel (#406, 14. pont) ---
    // `todos === null` = meg nem toltottuk be; a hiba KULON all, hogy a "nem
    // tudtam betolteni" sose latsszon "nincs teendo"-nek.
    todos: null,
    tdError: null,
    tdBusy: false,
    dlBusy: false,
    dlCalc: {},
    // Google Naptar (#406, 14. pont B): { state, account } a szervertol; null =
    // meg nem kerdeztuk. A 'check_failed' KULON all a 'no_account'-tol.
    gcal: null,
    pinBusy: false,
    // --- lomtar (#443): torolt munkadarabok, visszaallithatok ---
    deleted: [],
    trashBusy: false,
    trashOpen: false,
    // Piros figyelmezteto keret egy vegleges / nagy hatasu torles elott (#443):
    // { kind: 'last-version' } vagy { kind: 'purge', id }.
    warn: null,
    // #454: folders inside the project's work items box + tree state + new-item form draft
    workFolders: null,
    collapsedFolder: {},
    pickFolder: '',
    newDraft: null,
    folderBusy: false,
    // Az attekinto negy szama ala lenyithato kartyalista (Boss, TG 2068).
    ovOpen: readOvOpen(),
    tdOpen: false,
    tdRem: null,
    tdRemError: null,
    tdRemBusy: false,
    // --- dontesnaplo (#406, 10. pont) ---
    // `decisions === null` = meg nem toltottuk be; a hiba KULON all, hogy a
    // "nem tudtam betolteni" sose latsszon "meg nincs dontes"-nek.
    decOpen: false,
    decisions: null,
    // --- Brand Kit (K-4.1..K-4.3) ---
    // `brand === null` = not loaded yet; a load error is kept apart so
    // "could not load" never looks like "no brand yet".
    brandOpen: false,
    brand: null,
    brandDraft: null,
    brandFiles: [],
    // The picture list failing to load is not "no pictures yet"; a stored brand
    // that cannot be read is not "no brand yet". Both are said in words.
    brandFilesError: null,
    brandUnreadable: false,
    brandError: null,
    brandBusy: false,
    brandCheck: null,
    // K-4.1: the drawings saved as brand templates; `brandTplBusy` is the id
    // being used/removed, or 'save' while a drawing is being saved as one.
    brandTemplates: [],
    brandTplBusy: null,
    // --- atadocsomag (#406, 12. pont) ---
    hoOpen: false,
    // Betekinto linkek (#406, 18. pont): a projekt linkjei + a kivalasztott ervenyesseg.
    shares: null,
    sharesFor: null,
    sharesBase: null,
    sharesError: null,
    shareDays: 7,
    shareBusy: false,
    sharesLoading: null,
    hoScope: 'done',
    hoPlan: null,
    hoError: null,
    decError: null,
    decBusy: false,
    decEdit: null,
    // --- projekt-attekinto (#406, 2. pont) ---
    // `overview === null` = MEG NEM kerdeztuk meg; a hiba KULON all, hogy a
    // "nem tudtam lekerdezni" sose latsszon "nincs semmi"-nek.
    overview: null,
    overviewError: null,
    // --- behuzas es feltoltes (#406, 3. pont) ---
    // `upload === null` = nincs folyamatban; kulonben {done, total}.
    upload: null,
  }

  /** A mentett elrendezes. Ha a bongeszo nem enged tarolni (privat mod, regi
   *  bongeszo), az osztott nezet az alap -- a hiba nem akaszthatja meg a Munkapadot. */
  function readLayout() {
    try {
      var v = window.localStorage && window.localStorage.getItem('marveen.workbench.layout')
      return v === 'classic' ? 'classic' : 'split'
    } catch (_e) { return 'split' }
  }

  /** The overview's card lists: folded by default (Boss, TG 2011: "only the
   *  four numbers"), opened by a click on any tile (TG 2068). Remembered per
   *  browser; a blocked storage just means folded. */
  function readOvOpen() {
    try { return !!(window.localStorage && window.localStorage.getItem('marveen.workbench.ovOpen') === '1') } catch (_e) { return false }
  }
  function saveOvOpen(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.ovOpen', v ? '1' : '0') } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  /** The look of the Workbench (#462): 'manual' = the technical screen as it
   *  has been, 'simple' = the planned one-question screen. Per browser; the
   *  default is manual so nothing changes until the owner flips it. */
  function readView() {
    try {
      var v = window.localStorage && window.localStorage.getItem('marveen.workbench.view')
      return v === 'simple' ? 'simple' : 'manual'
    } catch (_e) { return 'manual' }
  }
  /** Recent-works layout on the start screen (#462 step 5): 'grid' or 'list'. Per browser. */
  function readRecentMode() {
    try { return (window.localStorage && window.localStorage.getItem('marveen.workbench.recentMode')) === 'list' ? 'list' : 'grid' } catch (_e) { return 'grid' }
  }
  function saveRecentMode(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.recentMode', v) } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  function saveView(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.view', v) } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  function saveLayout(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.layout', v) } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  function esc(s) { return window.escapeHtml(s == null ? '' : String(s)) }
  function escA(s) { return window.escapeAttr(s == null ? '' : String(s)) }
  function t(key, params) { return window.t(key, params || {}) }

  /** Egy felulet-beallitas a bongeszobol. Ha a tarolo nem erheto el (privat
   *  mod, teszt), az alapertek marad -- a beallitas nem hiba forrasa. */
  function readPref(key, fallback) {
    try {
      var v = window.localStorage && window.localStorage.getItem(key)
      return v == null ? fallback : String(v)
    } catch (_e) { return fallback }
  }

  function writePref(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, String(value)) } catch (_e) { /* nem baj */ }
  }

  function root() { return document.getElementById('projectsRoot') }

  function when(sec) {
    if (!sec) return '-'
    try { return new Date(sec * 1000).toLocaleString() } catch (_e) { return '-' }
  }

  function api(method, url, body) {
    var full = url + (url.indexOf('?') < 0 ? '?' : '&') + 'lang=' + encodeURIComponent(window._lang || 'hu')
    var opts = { method: method }
    if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body) }
    return fetch(full, opts).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        if (!res.ok) {
          // A test HIBANAL is kell: a szerver ott adja a reszleteket (a VALODI
          // hibauzenetet), es azt meg kell tudnunk mutatni.
          return { ok: false, status: res.status, code: data && data.error, data: data, message: (data && data.message) || t('workbench.err.http', { status: res.status }) }
        }
        return { ok: true, status: res.status, data: data }
      })
    }).catch(function () {
      return { ok: false, status: 0, code: 'network', message: t('workbench.err.network') }
    })
  }

  // ---- adatbetoltes ---------------------------------------------------------

  /** #481: a folder renamed or moved outside the app was found again (or not): say so in plain words. */
  function announceFolderMoves(fm, wf) {
    if (!fm) return
    var box = (wf && wf.box) || ''
    var short = function (p) { return box && p.indexOf(box + '/') === 0 ? p.slice(box.length + 1) : p }
    ;(fm.moved || []).forEach(function (m) {
      window.showToast(t('workbench.folder.found_again', { from: short(m.from), to: short(m.to) }))
    })
    ;(fm.lost || []).forEach(function (p) {
      window.showToast(t('workbench.folder.lost', { name: short(p), where: box || '' }))
    })
  }

  function load(projectId) {
    return api('GET', '/api/workbench/items?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.error = r.message; WB.items = []; render(); return }
      WB.error = null
      WB.project = r.data.project
      WB.items = r.data.items || []
      WB.deleted = r.data.deleted || []
      WB.workFolders = r.data.work_folders || null
      WB.sensitiveIds = r.data.sensitive_items || []
      announceFolderMoves(r.data.folder_moves, r.data.work_folders)
      loadOverview(projectId)
      loadTodos(projectId)
      if (WB.templates === null || WB.templatesLang !== (window._lang || 'hu')) loadTemplates()
      if (WB.selectedId && !WB.items.some(function (i) { return i.id === WB.selectedId })) WB.selectedId = null
      render()
    })
  }

  // ---- kituzes (#406, 21bcb1f4) ---------------------------------------------
  //
  // A sorrendet a szerver adja vissza (friss lista), a felulet nem rendez maga.

  function togglePin(id) {
    if (WB.pinBusy || archived()) return
    var it = (WB.items || []).filter(function (x) { return x.id === id })[0]
    if (!it) return
    var pinned = it.pinned_at == null
    var pid = WB.projectId
    WB.pinBusy = true
    render()
    return api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/pin', { pinned: pinned }).then(function (r) {
      WB.pinBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && Array.isArray(r.data.items)) WB.items = r.data.items
      window.showToast(t(pinned ? 'workbench.pin.added' : 'workbench.pin.removed'))
      render()
    })
  }

  // ---- lomtar (#443) ----------------------------------------------------------
  //
  // A Torles nem kerdez ra (a tulajdonos kerese): lomtarba tesz, ahonnan egy
  // kattintassal visszahozhato, a verziok es a fajlok megmaradnak.

  function setTrashed(id, deleted) {
    if (WB.trashBusy || archived()) return
    var pid = WB.projectId
    WB.trashBusy = true
    WB.warn = null
    render()
    var payload = { deleted: deleted }
    return api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/trash', payload).then(function (r) {
      WB.trashBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && Array.isArray(r.data.items)) WB.items = r.data.items
      if (r.data && Array.isArray(r.data.deleted)) WB.deleted = r.data.deleted
      if (deleted && WB.selectedId === id) { WB.selectedId = null; WB.detail = null }
      // Open the trash right away, so the owner sees where the item went: the
      // collapsed link alone got confused with the file-tree Trash (#443).
      if (deleted) WB.trashOpen = true
      window.showToast(t(deleted ? 'workbench.trash.done' : 'workbench.trash.restored'))
      render()
    })
  }

  /** Piros figyelmezteto keret (#443, Boss 2026-09-29): a vegleges vagy az
   *  egesz munkadarabot erinto torles elott all meg, ket gombbal. */
  function warnBoxHtml(text, act, okLabel, id) {
    return '<div class="wb-warn-box" role="alert"><p>' + esc(text) + '</p><div class="wb-warn-acts">'
      + '<button type="button" class="wb-btn wb-btn-danger" data-wb-act="' + escA(act) + '"'
      + (id ? ' data-wb-id="' + escA(id) + '"' : '') + '>' + esc(okLabel) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="warn-cancel">' + esc(t('workbench.warn.cancel')) + '</button>'
      + '</div></div>'
  }

  /** Vegleges torles a Lomtarbol (#443, "1A"). */
  function purgeItem(id) {
    if (!id || WB.trashBusy || archived()) return
    var pid = WB.projectId
    WB.trashBusy = true
    WB.warn = null
    render()
    return api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/purge', {}).then(function (r) {
      WB.trashBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && Array.isArray(r.data.items)) WB.items = r.data.items
      if (r.data && Array.isArray(r.data.deleted)) WB.deleted = r.data.deleted
      if (WB.selectedId === id) { WB.selectedId = null; WB.detail = null }
      window.showToast(t('workbench.trash.purged'))
      render()
    })
  }

  /** #461: work items are also kept as files in the project folder; this box rebuilds the ones missing from the list. */
  function rescueHtml() {
    var res = WB.rescueResult
    var note = ''
    if (res) {
      note = '<p class="wb-hint">' + esc(res.restored || res.adopted || res.projectsRebuilt
        ? t('workbench.rescue.done', { n: (res.restored || 0) + (res.adopted || 0) })
        : t('workbench.rescue.none')) + '</p>'
    }
    return '<div class="wb-trash wb-rescue">'
      + '<button type="button" class="wb-trash-toggle" data-wb-act="rescue-toggle" aria-expanded="' + !!WB.rescueOpen + '">'
      + (WB.rescueOpen ? '▾ ' : '▸ ') + esc(t('workbench.rescue.title')) + '</button>'
      + (WB.rescueOpen
        ? '<p class="wb-hint">' + esc(t('workbench.rescue.why')) + '</p>'
          + '<p class="wb-hint">' + esc(t('workbench.rescue.how')) + '</p>'
          + '<div class="wb-actions"><button type="button" class="wb-mini" data-wb-act="rescue-restore"' + (WB.rescueBusy ? ' disabled' : '') + '>' + esc(t('workbench.rescue.restore')) + '</button></div>'
          + '<p class="wb-hint">' + esc(t('workbench.rescue.adopt_why')) + '</p>'
          + '<div class="wb-actions"><button type="button" class="wb-mini" data-wb-act="rescue-adopt"' + (WB.rescueBusy ? ' disabled' : '') + '>' + esc(t('workbench.rescue.adopt')) + '</button></div>'
          + note
        : '')
      + '</div>'
  }

  function runRescue(adopt) {
    if (WB.rescueBusy) return
    var pid = WB.projectId
    WB.rescueBusy = true
    render()
    return api('POST', '/api/workbench/snapshot/restore', { adopt_orphans: !!adopt, deep: true }).then(function (r) {
      WB.rescueBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      WB.rescueResult = r.data
      if (pid && WB.projectId === pid) return load(pid)
      render()
    })
  }

  function trashHtml() {
    var list = WB.deleted || []
    if (!list.length) return ''
    var head = '<button type="button" class="wb-trash-toggle" data-wb-act="trash-toggle" aria-expanded="' + WB.trashOpen + '">'
      + (WB.trashOpen ? '▾ ' : '▸ ') + esc(t('workbench.trash.title')) + ' (' + list.length + ')' + '</button>'
    if (!WB.trashOpen) return '<div class="wb-trash">' + head + '</div>'
    return '<div class="wb-trash">' + head
      + '<p class="wb-hint">' + esc(t('workbench.trash.hint')) + '</p>'
      + '<ul class="wb-items">' + list.map(function (it) {
        return '<li class="wb-item-row wb-trash-row">'
          + '<span class="wb-item wb-trash-item"><span class="wb-item-title">' + esc(it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span></span>'
          + '<button type="button" class="wb-item-del" data-wb-act="item-restore" data-wb-id="' + escA(it.id) + '"'
          + (archived() || WB.trashBusy ? ' disabled' : '') + '>' + esc(t('workbench.trash.restore')) + '</button>'
          + '<button type="button" class="wb-item-del wb-mini-danger" data-wb-act="item-purge-ask" data-wb-id="' + escA(it.id) + '"'
          + ' title="' + escA(t('workbench.trash.purge_title')) + '"'
          + (archived() || WB.trashBusy ? ' disabled' : '') + '>' + esc(t('workbench.trash.purge')) + '</button>'
          + '</li>'
          + (WB.warn && WB.warn.kind === 'purge' && WB.warn.id === it.id
            ? '<li>' + warnBoxHtml(t('workbench.trash.purge_warn', { title: it.title }), 'item-purge', t('workbench.trash.purge'), it.id) + '</li>'
            : '')
      }).join('') + '</ul></div>'
  }

  // ---- kis teendok hataridovel (#406, 14. pont) -------------------------------
  // A projekt osszes teendoje EGY listaban jon; a szerkeszto a kivalasztott
  // munkadarabet szuri ki belole. A naptarba egy .ics fajl viszi at (barmely
  // naptar felveszi), semmi nem megy ki a geprol magatol.

  function loadTodos(projectId) {
    var pid = projectId || WB.projectId
    if (!pid) return
    return api('GET', '/api/workbench/todos?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.tdError = r.message; WB.todos = null; render(); return }
      WB.tdError = null
      WB.todos = (r.data && r.data.todos) || []
      render()
      if (!WB.gcal) loadGcalStatus()
    })
  }

  function loadGcalStatus() {
    return api('GET', '/api/workbench/gcal-status').then(function (r) {
      WB.gcal = r.ok && r.data && r.data.gcal ? r.data.gcal : { state: 'check_failed', account: null }
      render()
    })
  }

  /** A teendo Google Naptar-resze: gomb, allapot, vagy a beallitas utja. */
  function tdGcalHtml(td, ro) {
    if (!td.due_date || td.done_at != null || archived() || !WB.gcal) return ''
    // Beallitatlan Google: a sor NEM kap gombot -- a lista feletti mondat
    // (tdGcalSetupHtml) mondja meg egyszer, hol kell bekotni.
    if (WB.gcal.state !== 'ready') return ''
    if (td.gcal_approval_id) {
      return ' <span class="wb-td-gcal">' + esc(t('workbench.td.gcal.pending')) + '</span>'
        + ' <button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.td.gcal.open_approvals')) + '</button>'
    }
    var note = ''
    if (td.gcal_error === 'rejected') note = ' <span class="wb-td-gcal wb-td-gcal-warn">' + esc(t('workbench.td.gcal.rejected')) + '</span>'
    else if (td.gcal_error) note = ' <span class="wb-td-gcal wb-td-gcal-warn" title="' + escA(td.gcal_error_detail || '') + '">' + esc(t('workbench.td.gcal.failed')) + '</span>'
    else if (td.gcal_event_id) note = ' <span class="wb-td-gcal">' + esc(t('workbench.td.gcal.in_calendar')) + '</span>'
    return note + ' <button type="button" class="wb-linklike" data-wb-act="td-gcal" data-wb-todo="' + escA(td.id) + '"' + ro + '>'
      + esc(t(td.gcal_event_id ? 'workbench.td.gcal.update' : 'workbench.td.gcal.add')) + '</button>'
  }

  /** Friss telepitesen (nincs Google-fiok) a gomb helyett EZ latszik: egy
   *  emberi mondat es a Varazslo Google-lepesere vivo gomb. Csak akkor, ha van
   *  mit a naptarba tenni (nyitott, hataridos teendo). */
  function tdGcalSetupHtml(list) {
    if (!WB.gcal || WB.gcal.state === 'ready' || archived()) return ''
    if (!(list || []).some(function (x) { return x.due_date && x.done_at == null })) return ''
    var st = WB.gcal.state
    var hint = st === 'no_scope' ? 'workbench.td.gcal.setup_scope' : st === 'check_failed' ? 'workbench.td.gcal.setup_unknown' : 'workbench.td.gcal.setup_none'
    return '<p class="wb-hint wb-td-gcal-setup">' + esc(t(hint))
      + ' <button type="button" class="wb-linklike" data-wb-act="td-gcal-setup">' + esc(t('workbench.td.gcal.setup')) + '</button></p>'
  }

  function tdGcalRequest(tdId) {
    if (WB.tdBusy) return
    var pid = WB.projectId
    WB.tdBusy = true
    render()
    return api('POST', '/api/workbench/todos/' + encodeURIComponent(tdId) + '/gcal', {}).then(function (r) {
      WB.tdBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) {
        var detail = r.data && r.data.detail ? ' ' + r.data.detail : ''
        window.showToast(r.message + detail)
        // A beallitas kozben valtozhatott (fiok ki/be): kerdezzuk ujra.
        WB.gcal = null
        return loadTodos(pid)
      }
      window.showToast(t(r.data && r.data.state === 'pending' ? 'workbench.td.gcal.toast_pending' : 'workbench.td.gcal.toast_done'))
      return loadTodos(pid)
    })
  }

  /** A mai nap (a bongeszo helyi ideje szerint), YYYY-MM-DD. */
  function todayStr() {
    var d = new Date()
    function p(n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function tdDueState(td) {
    if (td.done_at != null || !td.due_date) return ''
    var today = todayStr()
    if (td.due_date < today) return 'overdue'
    if (td.due_date === today) return 'today'
    return 'upcoming'
  }

  function tdDueLabel(td) {
    if (!td.due_date) return ''
    var d
    try {
      var a = td.due_date.split('-')
      d = new Date(+a[0], +a[1] - 1, +a[2]).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    } catch (_e) { d = td.due_date }
    var st = tdDueState(td)
    return st === 'overdue' ? t('workbench.td.overdue', { date: d })
      : st === 'today' ? t('workbench.td.today', { date: d })
        : t('workbench.td.due', { date: d })
  }

  /** Egy YYYY-MM-DD nap a felulet nyelven, a megadott formaban. */
  function tdDateText(ymd, opts) {
    try {
      var a = ymd.split('-')
      return new Date(+a[0], +a[1] - 1, +a[2]).toLocaleDateString(undefined, opts)
    } catch (_e) { return ymd }
  }

  /** Ismetlodes (otlet 11dfd5a9): "↻ hetente (hetfo)" / "↻ havonta, 1-jen". */
  function tdRepeatLabel(td) {
    if (!td.repeat || !td.due_date) return ''
    if (td.repeat === 'weekly') return t('workbench.td.repeat_weekly_label', { weekday: tdDateText(td.due_date, { weekday: 'long' }) })
    return t('workbench.td.repeat_monthly_label', { day: td.repeat_day || +td.due_date.slice(8, 10) })
  }

  function tdRowHtml(td, withItem) {
    var ro = archived() || WB.tdBusy ? ' disabled' : ''
    var done = td.done_at != null
    var st = tdDueState(td)
    var ics = td.due_date && !done
      ? ' <a class="wb-linklike" href="/api/workbench/todos/' + encodeURIComponent(td.id) + '/ics?lang=' + encodeURIComponent(window._lang || 'hu') + '" download>'
        + esc(t('workbench.td.to_calendar')) + '</a>' : ''
    return '<li class="wb-td-row' + (done ? ' wb-td-done' : '') + (st ? ' wb-td-' + st : '') + '">'
      + '<button type="button" class="wb-td-check" data-wb-act="td-toggle" data-wb-todo="' + escA(td.id) + '" aria-pressed="' + done + '"'
      + ' aria-label="' + escA(t(done ? 'workbench.td.undo' : 'workbench.td.tick')) + '"' + ro + '>' + (done ? '✓' : '') + '</button>'
      + '<div class="wb-td-body"><span class="wb-td-text">' + esc(td.text) + '</span>'
      + (td.due_date ? ' <span class="wb-td-due">' + esc(tdDueLabel(td)) + '</span>' : '')
      + (td.repeat && td.due_date ? ' <span class="wb-td-repeat">' + esc(tdRepeatLabel(td)) + '</span>' : '')
      + (withItem ? ' <button type="button" class="wb-linklike" data-wb-act="td-item" data-wb-item-id="' + escA(td.work_item_id) + '">'
        + esc(td.item_title || '') + '</button>' : '')
      + ics
      + tdGcalHtml(td, ro)
      + (td.repeat && !done && !archived() ? ' <button type="button" class="wb-linklike" data-wb-act="td-norepeat" data-wb-todo="' + escA(td.id) + '"' + ro + '>'
        + esc(t('workbench.td.repeat_stop')) + '</button>' : '')
      + (archived() ? '' : ' <button type="button" class="wb-linklike" data-wb-act="td-delete" data-wb-todo="' + escA(td.id) + '"' + ro + '>'
        + esc(t('workbench.td.delete')) + '</button>')
      + '</div></li>'
  }

  /** A szerkesztoben: a kivalasztott munkadarab teendoi + uj teendo. */
  function todosBoxHtml() {
    if (!WB.detail) return ''
    var id = WB.detail.item.id
    var body
    if (WB.tdError) body = '<p class="wb-error">' + esc(WB.tdError) + '</p>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    else if (WB.todos === null) body = '<p class="wb-hint">' + esc(t('workbench.td.loading')) + '</p>'
    else {
      var mine = WB.todos.filter(function (x) { return x.work_item_id === id })
      body = mine.length
        ? tdGcalSetupHtml(mine) + '<ul class="wb-td-list">' + mine.map(function (x) { return tdRowHtml(x, false) }).join('') + '</ul>'
        : '<p class="wb-hint">' + esc(t('workbench.td.empty_item')) + '</p>'
    }
    var form = archived() ? '' : '<form id="wbTdForm" class="wb-td-form">'
      + '<input class="wb-input" id="wbTdText" type="text" maxlength="300" placeholder="' + escA(t('workbench.td.placeholder')) + '"'
      + ' aria-label="' + escA(t('workbench.td.text_label')) + '">'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.due_label'))
      + ' <input class="wb-input" id="wbTdDue" type="date"></label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.repeat_label'))
      + ' <select class="wb-input" id="wbTdRepeat">'
      + '<option value="">' + esc(t('workbench.td.repeat_none')) + '</option>'
      + '<option value="weekly">' + esc(t('workbench.td.repeat_weekly')) + '</option>'
      + '<option value="monthly">' + esc(t('workbench.td.repeat_monthly')) + '</option>'
      + '</select></label>'
      + '<button type="submit" class="btn-primary"' + (WB.tdBusy ? ' disabled' : '') + '>' + esc(t('workbench.td.add')) + '</button>'
      + '</form>'
    return '<details class="wb-td-box" open><summary>' + esc(t('workbench.td.title_item')) + '</summary>' + form + body + '</details>'
  }

  // ---- hataridok es idopontok az iratokbol (#441, K-1.17) --------------------
  // A szerver szabalyokkal gyujti ki a munkadarab olvasott iratai kozul, forrassal.
  // A kezdonaptol szamitott hataridot nem szamolja ki magatol: a kezbesites
  // napjabol JAVASOL, a napot a tulajdonos hagyja jova (vagy irja at).

  var DL_ICON = { hearing: '⚖', deadline: '⏳' }
  var DL_LONG = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }

  function dlWhenText(d) {
    if (d.date) return tdDateText(d.date, DL_LONG) + (d.time ? ', ' + d.time : '')
    var r = d.relative || { amount: 0, unit: 'day', trigger: 'other' }
    return t('workbench.dl.rel.' + r.trigger, { amount: t('workbench.dl.unit.' + r.unit, { n: r.amount }) })
  }

  function dlHeadHtml(d) {
    return '<strong>' + esc((DL_ICON[d.kind] || '⏳') + ' ' + t('workbench.dl.topic.' + d.topic)) + ':</strong> ' + esc(dlWhenText(d))
  }

  function dlActionsHtml(d) {
    var k = escA(d.key)
    var busy = WB.dlBusy ? ' disabled' : ''
    if (d.todo) {
      return '<span class="wb-ok">✓ ' + esc(t('workbench.dl.todo_done', { date: d.todo.due_date ? tdDateText(d.todo.due_date, DL_LONG) : '' })) + '</span>'
        + (d.todo.due_date && !d.todo.done
          ? ' <a class="wb-linklike" href="/api/workbench/todos/' + encodeURIComponent(d.todo.id) + '/ics?lang=' + encodeURIComponent(window._lang || 'hu') + '" download>'
            + esc(t('workbench.td.to_calendar')) + '</a> <span class="wb-muted">' + esc(t('workbench.dl.todo_more')) + '</span>'
          : '')
    }
    if (archived()) return ''
    var out = ''
    if (d.date) {
      out = '<button type="button" class="wb-btn" data-wb-act="dl-todo" data-wb-key="' + k + '"' + busy + '>' + esc(t('workbench.dl.add_todo')) + '</button>'
    } else {
      var r = d.relative || {}
      var canPropose = r.unit !== 'workday' && r.trigger === 'delivery'
      var calc = WB.dlCalc[d.key]
      out = '<p class="wb-hint">' + esc(t(canPropose ? 'workbench.dl.need_trigger' : r.unit === 'workday' ? 'workbench.dl.need_due_workdays' : 'workbench.dl.need_due')) + '</p>'
      if (canPropose) {
        out += '<label class="wb-td-date-label">' + esc(t('workbench.dl.trigger_label'))
          + ' <input class="wb-input" type="date" id="wbDlTrig-' + k + '" value="' + escA(calc ? calc.trigger : '') + '"></label> '
          + '<button type="button" class="btn-secondary btn-compact" data-wb-act="dl-propose" data-wb-key="' + k + '"' + busy + '>' + esc(t('workbench.dl.propose')) + '</button>'
      }
      if (calc) {
        out += '<p class="wb-hint wb-dl-proposal">' + esc(t('workbench.dl.proposal', { date: tdDateText(calc.due, DL_LONG) }))
          + (calc.shifted ? ' ' + esc(t('workbench.dl.shifted')) : '') + ' ' + esc(t('workbench.dl.check_holidays')) + '</p>'
      }
      if (calc || !canPropose) {
        out += '<label class="wb-td-date-label">' + esc(t('workbench.dl.due_label'))
          + ' <input class="wb-input" type="date" id="wbDlDue-' + k + '" value="' + escA(calc ? calc.due : '') + '"></label> '
          + '<button type="button" class="wb-btn" data-wb-act="dl-todo" data-wb-key="' + k + '"' + busy + '>' + esc(t('workbench.dl.add_todo')) + '</button>'
      }
    }
    return out + ' <button type="button" class="wb-linklike" data-wb-act="dl-dismiss" data-wb-key="' + k + '" title="' + escA(t('workbench.dl.dismiss_title')) + '"' + busy + '>'
      + esc(t('workbench.dl.dismiss')) + '</button>'
  }

  function dlRowHtml(d, past) {
    return '<li class="wb-dl' + (past ? ' wb-dl-past' : '') + '">'
      + '<div>' + dlHeadHtml(d) + (past ? ' <span class="wb-muted">' + esc(t('workbench.dl.past')) + '</span>' : '') + '</div>'
      + '<div class="wb-dl-src wb-muted">' + esc(t('workbench.dl.source', { name: d.name, page: d.page })) + ' „' + esc(d.quote) + '”</div>'
      + (d.low ? '<div class="wb-doc-low">⚠ ' + esc(t('workbench.dl.low')) + '</div>' : '')
      + (past ? '' : '<div class="wb-dl-act">' + dlActionsHtml(d) + '</div>')
      + '</li>'
  }

  /** A szerkesztoben, a teendok alatt: csak ha az iratokban van mit mutatni. */
  function deadlinesBoxHtml() {
    var list = (WB.detail && WB.detail.deadlines) || []
    if (!list.length) return ''
    var today = todayStr()
    var shown = list.filter(function (d) { return !d.dismissed })
    var hidden = list.filter(function (d) { return d.dismissed })
    var past = shown.filter(function (d) { return d.date && d.date < today && !d.todo })
    // Elol, ami teendot var (a kezdonaptol szamitott is), a nap szerint; utana a mar teendo lett.
    var open = shown.filter(function (d) { return past.indexOf(d) < 0 }).sort(function (a, b) {
      if (!!a.todo !== !!b.todo) return a.todo ? 1 : -1
      return (a.date || '0000') < (b.date || '0000') ? -1 : (a.date || '0000') > (b.date || '0000') ? 1 : 0
    })
    return '<details class="wb-dl-box" open><summary>' + esc(t('workbench.dl.title', { n: open.length })) + '</summary>'
      + '<p class="wb-hint">' + esc(t('workbench.dl.hint')) + '</p>'
      + (open.length ? '<ul class="wb-dl-list">' + open.map(function (d) { return dlRowHtml(d, false) }).join('') + '</ul>'
        : '<p class="wb-muted">' + esc(t('workbench.dl.none_open')) + '</p>')
      + (past.length ? '<details class="wb-dl-more"><summary>' + esc(t('workbench.dl.past_title', { n: past.length })) + '</summary><ul class="wb-dl-list">'
        + past.map(function (d) { return dlRowHtml(d, true) }).join('') + '</ul></details>' : '')
      + (hidden.length ? '<details class="wb-dl-more"><summary>' + esc(t('workbench.dl.hidden_title', { n: hidden.length })) + '</summary><ul class="wb-dl-list">'
        + hidden.map(function (d) {
          return '<li class="wb-dl wb-dl-past"><div>' + dlHeadHtml(d) + '</div>'
            + '<div class="wb-dl-src wb-muted">' + esc(t('workbench.dl.source', { name: d.name, page: d.page })) + '</div>'
            + (archived() ? '' : '<button type="button" class="wb-linklike" data-wb-act="dl-undismiss" data-wb-key="' + escA(d.key) + '">' + esc(t('workbench.dl.undismiss')) + '</button>')
            + '</li>'
        }).join('') + '</ul></details>' : '')
      + '</details>'
  }

  function dlCall(method, sub, body) {
    var id = WB.selectedId
    if (!id || archived() || WB.dlBusy) return Promise.resolve(null)
    WB.dlBusy = true
    render()
    return api(method, '/api/workbench/items/' + encodeURIComponent(id) + '/deadlines/' + sub, body).then(function (r) {
      WB.dlBusy = false
      if (r.data && r.data.deadlines && WB.selectedId === id && WB.detail) WB.detail.deadlines = r.data.deadlines
      render()
      if (!r.ok) { window.showToast(r.message); return null }
      return r.data
    })
  }

  function refreshDeadlines(id) {
    return api('GET', '/api/workbench/items/' + encodeURIComponent(id) + '/deadlines').then(function (r) {
      if (!r.ok || WB.selectedId !== id || !WB.detail) return
      WB.detail.deadlines = r.data.deadlines || []
      render()
    })
  }

  function dlPropose(key) {
    var el = document.getElementById('wbDlTrig-' + key)
    var trig = el && el.value
    if (!trig) { window.showToast(t('workbench.dl.trigger_missing')); return }
    dlCall('POST', encodeURIComponent(key) + '/propose', { trigger: trig }).then(function (d) {
      if (d && d.proposal) { WB.dlCalc[key] = { trigger: trig, due: d.proposal.due, shifted: !!d.proposal.shifted }; render() }
    })
  }

  function dlTodo(key) {
    var el = document.getElementById('wbDlDue-' + key)
    var body = {}
    if (el) {
      if (!el.value) { window.showToast(t('workbench.dl.due_missing')); return }
      body.due = el.value
    }
    dlCall('POST', encodeURIComponent(key) + '/todo', body).then(function (d) {
      if (!d || !d.todo) return
      delete WB.dlCalc[key]
      window.showToast(t('workbench.dl.todo_toast'))
      loadTodos()
    })
  }

  // ---- teendo-emlekezteto (#406, otlet a5ecabbe) ------------------------------
  // Csak a tulajdonos SAJAT csatornajara megy. A panel megmondja, ha nincs hova.

  function loadReminder() {
    return api('GET', '/api/workbench/todo-reminder').then(function (r) {
      if (!r.ok) { WB.tdRemError = r.message; WB.tdRem = null; render(); return }
      WB.tdRemError = null
      WB.tdRem = (r.data && r.data.reminder) || null
      render()
    })
  }

  function tdTimeText(sec) {
    try { return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (_e) { return String(sec) }
  }

  function reminderBoxHtml() {
    if (WB.tdRemError) {
      return '<div class="wb-td-rem"><p class="wb-error">' + esc(WB.tdRemError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="td-rem-retry">' + esc(t('workbench.tpl.retry')) + '</button></div>'
    }
    var rm = WB.tdRem
    if (!rm) return '<div class="wb-td-rem"><p class="wb-hint">' + esc(t('workbench.td.rem.loading')) + '</p></div>'
    var ro = archived() || WB.tdRemBusy ? ' disabled' : ''
    var days = [0, 1, 2, 3, 7].map(function (n) {
      return '<option value="' + n + '"' + (rm.days_before === n ? ' selected' : '') + '>' + esc(t('workbench.td.rem.days_' + n)) + '</option>'
    }).join('')
    var status
    if (rm.channel !== 'ok') status = '<p class="wb-hint wb-td-rem-warn">' + esc(t('workbench.td.rem.no_channel')) + '</p>'
    else if (rm.last_error) status = '<p class="wb-error">' + esc(t('workbench.td.rem.last_error', { when: tdTimeText(rm.last_error_at || 0) })) + ' ' + esc(rm.last_error) + '</p>'
    else if (rm.last_sent_at) status = '<p class="wb-hint">' + esc(t('workbench.td.rem.last_sent', { when: tdTimeText(rm.last_sent_at) })) + '</p>'
    else status = '<p class="wb-hint">' + esc(t('workbench.td.rem.never_sent')) + '</p>'
    return '<details class="wb-td-rem"' + (rm.channel !== 'ok' ? ' open' : '') + '><summary>'
      + esc(rm.enabled ? t('workbench.td.rem.summary_on', { time: rm.time, when: t('workbench.td.rem.days_' + rm.days_before) }) : t('workbench.td.rem.summary_off'))
      + '</summary>'
      + '<p class="wb-hint">' + esc(t('workbench.td.rem.intro')) + '</p>'
      + '<div class="wb-td-form">'
      + '<label class="wb-td-date-label"><input type="checkbox" id="wbTdRemOn"' + (rm.enabled ? ' checked' : '') + ro + '> ' + esc(t('workbench.td.rem.enabled')) + '</label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.rem.when')) + ' <select class="wb-input" id="wbTdRemDays"' + ro + '>' + days + '</select></label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.rem.at')) + ' <input class="wb-input" id="wbTdRemTime" type="time" value="' + escA(rm.time) + '"' + ro + '></label>'
      + '<button type="button" class="btn-primary" data-wb-act="td-rem-save"' + ro + '>' + esc(t('workbench.td.rem.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-rem-test"' + (WB.tdRemBusy ? ' disabled' : '') + '>' + esc(t('workbench.td.rem.test')) + '</button>'
      + '</div>'
      + status
      + '</details>'
  }

  function reminderRequest(method, url, body, okKey) {
    if (WB.tdRemBusy) return
    WB.tdRemBusy = true
    render()
    return api(method, url, body).then(function (r) {
      WB.tdRemBusy = false
      if (!r.ok) {
        var detail = r.data && r.data.detail ? ' ' + r.data.detail : ''
        window.showToast(r.message + detail)
        render()
        return loadReminder()
      }
      window.showToast(t(okKey))
      if (r.data && r.data.reminder) { WB.tdRem = r.data.reminder; render(); return }
      return loadReminder()
    })
  }

  function saveReminderFromForm() {
    var on = document.getElementById('wbTdRemOn')
    var days = document.getElementById('wbTdRemDays')
    var time = document.getElementById('wbTdRemTime')
    var body = { enabled: !!(on && on.checked) }
    if (days && days.value !== undefined && days.value !== '') body.days_before = Number(days.value)
    if (time && time.value) body.time = time.value
    reminderRequest('PUT', '/api/workbench/todo-reminder', body, 'workbench.td.rem.saved')
  }

  /** Eszkozsor-panel: a projekt MINDEN teendoje, lejart / ma / kozelgo / hatarido nelkul / kesz. */
  function todosPanelHtml() {
    if (!WB.tdOpen) return ''
    var body = ''
    if (WB.tdError) {
      body = '<p class="wb-error">' + esc(WB.tdError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="td-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.todos === null) {
      body = '<p class="wb-hint">' + esc(t('workbench.td.loading')) + '</p>'
    } else if (!WB.todos.length) {
      body = '<p class="wb-hint">' + esc(t('workbench.td.empty_project')) + '</p>'
    } else {
      var groups = { overdue: [], today: [], upcoming: [], nodate: [], done: [] }
      WB.todos.forEach(function (x) {
        if (x.done_at != null) groups.done.push(x)
        else if (!x.due_date) groups.nodate.push(x)
        else groups[tdDueState(x)].push(x)
      })
      var hasDue = groups.overdue.length + groups.today.length + groups.upcoming.length > 0
      body = (hasDue ? '<p><a class="btn-secondary wb-td-ics-all" href="/api/workbench/todos/ics?project=' + encodeURIComponent(WB.projectId)
        + '&lang=' + encodeURIComponent(window._lang || 'hu') + '" download>' + esc(t('workbench.td.all_to_calendar')) + '</a></p>' : '')
        + tdGcalSetupHtml(WB.todos)
        + ['overdue', 'today', 'upcoming', 'nodate', 'done'].map(function (g) {
          if (!groups[g].length) return ''
          return '<h3 class="wb-search-group">' + esc(t('workbench.td.group.' + g, { n: groups[g].length })) + '</h3>'
            + '<ul class="wb-td-list">' + groups[g].map(function (x) { return tdRowHtml(x, true) }).join('') + '</ul>'
        }).join('')
    }
    return '<section class="wb-caps-panel wb-td-panel" id="wbTdPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.td.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.td.intro')) + '</p>'
      + reminderBoxHtml()
      + body
      + '</section>'
  }

  function tdRequest(method, url, body, toastKey) {
    if (WB.tdBusy) return
    var pid = WB.projectId
    WB.tdBusy = true
    render()
    return api(method, url, body).then(function (r) {
      WB.tdBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (toastKey === 'add') {
        var el = document.getElementById('wbTdText'); if (el) el.value = ''
        var d = document.getElementById('wbTdDue'); if (d) d.value = ''
        var rp = document.getElementById('wbTdRepeat'); if (rp) rp.value = ''
      }
      // Ismetlodo teendo kipipalasa: megmondjuk, mikorra jott a kovetkezo.
      var nx = toastKey === 'done' && r.data && r.data.next
      window.showToast(nx && nx.due_date
        ? t('workbench.td.toast.done_next', { date: tdDateText(nx.due_date, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) })
        : t('workbench.td.toast.' + toastKey))
      return loadTodos(pid)
    })
  }

  function addTodoFromForm() {
    if (!WB.detail) return
    var el = document.getElementById('wbTdText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!text) { window.showToast(t('workbench.td.empty_text')); return }
    var due = document.getElementById('wbTdDue')
    var rp = document.getElementById('wbTdRepeat')
    var repeat = (rp && rp.value) || ''
    if (repeat && !(due && due.value)) { window.showToast(t('workbench.td.repeat_needs_due')); return }
    tdRequest('POST', '/api/workbench/todos', { item_id: WB.detail.item.id, text: text, due_date: (due && due.value) || '', repeat: repeat }, 'add')
  }

  // ---- projekt-attekinto (#406, 2. pont) -------------------------------------

  /** TG 1854: open a kanban card from the overview tiles in the usual card
   *  window; the Workbench stays open and only its overview refreshes after. */
  function openCard(cardId) {
    if (!cardId) return
    if (typeof window._prjOpenCardHere !== 'function') return
    var pid = WB.projectId
    window._prjOpenCardHere(cardId, {
      onClose: function () { if (WB.open && WB.projectId === pid) loadOverview(pid) },
    })
  }
  function loadOverview(projectId) {
    return api('GET', '/api/workbench/overview?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.overviewError = r.message; render(); return }
      WB.overviewError = null
      WB.overview = (r.data && r.data.overview) || null
      render()
    })
  }

  /** The work item's own number, "28M" (M = munkadarab), in its own color so it
   *  never reads as kanban card #28 -- the owner can name it in the chat (TG 1843). */
  function workSeqText(it) { return it && it.seq ? it.seq + 'M' : '' }
  function workSeqHtml(it) {
    var s = workSeqText(it)
    return s ? '<span class="wb-work-seq" title="' + escA(t('workbench.work_seq.title', { n: s })) + '">' + esc(s) + '</span> ' : ''
  }

  function ovItemsHtml(items) {
    if (!items || !items.length) return ''
    // A work item must never look like a kanban card (Boss, TG 1815): its own
    // colored frame, a "Munkadarab" tag top-left, and the title as a button.
    return '<ul class="wb-ov-list wb-ov-works">' + items.map(function (it) {
      return '<li class="wb-ov-work"><span class="wb-ov-work-tag">' + esc(t('workbench.ov.work_tag')) + '</span>'
        + '<button type="button" class="wb-ov-work-btn" data-wb-item="' + escA(it.id) + '">' + workSeqHtml(it) + esc(it.title) + '</button></li>'
    }).join('') + '</ul>'
  }

  /** One tile: the head (column name + number) is the fold switch for ALL
   *  four lists, so the row stays aligned. `always` shows even when folded
   *  (error hints, the approvals link); `list` only when open. */
  function ovTile(cls, title, count, always, list) {
    var open = WB.ovOpen
    return '<div class="wb-ov-tile ' + cls + '">'
      + '<button type="button" class="wb-ov-head" data-wb-act="ov-fold" aria-expanded="' + (open ? 'true' : 'false') + '"'
      + ' title="' + escA(t(open ? 'workbench.ov.fold_close' : 'workbench.ov.fold_open')) + '">'
      + '<span class="wb-ov-title">' + esc(title) + ' <span class="wb-ov-caret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span></span>'
      + (count === null ? '' : '<span class="wb-ov-num">' + esc(String(count)) + '</span>')
      + '</button>'
      + (always || '') + (open ? (list || '') : '') + '</div>'
  }

  // Minden jovahagyas KULON kis kartya: sorszam + cim + datum, ahogy a
  // kanban-tablan (Boss, 2026-09-26, TG 6535). Kartya nelkuli jegynel a
  // leiras elso sora a cim.
  function ovCardsHtml(list) {
    if (!list || !list.length) return ''
    return '<ul class="wb-ov-list wb-ov-approvals">' + list.map(function (c) {
      // TG 1854: a card on the tile opens in the usual card window, like on the board.
      return '<li class="wb-ov-approval wb-ov-card-open" data-wb-act="card-open" data-wb-card="' + esc(c.id) + '" role="button" tabindex="0" title="' + esc(t('workbench.ov.card_open_title')) + '">'
        + '<span class="wb-ov-apv-title"><span class="wb-ov-apv-seq">#' + esc(String(c.seq)) + '</span> ' + esc(c.title) + '</span>'
        + (c.updated_at ? '<span class="wb-ov-apv-when">' + esc(when(c.updated_at)) + '</span>' : '') + '</li>'
    }).join('') + '</ul>'
  }
  function ovApprovalHtml(a) {
    var head = a.card_seq
      ? '<span class="wb-ov-apv-seq">#' + esc(String(a.card_seq)) + '</span> ' + esc(a.card_title || a.description)
      : esc(a.description)
    var open = a.card_id
      ? ' wb-ov-card-open" data-wb-act="card-open" data-wb-card="' + esc(a.card_id) + '" role="button" tabindex="0" title="' + esc(t('workbench.ov.card_open_title')) + '"'
      : '"'
    return '<li class="wb-ov-approval' + open + '>'
      + '<span class="wb-ov-apv-title">' + head + '</span>'
      + (a.requested_at ? '<span class="wb-ov-apv-when">' + esc(t('workbench.ov.apv_when', { when: when(a.requested_at) })) + '</span>' : '')
      + '</li>'
  }
  function ovNone(key, params) { return '<p class="wb-hint">' + esc(t(key, params)) + '</p>' }
  /** The number counts everything, an opened list shows the first few: say
   *  how many are left out and lead to the project's Kanban tab, where all of
   *  them are -- a silent cut reads as a wrong number (TG 2068). */
  function ovMore(total, shown) {
    if (total === null || total === undefined || total - shown <= 0) return ''
    return '<p class="wb-hint wb-ov-more">' + esc(t('workbench.ov.more', { n: total - shown }))
      + ' <button type="button" class="wb-linklike" data-wb-act="ov-kanban">' + esc(t('workbench.ov.more_open')) + '</button></p>'
  }
  function ovLen(a) { return (a && a.length) || 0 }

  /** Egy pillantasra, a kanban oszlopneveivel: Tervezett, Folyamatban,
   *  Jovahagyasra var, Kesz. Minden szam MERT: ha egy forras nem valaszolt, azt kimondjuk, es a
   *  helyere nem irunk nullat. */
  function overviewHtml() {
    if (WB.overviewError) {
      return '<section class="wb-ov" aria-label="' + escA(t('workbench.ov.title')) + '">'
        + '<p class="wb-preview-bad">' + esc(t('workbench.ov.error', { message: WB.overviewError })) + '</p></section>'
    }
    var o = WB.overview
    if (!o) return '<section class="wb-ov"><p class="wb-muted">' + esc(t('workbench.ov.loading')) + '</p></section>'

    // EGYSOROS SZAMSOR (Boss, 2026-09-30, TG 2011, "B"): a kanban oszlopainak
    // nevei es a projekt szamai; a kartyalista alapbol csukva, a csempe fejere
    // kattintva lenyilik es visszacsukhato (TG 2068). Minden szam MERT: ha egy
    // forras nem valaszolt, azt kimondjuk, es nem irunk helyette nullat.
    var cards = o.cards || {}
    var cols = o.columns || {}
    var work = o.work || {}
    var blind = cards.open === null
    var blindHint = blind ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.cards_unknown', { message: cards.error || '' })) + '</p>' : ''
    function colOf(k) { return cols[k] || { count: 0, cards: [] } }
    function num(n) { return n === null || n === undefined ? null : n }
    function sum(a, b) { return a === null ? null : a + (b || 0) }

    var pl = colOf('planned')
    var plDraft = work.draft || { count: 0, items: [] }
    var plCount = sum(num(pl.count), plDraft.count || 0)
    var plList = ovCardsHtml(pl.cards) + ovItemsHtml(plDraft.items)
      + ovMore(plCount, ovLen(pl.cards) + ovLen(plDraft.items))
      + (plCount === 0 ? ovNone('workbench.ov.planned_none') : '')

    var ip = colOf('in_progress')
    var ipWork = work.in_progress || { count: 0, items: [] }
    var ipCount = sum(num(ip.count), ipWork.count || 0)
    var ipList = ovCardsHtml(ip.cards) + ovItemsHtml(ipWork.items)
      + ovMore(ipCount, ovLen(ip.cards) + ovLen(ipWork.items))
      + (ipCount === 0 ? ovNone('workbench.ov.progress_none') : '')

    // Jovahagyasra var: a kanban oszlop kartyai + a kartya NELKULI jegyek +
    // az atnezesre varo munkadarabok. Egy kartyara szolo jegy nem szamolodik
    // ketszer, ha a kartya mar az oszlopban all. Ezt a szerver donti el a
    // TELJES halmazon (`in_waiting`, `extra`): itt a listak otre vagva jonnek.
    var wt = colOf('waiting')
    var ap = o.approvals || {}
    var seen = {}
    ;(wt.cards || []).forEach(function (c) { seen[c.seq] = true })
    var extraAp = (ap.items || []).filter(function (a) { return typeof a.in_waiting === 'boolean' ? !a.in_waiting : !(a.card_seq && seen[a.card_seq]) })
    var extraN = typeof ap.extra === 'number' ? ap.extra : extraAp.length
    var reviewCount = (o.review && o.review.count) || 0
    var wtCount = ap.count === null ? null : sum(num(wt.count), extraN + reviewCount)
    var wtBody = (ap.count === null ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.approvals_unknown', { message: ap.error || '' })) + '</p>' : '')
      + (ap.count ? '<p><button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.ov.goto_approvals')) + '</button></p>' : '')

    var wtList = ovCardsHtml(wt.cards)
      + (extraAp.length ? '<ul class="wb-ov-list wb-ov-approvals">' + extraAp.map(ovApprovalHtml).join('') + '</ul>' : '')
      + ovItemsHtml(o.review && o.review.items)
      + ovMore(wtCount, ovLen(wt.cards) + extraAp.length + ovLen(o.review && o.review.items))
      + (wtCount === 0 ? ovNone('workbench.ov.wait_none') : '')

    var dn = colOf('done')
    var rd = o.recent_done || {}
    var dnCount = sum(num(dn.count), rd.count || 0)
    var dnList = ovCardsHtml(dn.cards) + ovItemsHtml(rd.items)
      + ovMore(dnCount, ovLen(dn.cards) + ovLen(rd.items))
      + (dnCount === 0 ? ovNone('workbench.ov.done_none', { days: rd.days || 14 }) : '')

    return '<section class="wb-ov' + (WB.ovOpen ? ' wb-ov-open' : '') + '" aria-label="' + escA(t('workbench.ov.title')) + '">'
      + ovTile('wb-ov-planned', t('kanban.col.planned'), plCount, blindHint, plList)
      + ovTile('wb-ov-progress', t('kanban.col.in_progress'), ipCount, '', ipList)
      + ovTile('wb-ov-wait' + (wtCount ? ' wb-ov-attn' : ''), t('kanban.col.waiting'), wtCount, wtBody, wtList)
      + ovTile('wb-ov-done', t('workbench.ov.done_col', { days: rd.days || 14 }), dnCount, '', dnList)
      + '</section>'
  }

  /** Egy munkadarab lesz az aktualis: kozepen az o szerkesztoje, a chat az o
   *  beszelgetese. A lista, a valto es a lepteto gombok mind ezt hivjak. */
  function selectItem(id) {
    if (!id) return
    WB.selectedId = id
    WB.panel = 'editor'
    // Mas munkadarab: a felig nyitott resz-szerkesztes nem szivaroghat at.
    WB.partEdit = null
    WB.partNewOpen = false
    loadDetail(WB.selectedId)
    // Mas munkadarab = MAS beszelgetes: a hozza tartozot toltjuk be.
    loadChatHistory()
    // Nyitott "Technikai reszletek": az uj munkadarab naploja kell (K-1.33).
    if (WB.techOpen) loadEgress()
  }

  function loadDetail(id) {
    WB.detail = null
    WB.textEdit = null
    if (WB.img && WB.img.itemId !== id) WB.img = null
    if (WB.vid && WB.vid.itemId !== id) WB.vid = null
    if (WB.docEdit && WB.docEdit.itemId !== id) WB.docEdit = null
    if (WB.pdfEdit && WB.pdfEdit.itemId !== id) {
      if (WB.pdfEdit.doc && WB.pdfEdit.doc.destroy) { try { WB.pdfEdit.doc.destroy() } catch (_e) {} }
      WB.pdfEdit = null
    }
    if (WB.compare && WB.compare.itemId !== id) WB.compare = null
    WB.preview = null
    WB.previewVersion = null
    WB.versionBusy = false
    WB.canvas = null
    WB.canvasError = null
    WB.canvasEdit = null
    // Mas munkadarab = mas vaszon: a kijeloles nem szivaroghat at.
    WB.canvasSel = null
    WB.canvasPick = {}
    WB.canvasPlatformPick = null
    WB.canvasAi = null
    WB.vt = null
    WB.vtError = null
    WB.vtBusy = false
    WB.deck = null
    WB.deckSlide = null
    WB.deckError = null
    WB.deckExported = null
    render()
    loadPreview(id, null)
    return api('GET', '/api/workbench/items/' + encodeURIComponent(id)).then(function (r) {
      if (WB.selectedId !== id) return
      if (!r.ok) { window.showToast(r.message); return }
      WB.detail = r.data
      render()
      scheduleDocPoll(id)
      // A rajz-fajta munkadarabnal magatol megnezzuk, van-e mar vaszon. Mas
      // fajtanal nem kerdezunk feleslegesen -- ott az elonezet mondja meg, ha
      // megis rajz all mogotte.
      if (canvasKind(r.data && r.data.item) || (r.data && r.data.item && r.data.item.type === 'composite')) loadCanvas(id)
      if (r.data && r.data.item && r.data.item.type === 'video') loadVideoTimeline(id)
      if (r.data && r.data.item && r.data.item.type === 'presentation') loadDeck(id)
    })
  }

  // ---- panelek --------------------------------------------------------------

  /** Archivalt projektben nem keletkezik uj munkadarab -- a meglevok latszanak. */
  function archived() { return !!(WB.project && WB.project.archived) }

  function typeLabel(type) { return t('workbench.type.' + type) }
  function statusLabel(status) { return t('workbench.status.' + status) }

  /** One row of the work item list (#454: indented by its folder depth). */
  function itemRowHtml(it, depth) {
    var on = it.id === WB.selectedId
    // A csillag KULON gomb a sorban (gombba gomb nem agyazhato), es nem
    // data-wb-item: a kattintas nem nyitja meg a munkadarabot (#406, 21bcb1f4).
    var pinned = it.pinned_at != null
    var pinLabel = t(pinned ? 'workbench.pin.remove' : 'workbench.pin.add')
    return '<li class="wb-item-row' + (pinned ? ' wb-item-pinned' : '') + ' wb-depth-' + Math.min(depth, 8) + '" data-wb-ctx-item="' + escA(it.id) + '"'
      + (archived() ? '' : ' draggable="true" data-wb-drag-item="' + escA(it.id) + '"') + '>'
      + '<button type="button" class="wb-item-pin" data-wb-act="item-pin" data-wb-pin="' + escA(it.id) + '" aria-pressed="' + pinned + '"'
      + ' aria-label="' + escA(pinLabel) + '" title="' + escA(pinLabel) + '"' + (archived() || WB.pinBusy ? ' disabled' : '') + '>'
      + (pinned ? '★' : '☆') + '</button>'
      + '<button type="button" class="wb-item' + (on ? ' wb-item-active' : '') + '" data-wb-item="' + escA(it.id) + '"' + (on ? ' aria-current="true"' : '') + (archived() ? '' : ' title="' + escA(t('workbench.ctx.hint')) + '"') + '>'
      + '<span class="wb-item-title">' + workSeqHtml(it) + esc(it.title) + (itemSensitive(it.id) ? ' <span class="wb-lock" title="' + escA(t('workbench.privacy.badge_title')) + '">🔒</span>' : '') + '</span>'
      + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
      + '</button>'
      // Phones have no right-click, and iOS Safari fires no contextmenu on a long press: a small "..." button
      // (shown only on touch / narrow screens by the CSS) opens the same menu.
      + (archived() ? '' : '<button type="button" class="wb-item-more" data-wb-act="item-ctx" data-wb-id="' + escA(it.id) + '" aria-haspopup="menu"'
        + ' aria-label="' + escA(t('workbench.ctx.more')) + '" title="' + escA(t('workbench.ctx.more')) + '">&#8943;</button>')
      + itemMenuHtml(it)
      + '</li>'
  }

  // ---- jobb egergomb menu a munkadarab soron (Boss, TG 7428): atnevezes, torles, athelyezes ---------
  //
  // A sor csak a csillagot es a nevet mutatja; a ritka muveletek (Szerkesztes, Torles, Athelyezes
  // mappaba) a jobb egerrel (telefonon hosszu nyomassal) nyilo menuben vannak. A gombok ugyanazok a
  // data-wb-act-ok, mint korabban a soron: a kozos esemenykezelo viszi vegig.

  /** The menu lives in the row's own <li> (state: WB.ctx), so it is part of the normal render. */
  function itemMenuHtml(it) {
    var c = WB.ctx
    if (!c || c.id !== it.id || archived()) return ''
    var w = 210, h = 150
    var left = Math.max(4, Math.min(c.x, (window.innerWidth || 1280) - w - 4))
    var top = Math.max(4, Math.min(c.y, (window.innerHeight || 800) - h - 4))
    return '<div class="wb-ctx-menu" role="menu" style="left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px">'
      + '<button type="button" role="menuitem" data-wb-act="item-rename-row" data-wb-id="' + escA(it.id) + '">' + esc(t('workbench.rename.row_label')) + '</button>'
      + '<button type="button" role="menuitem" class="wb-ctx-danger" data-wb-act="item-trash" data-wb-id="' + escA(it.id) + '"'
      + (WB.trashBusy ? ' disabled' : '') + ' title="' + escA(t('workbench.trash.delete_hint')) + '">' + esc(t('workbench.trash.delete')) + '</button>'
      + moveSelectHtml(it)
      + '</div>'
  }

  /** The folder's right-click menu (rename / delete): the pencil and bin no longer sit on the row. */
  function folderMenuHtml(f) {
    var c = WB.ctx
    if (!c || c.folder !== f || archived()) return ''
    var left = Math.max(4, Math.min(c.x, (window.innerWidth || 1280) - 214))
    var top = Math.max(4, Math.min(c.y, (window.innerHeight || 800) - 100))
    var imgs = folderImages(f).length
    return '<div class="wb-ctx-menu" role="menu" style="left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px">'
      + (imgs ? '<button type="button" role="menuitem" data-wb-act="folder-to-deck" data-wb-folder="' + escA(f) + '"' + (WB.fileBusy ? ' disabled' : '')
        + ' title="' + escA(t('workbench.folder.to_deck_hint', { n: imgs })) + '">' + esc(t('workbench.folder.to_deck', { n: imgs })) + '</button>' : '')
      + '<button type="button" role="menuitem" data-wb-act="folder-rename" data-wb-folder="' + escA(f) + '">' + esc(t('workbench.folder.rename')) + '</button>'
      + '<button type="button" role="menuitem" class="wb-ctx-danger" data-wb-act="folder-delete" data-wb-folder="' + escA(f) + '">' + esc(t('workbench.folder.delete')) + '</button>'
      + '</div>'
  }

  function closeItemMenu() {
    if (!WB.ctx) return
    WB.ctx = null
    render()
  }

  document.addEventListener('contextmenu', function (e) {
    if (!WB.open || archived() || !e.target || !e.target.closest) return
    var row = e.target.closest('[data-wb-ctx-item]')
    var frow = row ? null : e.target.closest('[data-wb-ctx-folder]')
    var xrow = row || frow ? null : e.target.closest('[data-wb-ctx-file]')
    if (!row && !frow && !xrow) return
    e.preventDefault()
    WB.ctx = row ? { id: row.getAttribute('data-wb-ctx-item'), x: e.clientX || 0, y: e.clientY || 0 }
      : frow ? { folder: frow.getAttribute('data-wb-ctx-folder'), x: e.clientX || 0, y: e.clientY || 0 }
      : { file: xrow.getAttribute('data-wb-ctx-file'), x: e.clientX || 0, y: e.clientY || 0 }
    render()
  })
  // Capturing: an outside click closes the menu; a click on a menu button lets the shared handler
  // run first, then the menu goes.
  document.addEventListener('click', function (e) {
    if (!WB.ctx || !e.target || !e.target.closest) return
    if (!e.target.closest('.wb-ctx-menu')) closeItemMenu()
    else if (e.target.closest('button, a')) setTimeout(closeItemMenu, 0)
  }, true)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeItemMenu() })

  /** The "Move to folder..." options: a prompt line, the box itself, then every folder indented by depth. */
  function folderOptionsHtml() {
    var wf = WB.workFolders || { box: null, folders: [] }
    var box = wf.box
    var opts = ['<option value="">' + esc(t('workbench.move.label')) + '</option>',
      '<option value="' + escA('\u0000box') + '">' + esc(t('workbench.folder.pick_default')) + '</option>']
    ;(wf.folders || []).forEach(function (f) {
      var depth = f.split('/').length - 1 - (box.split('/').length - 1)
      var pad = new Array(Math.max(depth, 0) + 1).join('\u00a0\u00a0')
      opts.push('<option value="' + escA(f) + '">' + pad + '\ud83d\udcc1 ' + esc(baseOf(f)) + '</option>')
    })
    return opts.join('')
  }

  /** A compact "Move to folder..." list on every item row (the drag is the other way to do the same). */
  function moveSelectHtml(it) {
    var wf = WB.workFolders || { box: null, folders: [] }
    if (archived() || !wf.box) return ''
    return '<select class="wb-item-move" data-wb-move="' + escA(it.id) + '" aria-label="' + escA(t('workbench.move.label')) + '"'
      + (WB.moveBusy ? ' disabled' : '') + '>' + folderOptionsHtml() + '</select>'
  }

  /** The same list for loose files: `which` is a file's rel, or '*' for every ticked file. */
  function moveFilesSelectHtml(which) {
    var wf = WB.workFolders || { box: null, folders: [] }
    if (archived() || !wf.box) return ''
    return '<select class="wb-item-move" data-wb-move-files="' + escA(which) + '" aria-label="' + escA(t('workbench.files.move_label')) + '"'
      + (WB.fileBusy ? ' disabled' : '') + '>' + folderOptionsHtml().replace(esc(t('workbench.move.label')), esc(t('workbench.files.move_label'))) + '</select>'
  }

  /** Ticked loose files (or one) -> a folder of the box; the server skips what would overwrite or break. */
  function moveFilesToFolder(which, folder) {
    if (!which || WB.fileBusy || archived()) return
    keepSelName()
    var rels = which === '*' ? Object.keys(WB.fileSel || {}) : [which]
    if (!rels.length) { window.showToast(t('workbench.files.none')); return }
    var pid = WB.projectId
    WB.fileBusy = true
    render()
    api('POST', '/api/workbench/files-move', { project_id: pid, rels: rels, folder: folder }).then(function (r) {
      WB.fileBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      var d = r.data || {}
      if (d.work_folders) WB.workFolders = d.work_folders
      if (d.items) WB.items = d.items
      // A moved file's old path is no longer ticked; skipped ones stay ticked so the user sees what is left.
      var skippedNames = {}
      ;(d.skipped || []).forEach(function (s) { skippedNames[s.name] = true })
      Object.keys(WB.fileSel || {}).forEach(function (rel) { if (!skippedNames[baseOf(rel)]) delete WB.fileSel[rel] })
      render()
      var sk = d.skipped || []
      var why = { name_taken: 0, in_use: 0, same_place: 0, not_loose: 0, failed: 0 }
      sk.forEach(function (s) { why[s.reason] = (why[s.reason] || 0) + 1 })
      var msg = t('workbench.files.moved', { n: (d.moved || []).length })
      if (sk.length) msg += ' ' + t('workbench.files.skipped', { n: sk.length, taken: why.name_taken, used: why.in_use, same: why.same_place, other: why.not_loose + why.failed })
      window.showToast(msg)
    })
  }

  function moveItemToFolder(itemId, folder) {
    if (!itemId || WB.moveBusy || archived()) return
    var pid = WB.projectId
    WB.moveBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/folder', { folder: folder === '\u0000box' ? '' : folder }).then(function (r) {
      WB.moveBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      var d = r.data || {}
      if (d.work_folders) WB.workFolders = d.work_folders
      if (d.items) WB.items = d.items
      if (WB.detail && d.item && WB.detail.item && WB.detail.item.id === d.item.id) WB.detail.item = d.item
      render()
      window.showToast(t(d.moved ? 'workbench.move.done' : 'workbench.move.' + (d.reason === 'same_place' ? 'same' : d.reason === 'own_folder' ? 'own' : d.reason === 'missing' ? 'missing' : 'blocked')))
    })
  }

  // ---- folders (#454) ---------------------------------------------------------
  //
  // Boss: there is no main / sub work item any more, only FOLDERS. A folder holds
  // work items and other folders; the list shows them as a collapsible tree.
  // The tree comes from the folders on disk (server: work_folders) plus the
  // folder each work item lives in.

  function dirOf(path) { var i = String(path).lastIndexOf('/'); return i < 0 ? '' : String(path).slice(0, i) }
  function baseOf(path) { var i = String(path).lastIndexOf('/'); return i < 0 ? String(path) : String(path).slice(i + 1) }

  /** Where an item sits in the tree: inside its own folder (always shown as a folder row), else the folder it was filed in. */
  function itemPlaces(items, folders, box) {
    var place = {}
    items.forEach(function (it) { place[it.id] = it.folder || it.container_folder || box })
    return place
  }

  /** The key of the fixed Favorites folder in WB.collapsedFolder (a real folder path never contains a star). */
  var FAV_KEY = '*favorites*'

  /** A plain file lying in a work folder (not a work item): a link that opens it in the file viewer. */
  function plainFileRowHtml(f, depth) {
    var kb = f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'
    return '<li class="wb-item-row wb-file-row wb-depth-' + Math.min(depth, 8) + '"' + (archived() ? '' : ' data-wb-ctx-file="' + escA(f.rel) + '"') + '>'
      + (archived() ? '' : '<input type="checkbox" class="wb-file-sel" data-wb-act="file-sel" data-wb-rel="' + escA(f.rel) + '"' + (WB.fileSel && WB.fileSel[f.rel] ? ' checked' : '')
        + ' aria-label="' + escA(t('workbench.sel.label', { name: f.name })) + '" title="' + escA(t('workbench.sel.label', { name: f.name })) + '">')
      + '<a class="wb-item wb-file-link" href="/api/life/file?rel=' + escA(encodeURIComponent(f.rel)) + '" target="_blank" rel="noopener" title="' + escA(t('workbench.file.open')) + '">'
      + '<span class="wb-item-title">\ud83d\udcc4 ' + esc(f.name) + '</span>'
      + '<span class="wb-item-meta">' + esc(kb) + '</span></a>'
      + (archived() ? '' : '<button type="button" class="wb-item-more" data-wb-act="file-ctx" data-wb-rel="' + escA(f.rel) + '" aria-haspopup="menu"'
        + ' aria-label="' + escA(t('workbench.ctx.more_file')) + '" title="' + escA(t('workbench.ctx.more_file')) + '">&#8943;</button>')
      + fileMenuHtml(f.rel)
      + '</li>'
  }

  /** The loose file's menu (right-click / the "..." button): open, download, make it a work item (Boss, TG 7626), move, rename, delete. */
  function fileMenuHtml(rel) {
    var c = WB.ctx
    if (!c || c.file !== rel || archived()) return ''
    var left = Math.max(4, Math.min(c.x, (window.innerWidth || 1280) - 214))
    var top = Math.max(4, Math.min(c.y, (window.innerHeight || 800) - 290))
    var many = WB.fileSel && WB.fileSel[rel] && Object.keys(WB.fileSel).length > 1
    var href = '/api/life/file?rel=' + encodeURIComponent(rel)
    return '<div class="wb-ctx-menu" role="menu" style="left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px">'
      // #483 "every usable function": Open and Download act on this one file, so they are not offered for a multi-selection.
      + (many ? '' : '<a role="menuitem" class="wb-ctx-link" data-wb-file-open="1" href="' + escA(href) + '" target="_blank" rel="noopener">' + esc(t('workbench.file.open_menu')) + '</a>'
        + '<a role="menuitem" class="wb-ctx-link" data-wb-file-download="1" href="' + escA(href + '&download=1') + '" download="' + escA(baseOf(rel)) + '">' + esc(t('workbench.file.download')) + '</a>')
      + '<button type="button" role="menuitem" data-wb-act="file-to-item" data-wb-rel="' + escA(rel) + '"' + (WB.fileBusy ? ' disabled' : '') + '>' + esc(t('workbench.file.to_item')) + '</button>'
      + moveFilesSelectHtml(many ? '*' : rel)
      + (many ? '' : '<button type="button" role="menuitem" data-wb-act="file-rename" data-wb-rel="' + escA(rel) + '"' + (WB.fileBusy ? ' disabled' : '') + '>' + esc(t('workbench.file.rename')) + '</button>')
      + '<button type="button" role="menuitem" class="wb-ctx-danger" data-wb-act="file-delete" data-wb-rel="' + escA(many ? '*' : rel) + '"' + (WB.fileBusy ? ' disabled' : '') + '>' + esc(t(many ? 'workbench.file.delete_many' : 'workbench.file.delete')) + '</button>'
      + '</div>'
  }

  /** #483: delete one loose file (or every ticked one when `which` is '*'), only after the user confirms by name/count. */
  function deleteFiles(which) {
    if (!which || WB.fileBusy || archived()) return
    var rels = which === '*' ? Object.keys(WB.fileSel || {}) : [which]
    if (!rels.length) { window.showToast(t('workbench.files.none')); return }
    var ask = rels.length === 1 ? t('workbench.file.delete_confirm', { name: baseOf(rels[0]) }) : t('workbench.file.delete_confirm_many', { n: rels.length })
    if (!window.confirm(ask)) { WB.ctx = null; render(); return }
    keepSelName()
    var pid = WB.projectId
    WB.fileBusy = true
    WB.ctx = null
    render()
    api('POST', '/api/workbench/files-delete', { project_id: pid, rels: rels }).then(function (r) {
      WB.fileBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      var d = r.data || {}
      if (d.work_folders) WB.workFolders = d.work_folders
      if (d.items) WB.items = d.items
      // A deleted file is no longer ticked; skipped ones stay ticked so the user sees what is left.
      var skippedNames = {}
      ;(d.skipped || []).forEach(function (s) { skippedNames[s.name] = true })
      Object.keys(WB.fileSel || {}).forEach(function (rel) { if (!skippedNames[baseOf(rel)]) delete WB.fileSel[rel] })
      render()
      var sk = d.skipped || []
      var msg = t('workbench.file.deleted', { n: (d.deleted || []).length })
      if (sk.length) msg += ' ' + t('workbench.file.delete_skipped', { n: sk.length })
      window.showToast(msg)
    })
  }

  /** #483: rename one loose file in place; the server refuses a taken name and keeps a deck picture's links alive. */
  function renameFile(rel) {
    if (!rel || WB.fileBusy || archived()) return
    WB.ctx = null
    var cur = baseOf(rel)
    var name = window.prompt(t('workbench.file.rename_prompt', { name: cur }), cur)
    if (name == null) { render(); return }
    name = String(name).trim()
    if (!name || name === cur) { render(); return }
    var pid = WB.projectId
    WB.fileBusy = true
    render()
    api('POST', '/api/workbench/files-rename', { project_id: pid, rel: rel, name: name }).then(function (r) {
      WB.fileBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      var d = r.data || {}
      if (d.work_folders) WB.workFolders = d.work_folders
      if (d.items) WB.items = d.items
      // The ticked state follows the new path.
      if (WB.fileSel && WB.fileSel[rel]) { delete WB.fileSel[rel]; WB.fileSel[dirOf(rel) + '/' + d.name] = true }
      render()
      window.showToast(t('workbench.file.renamed', { name: d.name }))
    })
  }

  /** The images lying directly in a work folder, in natural order (s2 before s10). */
  function folderImages(folder) {
    var wf = WB.workFolders || { files: {} }
    var list = ((wf.files || {})[folder] || []).filter(function (f) { return isImageFile({ name: f.name }) })
    return list.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }) })
  }

  function folderTreeRows() {
    var wf = WB.workFolders || { box: null, folders: [] }
    var box = wf.box || ''
    var items = WB.items || []
    var folders = (wf.folders || []).slice()
    var place = itemPlaces(items, folders, box)
    var shown = folders
    var have = {}
    shown.forEach(function (f) { have[f] = true })
    // A place that is not in the folder list (list cut off, folder gone) falls back to the box.
    Object.keys(place).forEach(function (id) { if (place[id] !== box && !have[place[id]]) place[id] = box })
    var kids = {}
    shown.forEach(function (f) { var d = dirOf(f); if (d !== box && !have[d]) d = box; (kids[d] = kids[d] || []).push(f) })
    var byPlace = {}
    items.forEach(function (it) { (byPlace[place[it.id]] = byPlace[place[it.id]] || []).push(it) })
    // A star no longer floats an item to the top of its own folder (Boss, TG 2173): inside a folder the
    // order is by recency; the starred ones are collected in the fixed Favorites folder instead.
    Object.keys(byPlace).forEach(function (k) {
      byPlace[k].sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0) || (b.created_at || 0) - (a.created_at || 0) || String(a.title || '').localeCompare(String(b.title || '')) })
    })
    var plainFiles = wf.files || {}
    function count(path) {
      var n = (byPlace[path] || []).length + (plainFiles[path] || []).length
      ;(kids[path] || []).forEach(function (k) { n += count(k) })
      return n
    }
    var rows = []
    function walk(path, depth) {
      ;(kids[path] || []).forEach(function (f) {
        var collapsed = !!WB.collapsedFolder[f]
        rows.push('<li class="wb-folder-row wb-depth-' + Math.min(depth, 8) + '" data-wb-drop-folder="' + escA(f) + '"' + (archived() ? '' : ' data-wb-ctx-folder="' + escA(f) + '" title="' + escA(t('workbench.ctx.hint')) + '"') + '>'
          + '<button type="button" class="wb-folder-toggle" data-wb-act="folder-fold" data-wb-folder="' + escA(f) + '" aria-expanded="' + (!collapsed) + '"'
          + ' title="' + escA(t(collapsed ? 'workbench.folder.expand' : 'workbench.folder.collapse')) + '">'
          + (collapsed ? '▸ ' : '▾ ') + '📁 ' + esc(baseOf(f)) + ' <span class="wb-muted">(' + count(f) + ')</span></button>'
          + (archived() ? '' : '<button type="button" class="wb-item-more" data-wb-act="folder-ctx" data-wb-folder="' + escA(f) + '" aria-haspopup="menu"'
            + ' aria-label="' + escA(t('workbench.ctx.more_folder')) + '" title="' + escA(t('workbench.ctx.more_folder')) + '">&#8943;</button>')
          + folderMenuHtml(f) + '</li>')
        if (!collapsed) walk(f, depth + 1)
      })
      ;(byPlace[path] || []).forEach(function (it) { rows.push(itemRowHtml(it, depth)) })
      ;(plainFiles[path] || []).forEach(function (f) { rows.push(plainFileRowHtml(f, depth)) })
    }
    // Items directly in the box come first, then the folders would clutter -- keep folders first, items after.
    var favs = items.filter(function (it) { return it.pinned_at != null })
    var favShut = !!WB.collapsedFolder[FAV_KEY]
    rows.push('<li class="wb-folder-row wb-fav-row wb-depth-0">'
      + '<button type="button" class="wb-folder-toggle" data-wb-act="folder-fold" data-wb-folder="' + escA(FAV_KEY) + '" aria-expanded="' + (!favShut) + '"'
      + ' title="' + escA(t(favShut ? 'workbench.folder.expand' : 'workbench.folder.collapse')) + '">'
      + (favShut ? '▸ ' : '▾ ') + '⭐ ' + esc(t('workbench.fav.title')) + ' <span class="wb-muted">(' + favs.length + ')</span></button></li>')
    if (!favShut) {
      if (!favs.length) rows.push('<li class="wb-fav-empty wb-depth-1"><span class="wb-muted">' + esc(t('workbench.fav.empty')) + '</span></li>')
      favs.forEach(function (it) { rows.push(itemRowHtml(it, 1)) })
    }
    walk(box, 0)
    return rows
  }

  /** The project has a work folder system (a box): then step 2 needs a folder chosen in step 1. */
  function hasFolderSystem() {
    return !!(WB.workFolders && WB.workFolders.box)
  }

  /** "Which folder should it go in?" -- a list of the folders (indented by depth) + a "New folder" box. */
  function folderPickHtml() {
    var wf = WB.workFolders || { box: null, folders: [] }
    var box = wf.box || ''
    var pick = WB.pickFolder || ''
    var opts = ['<option value=""' + (!pick ? ' selected' : '') + '>' + esc(t('workbench.folder.pick_none')) + '</option>',
      '<option value="@project"' + (pick === '@project' ? ' selected' : '') + '>' + esc(t('workbench.folder.pick_project')) + '</option>']
    ;(wf.folders || []).forEach(function (f) {
      var depth = f.split('/').length - 1 - (box ? box.split('/').length - 1 : 0)
      var pad = new Array(Math.max(depth, 0) + 1).join('\u00a0\u00a0\u00a0')
      opts.push('<option value="' + escA(f) + '"' + (f === pick ? ' selected' : '') + '>' + pad + '📁 ' + esc(baseOf(f)) + '</option>')
    })
    return '<label class="wb-label" for="wbNewFolder">' + esc(t('workbench.folder.pick_label')) + '</label>'
      + '<select class="wb-input" id="wbNewFolder">' + opts.join('') + '</select>'
      + '<p class="wb-hint">' + esc(t('workbench.folder.pick_hint')) + '</p>'
      + '<div class="wb-folder-new">'
      + '<input class="wb-input" id="wbNewFolderName" type="text" maxlength="80" placeholder="' + escA(t('workbench.folder.new_placeholder')) + '" autocomplete="off">'
      + '<button type="button" class="btn-secondary" data-wb-act="mkfolder"' + (WB.folderBusy ? ' disabled' : '') + '>' + esc(t('workbench.folder.new_btn')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.folder.new_hint')) + '</p>'
  }

  /** Step 1 of creating: the folder system. Always visible (not buried in the manual form),
   *  so folders, sub folders and sibling folders can be made by hand before any work item. */
  function folderStepHtml() {
    return '<div class="wb-folder-step">'
      + '<h3 class="wb-step-title">' + esc(t('workbench.step.folders')) + '</h3>'
      + '<p class="wb-hint">' + esc(t('workbench.step.folders_hint')) + '</p>'
      + folderPickHtml()
      + '</div>'
      + '<h3 class="wb-step-title">' + esc(t('workbench.step.item')) + '</h3>'
  }

  function readNewDraft() {
    var ti = document.getElementById('wbNewTitle')
    var ty = document.getElementById('wbNewType')
    var fo = document.getElementById('wbNewFolder')
    WB.newDraft = { title: ti ? ti.value : '', type: ty ? ty.value : '' }
    if (fo) WB.pickFolder = fo.value
  }

  function makeFolder() {
    if (WB.folderBusy || archived()) return
    var nameEl = document.getElementById('wbNewFolderName')
    var name = nameEl ? String(nameEl.value || '').trim() : ''
    if (!name) { window.showToast(t('workbench.folder.name_required')); return }
    readNewDraft()
    var pid = WB.projectId
    WB.folderBusy = true
    render()
    api('POST', '/api/workbench/folders', { project_id: pid, parent: WB.pickFolder === '@project' ? '' : (WB.pickFolder || ''), name: name }).then(function (r) {
      WB.folderBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (r.data && r.data.work_folders) WB.workFolders = r.data.work_folders
      if (r.data && r.data.folder) WB.pickFolder = r.data.folder
      render()
    })
  }

  // A folder goes only when empty; the server says what is still inside when it is not.
  function deleteFolder(folder) {
    if (WB.folderBusy || archived() || !folder) return
    if (!window.confirm(t('workbench.folder.delete_confirm', { name: baseOf(folder) }))) return
    var pid = WB.projectId
    WB.folderBusy = true
    api('DELETE', '/api/workbench/folders', { project_id: pid, folder: folder, trash: true }).then(function (r) {
      WB.folderBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); return }
      if (r.data && r.data.work_folders) WB.workFolders = r.data.work_folders
      if (r.data && r.data.items) WB.items = r.data.items
      if (WB.pickFolder === folder || String(WB.pickFolder || '').indexOf(folder + '/') === 0) WB.pickFolder = ''
      window.showToast(t(r.data && r.data.trashed ? 'workbench.folder.trashed' : 'workbench.folder.deleted'))
      if (WB.selectedId && !(WB.items || []).some(function (x) { return x.id === WB.selectedId })) { WB.selectedId = null; WB.detail = null }
      load(pid)
      render()
    })
  }

  // Rename a plain folder; the server refuses (with a human sentence) when a work item lives in it.
  function renameFolder(folder) {
    if (WB.folderBusy || archived() || !folder) return
    var name = window.prompt(t('workbench.folder.rename_prompt', { name: baseOf(folder) }), baseOf(folder))
    if (name == null) return
    name = String(name).trim()
    if (!name || name === baseOf(folder)) return
    var pid = WB.projectId
    WB.folderBusy = true
    api('POST', '/api/workbench/folders/rename', { project_id: pid, folder: folder, name: name }).then(function (r) {
      WB.folderBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); return }
      if (r.data && r.data.work_folders) WB.workFolders = r.data.work_folders
      if (WB.pickFolder === folder) WB.pickFolder = r.data.folder
      // #478: a folder is a named group: its work items keep their own names; their paths followed the folder.
      window.showToast(t('workbench.folder.renamed'))
      if (r.data && r.data.items) WB.items = r.data.items
      if (WB.selectedId) loadDetail(WB.selectedId)
      load(pid)
      render()
    })
  }

  /** A loose file -> a work item of its natural type (the file stays where it is; the item points at it).
   *  A file that already is an item's source opens that item instead of making a second one. */
  function fileToItem(rel) {
    if (WB.fileBusy || archived() || !rel) return
    var have = (WB.items || []).filter(function (it) { return it.source_path === rel })[0]
    if (have) { selectItem(have.id); window.showToast(t('workbench.file.already_item', { title: have.title })); return }
    var name = baseOf(rel)
    var ext = (name.match(/\.([^.]+)$/) || [])[1] || ''
    ext = ext.toLowerCase()
    var type = isImageFile({ name: name }) ? (ext === 'svg' ? 'graphic' : 'image')
      : /^(md|txt)$/.test(ext) ? 'note'
      : /^(mp4|mov|webm|mkv|avi|m4v)$/.test(ext) ? 'video' : 'document'
    var pid = WB.projectId
    WB.fileBusy = true
    api('POST', '/api/workbench/items', { project_id: pid, type: type, title: name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name, source_path: rel, folder: dirOf(rel) }).then(function (r) {
      WB.fileBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      window.showToast(t('workbench.new.created', { title: r.data.item.title }))
      selectItem(r.data.item.id)
      load(pid)
    })
  }

  /** #475: the ticked files that still exist, split into pictures (file-name order) and the rest. */
  function selectedFiles() {
    var wf = WB.workFolders || { files: {} }
    var have = {}
    Object.keys(wf.files || {}).forEach(function (k) { (wf.files[k] || []).forEach(function (f) { have[f.rel] = f }) })
    var imgs = []
    var other = 0
    Object.keys(WB.fileSel || {}).forEach(function (rel) {
      var f = have[rel]
      if (!f) { delete WB.fileSel[rel]; return }
      if (isImageFile({ name: f.name })) imgs.push(f); else other++
    })
    imgs.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }) || (a.rel < b.rel ? -1 : 1) })
    return { imgs: imgs, other: other, total: imgs.length + other }
  }

  /** The bar above the list while files are ticked: name the deck, make it, or clear the ticks. */
  function selectionBarHtml() {
    if (archived()) return ''
    var sel = selectedFiles()
    if (!sel.total) return ''
    return '<div class="wb-sel-bar" role="group" aria-label="' + escA(t('workbench.sel.count', { n: sel.total })) + '">'
      + '<span class="wb-sel-count">' + esc(t('workbench.sel.count', { n: sel.total })) + '</span>'
      + '<input type="text" id="wbSelDeckName" class="wb-sel-name" maxlength="120" value="' + escA(WB.selName || '') + '" placeholder="' + escA(t('workbench.sel.name_ph')) + '" aria-label="' + escA(t('workbench.sel.name_label')) + '">'
      + '<button type="button" class="btn-primary" data-wb-act="sel-to-deck"' + (WB.fileBusy || !sel.imgs.length ? ' disabled' : '') + '>' + esc(t('workbench.sel.to_deck', { n: sel.imgs.length })) + '</button>'
      + moveFilesSelectHtml('*')
      + '<button type="button" class="btn-secondary" data-wb-act="sel-clear">' + esc(t('workbench.sel.clear')) + '</button>'
      + (sel.other ? '<span class="wb-hint wb-sel-note">' + esc(t('workbench.sel.not_images', { n: sel.other })) + '</span>' : '')
      + '</div>'
  }

  function keepSelName() {
    var el = document.getElementById('wbSelDeckName')
    if (el) WB.selName = el.value
  }

  function toggleFileSel(rel) {
    if (!rel) return
    keepSelName()
    WB.fileSel = WB.fileSel || {}
    if (WB.fileSel[rel]) delete WB.fileSel[rel]; else WB.fileSel[rel] = true
    render()
  }

  /** The ticked pictures -> ONE deck, one slide per picture in file-name order, named by the user. */
  function selectionToDeck() {
    keepSelName()
    var sel = selectedFiles()
    if (WB.fileBusy || archived()) return
    if (!sel.imgs.length) { window.showToast(t('workbench.sel.no_images')); return }
    var name = String(WB.selName || '').trim() || t('workbench.sel.default_name')
    buildDeck(name, sel.imgs, { from_files: true, folder: (WB.workFolders && WB.workFolders.box) || '' }, function () { WB.fileSel = {}; WB.selName = '' })
  }

  /** A folder of pictures -> ONE flippable deck: one slide per picture, in file-name order (Boss, TG 7636). */
  function folderToDeck(folder) {
    if (WB.fileBusy || archived() || !folder) return
    var imgs = folderImages(folder)
    if (!imgs.length) { window.showToast(t('workbench.folder.to_deck_none')); return }
    buildDeck(baseOf(folder), imgs, { folder: folder, adopt_folder: true })
  }

  /** One deck work item with one slide per picture (in the order given); `extra` goes into the create call. */
  function buildDeck(title, imgs, extra, done) {
    var cut = imgs.length > DECK_FROM_FOLDER_MAX
    if (cut) imgs = imgs.slice(0, DECK_FROM_FOLDER_MAX)
    var pid = WB.projectId
    WB.fileBusy = true
    window.showToast(t('workbench.folder.to_deck_working', { n: imgs.length }))
    var create = { project_id: pid, type: 'presentation', title: title }
    Object.keys(extra || {}).forEach(function (k) { create[k] = extra[k] })
    api('POST', '/api/workbench/items', create).then(function (r) {
      if (!r.ok) { WB.fileBusy = false; render(); window.showToast(r.message); return null }
      var item = r.data.item
      var base = '/api/workbench/items/' + encodeURIComponent(item.id) + '/deck/ops'
      // A fresh deck is empty and ids run d1..dN, so slide i is 'd'+i. 20 pictures a call = 40 ops (limit 100).
      var chain = Promise.resolve({ ok: true })
      for (var from = 0; from < imgs.length; from += 20) {
        (function (start) {
          chain = chain.then(function (prev) {
            if (!prev.ok) return prev
            var ops = []
            imgs.slice(start, start + 20).forEach(function () { ops.push({ op: 'addSlide', layout: 'blank' }) })
            imgs.slice(start, start + 20).forEach(function (f, k) {
              ops.push({ op: 'slide', id: 'd' + (start + k + 1), ops: [{ op: 'add', object: { type: 'image', src: f.rel, x: 0, y: 0, width: 1920, height: 1080, fit: 'contain', alt: f.name } }] })
            })
            return api('POST', base, { ops: ops })
          })
        })(from)
      }
      return chain.then(function (last) {
        WB.fileBusy = false
        if (WB.projectId !== pid) return
        if (!last.ok) { render(); window.showToast(last.message); load(pid); return }
        window.showToast(t('workbench.folder.to_deck_done', { n: imgs.length }) + (cut ? ' ' + t('workbench.folder.to_deck_cut', { max: DECK_FROM_FOLDER_MAX }) : ''))
        if (done) done()
        selectItem(item.id)
        load(pid)
      })
    })
  }
  var DECK_FROM_FOLDER_MAX = 100

  function itemsPanelHtml() {
    var body
    if (WB.items === null) {
      body = '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    } else if (WB.error) {
      body = '<div class="info-box depo-bad">' + esc(WB.error) + '</div>'
    } else if (!WB.items.length) {
      body = '<div class="wb-empty">'
        + '<p class="wb-empty-title">' + esc(t('workbench.empty.title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.empty.hint')) + '</p>'
        + '</div>'
    } else {
      var rows = folderTreeRows()
      body = selectionBarHtml() + '<ul class="wb-items">' + rows.join('') + '</ul>'
    }
    body += trashHtml()
    body += rescueHtml()
    return '<section class="wb-panel wb-panel-items' + (WB.panel === 'items' ? ' wb-panel-current' : '') + '" data-wb-panel-body="items" data-wb-drop="new">'
      + '<div class="wb-panel-head"><h2 class="wb-panel-title">' + esc(t('workbench.panel.items')) + (WB.items && WB.items.length ? ' (' + WB.items.length + ')' : '') + '</h2>'
      // #476: show WHERE the work item lives: the Explorer opens at its folder (no item picked: the work items box).
      + '<button type="button" class="wb-btn wb-folder-btn wb-head-open" data-wb-act="folder-intezo" data-wb-place="' + (WB.selectedId ? 'assets' : 'box') + '"'
      + ' title="' + escA(t(WB.selectedId ? 'workbench.head_open.item_hint' : 'workbench.head_open.box_hint')) + '" aria-label="' + escA(t(WB.selectedId ? 'workbench.head_open.item_hint' : 'workbench.head_open.box_hint')) + '">\ud83d\udcc2 ' + esc(t('workbench.folder.open_short')) + '</button></div>'
      + '<p class="wb-hint">' + esc(t(WB.layout === 'split' ? 'workbench.items.switch_hint_split' : 'workbench.items.switch_hint')) + '</p>'
      + body
      + (archived()
        ? '<p class="wb-hint">' + esc(t('workbench.archived_hint')) + '</p>'
        : folderStepHtml() + (WB.formOpen ? newFormHtml() : '<button type="button" class="btn-primary wb-new-btn" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button>')
          + templatesHtml()
          + uploadZoneHtml())
      + '</section>'
  }

  // ---- behuzas es feltoltes (#406, 3. pont) ----------------------------------
  //
  // Harom ut vezet ugyanoda: (1) fajl ráhúzása a Munkapadra, (2) a "Fajlok
  // kivalasztasa" gomb -- telefonon ez nyitja a galeriat / kamerat --, es
  // (3) beillesztes (Ctrl+V) a vagolaprol. A fajl a PROJEKT mappajaba kerul,
  // sosem ir felul semmit (foglalt nevnel uj nevet kap).
  //
  // HOVA: a munkadarab-listara (vagy barhova mashova) ejtve UJ munkadarab lesz
  // belole; a megnyitott munkadarabra ejtve abba kerul -- a kep uj RESZ lesz,
  // mas fajl uj VERZIO.

  function uploadZoneHtml() {
    var busy = WB.upload
    return '<div class="wb-drop">'
      + '<p class="wb-drop-text">' + esc(busy
        ? t('workbench.upload.progress', { done: busy.done, total: busy.total })
        : t('workbench.upload.drop_new')) + '</p>'
      + '<label class="btn-secondary wb-part-upload" for="wbUploadNew">' + esc(t('workbench.upload.pick')) + '</label>'
      + '<input type="file" id="wbUploadNew" class="wb-file-input" multiple>'
      + '<p class="wb-hint">' + esc(t('workbench.upload.hint')) + '</p>'
      + '</div>'
  }

  /** Nyers bajtok a szervernek; a valasz mindig {ok, data, message}. A
   *  hibanal a SZERVER mondata megy tovabb (a gepi kod csak tartalek). */
  function postFile(url, file) {
    return fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        if (!res.ok) return { ok: false, data: data, message: (data && data.message) || t('workbench.err.http', { status: res.status }) }
        return { ok: true, data: data }
      })
    }).catch(function () { return { ok: false, message: t('workbench.err.network') } })
  }

  function isImageFile(f) {
    if (f && typeof f.type === 'string' && f.type.indexOf('image/') === 0) return true
    return /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test((f && f.name) || '')
  }

  /** `target === 'item'`: a megnyitott munkadarabba (kep -> resz, mas fajl ->
   *  az ANYAGAI koze, #441 -- korabban uj verzio lett belole, es a munkadarab
   *  fo fajlja csendben lecserelodott). `target === 'assets'`: minden fajl az
   *  anyagok koze, a munkadarab sajat mappajaba. Kulonben minden fajlbol UJ
   *  munkadarab, sajat mappaval. Egymas utan megy, hogy a szamlalo pontos
   *  legyen, es egy hiba ne vigye el a tobbit. */
  function uploadFiles(fileList, target) {
    var files = []
    for (var i = 0; fileList && i < fileList.length; i++) if (fileList[i]) files.push(fileList[i])
    if (!files.length || WB.upload || !WB.projectId) return Promise.resolve()
    if (archived()) { window.showToast(t('workbench.archived_hint')); return Promise.resolve() }
    var intoItem = (target === 'item' || target === 'assets') && WB.selectedId ? WB.selectedId : null
    var assetsOnly = target === 'assets'
    var projectId = WB.projectId
    var lang = encodeURIComponent(window._lang || 'hu')
    WB.upload = { done: 0, total: files.length, item: intoItem }
    render()
    var created = []
    var errors = []
    var skipped = 0
    var toAssets = 0
    var chain = Promise.resolve()
    files.forEach(function (f) {
      chain = chain.then(function () {
        var name = encodeURIComponent(f.name || 'fajl')
        var type = encodeURIComponent(f.type || '')
        var url
        var asAsset = intoItem && (assetsOnly || !isImageFile(f))
        if (asAsset) {
          url = '/api/workbench/items/' + encodeURIComponent(intoItem) + '/assets?name=' + name + '&lang=' + lang
        } else if (intoItem) {
          url = '/api/workbench/items/' + encodeURIComponent(intoItem)
            + '/parts/image?new_version=1&name=' + name + '&type=' + type + '&lang=' + lang
        } else {
          url = '/api/workbench/items/upload?project=' + encodeURIComponent(projectId)
            + '&name=' + name + '&type=' + type + '&lang=' + lang
        }
        return postFile(url, f).then(function (r) {
          // Ugyanez a tartalom mar az anyagok kozott van (K-0.18): megkerdezzuk.
          if (!r.ok && asAsset && r.data && r.data.error === 'asset_duplicate') {
            var ex = r.data.existing && r.data.existing.name
            if (window.confirm(t('workbench.assets.duplicate_confirm', { name: f.name || '', existing: ex || f.name || '' }))) {
              return postFile(url + '&force=1', f)
            }
            return { ok: true, skipped: true }
          }
          return r
        }).then(function (r) {
          if (WB.upload) WB.upload.done++
          if (!r.ok) errors.push((f.name ? f.name + ': ' : '') + r.message)
          else if (r.skipped) skipped++
          else if (asAsset) {
            toAssets++
            attachedList(intoItem).push({ name: (r.data && r.data.name) || f.name || '' })
          }
          else if (!intoItem && r.data && r.data.item) created.push(r.data.item)
          if (WB.projectId === projectId) render()
        })
      })
    })
    return chain.then(function () {
      WB.upload = null
      if (WB.projectId !== projectId) return
      var ok = files.length - errors.length - skipped
      if (errors.length) window.showToast(errors.join(' \u2014 '))
      if (ok) {
        window.showToast(!intoItem
          ? t('workbench.upload.done_new', { n: ok })
          : (toAssets === ok
            ? t('workbench.assets.done', { n: ok })
            : t('workbench.upload.done_item', { n: ok })))
      }
      if (intoItem) {
        if (WB.selectedId === intoItem) loadDetail(intoItem)
        load(projectId)
      } else {
        load(projectId)
        // #491: a feltoltes nyers anyag, nem munkadarab (created ures); a hibatlan agon csak ujrarajzolunk.
        if (created.length === 1) selectItem(created[0].id)
        else render()
      }
    })
  }

  function hasFiles(e) {
    var dt = e && e.dataTransfer
    if (!dt) return false
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true
    }
    return !!(dt.files && dt.files.length)
  }

  function inWorkbench(e) {
    return !!(e && e.target && typeof e.target.closest === 'function' && e.target.closest('.wb-root'))
  }

  function dropTarget(e) {
    var zone = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-wb-drop]') : null
    var kind = zone && typeof zone.getAttribute === 'function' ? zone.getAttribute('data-wb-drop') : null
    if (kind === 'assets' && WB.selectedId) return 'assets'
    return kind === 'item' && WB.selectedId ? 'item' : 'new'
  }

  function setDragging(on) {
    var el = root()
    var box = el && typeof el.querySelector === 'function' ? el.querySelector('.wb-root') : null
    if (box && box.classList) box.classList.toggle('wb-dragging', !!on)
  }

  // ---- belepo: "Mit szeretnel letrehozni?" (#441, K-3.1) --------------------
  //
  // Egy mondat vagy egy gomb. A szerver talalja ki a munkatipust; ha nem
  // biztos, NEM hoz letre semmit, hanem visszakerdez -- a felulet ilyenkor a
  // lehetseges tipusokat kinalja, es a mondat megmarad. A letrejott
  // munkadarab rogton megnyilik, a mondat pedig az Agenthez megy.

  var INTAKE_KINDS = ['social_post', 'document', 'court_filing', 'video', 'presentation', 'business_card']
  // The start screens also offer a table (the plan's six buttons); the server's own guess never returns it.
  var INTAKE_UI_KINDS = INTAKE_KINDS.concat(['table'])

  // The social post asks for its platform at creation: the empty canvas gets that size (#493).
  // Sizes match the server's platform list (src/workbench-canvas-platforms.ts); the id is only a UI key.
  var INTAKE_PLATFORMS = [
    { id: 'facebook_post', w: 1200, h: 630 },
    { id: 'instagram_square', w: 1080, h: 1080 },
    { id: 'linkedin_post', w: 1200, h: 627 },
  ]

  function intakePlatformNow() {
    var id = WB.intakePlatform || INTAKE_PLATFORMS[0].id
    return INTAKE_PLATFORMS.filter(function (p) { return p.id === id })[0] || INTAKE_PLATFORMS[0]
  }

  function intakePlatformHtml() {
    var cur = intakePlatformNow()
    return '<div class="wb-intake-platform"><label class="wb-label" for="wbIntakePlatform">' + esc(t('workbench.intake.platform_label')) + '</label>'
      + '<select class="wb-input" id="wbIntakePlatform">' + INTAKE_PLATFORMS.map(function (p) {
        return '<option value="' + escA(p.id) + '"' + (p.id === cur.id ? ' selected' : '') + '>'
          + esc(t('workbench.intake.platform.' + p.id) + ' · ' + p.w + ' × ' + p.h) + '</option>'
      }).join('') + '</select>'
      + '<p class="wb-hint">' + esc(t('workbench.intake.platform_hint')) + '</p></div>'
  }

  function intakeHtml() {
    var ask = WB.intakeAsk
    var kinds = ask ? ask.options : INTAKE_UI_KINDS
    var busy = !!WB.intakeBusy
    return '<div class="wb-intake">'
      + '<label class="wb-label" for="wbIntakeName">' + esc(t('workbench.intake.name_label')) + '</label>'
      + '<input class="wb-input" id="wbIntakeName" type="text" maxlength="200" value="' + escA(WB.intakeName || '') + '" placeholder="' + escA(t('workbench.intake.name_placeholder')) + '" autocomplete="off">'
      + '<label class="wb-label" for="wbIntakeText">' + esc(t('workbench.intake.title')) + '</label>'
      + '<textarea class="wb-input wb-intake-text" id="wbIntakeText" rows="3" maxlength="4000" placeholder="'
      + escA(t('workbench.intake.placeholder')) + '">' + esc(WB.intakeDraft || '') + '</textarea>'
      + (ask ? '<div class="info-box wb-intake-ask" role="status">' + esc(ask.message) + '</div>' : '')
      + '<div class="wb-intake-kinds">' + kinds.map(function (k) {
        return '<button type="button" class="btn-secondary wb-intake-kind" data-wb-act="intake-kind" data-wb-kind="' + escA(k) + '"'
          + (busy ? ' disabled' : '') + '>' + esc(t('workbench.intake.kind.' + k)) + '</button>'
      }).join('') + '</div>'
      + intakePlatformHtml()
      + '<div class="wb-form-actions">'
      + '<button type="button" class="btn-primary" data-wb-act="intake-go"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.new.creating') : t('workbench.intake.go')) + '</button>'
      + (ask ? '<button type="button" class="btn-secondary" data-wb-act="intake-reset">' + esc(t('workbench.intake.all_kinds')) + '</button>' : '')
      + '<button type="button" class="btn-secondary" data-wb-act="cancel-new">' + esc(t('common.cancel')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.intake.hint')) + '</p>'
      + '</div>'
  }

  function intakeReadDraft() {
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbIntakeText') : null
    if (el && typeof el.value === 'string') WB.intakeDraft = el.value
    return String(WB.intakeDraft || '').trim()
  }

  /** `kind` nelkul a szerver talalja ki a tipust (es kerdezhet vissza). */
  function intakeCreate(kind) {
    if (WB.intakeBusy || archived()) return
    var text = intakeReadDraft()
    var nameEl = document.getElementById('wbIntakeName')
    if (nameEl && typeof nameEl.value === 'string') WB.intakeName = nameEl.value
    var name = String(WB.intakeName || '').trim()
    if (!kind && !text) { window.showToast(t('workbench.intake.empty')); return }
    if (kind === 'table') { intakeCreateTable(text, name); return }
    var payload = { project_id: WB.projectId, text: text }
    if (kind) payload.kind = kind
    if (name) payload.title = name
    var pf = document.getElementById('wbNewFolder')
    if (pf) WB.pickFolder = pf.value
    if (WB.pickFolder) payload.folder = WB.pickFolder
    WB.intakeBusy = true
    render()
    api('POST', '/api/workbench/intake', payload).then(function (r) {
      WB.intakeBusy = false
      if (!r.ok) {
        // Friss projekt: meg nincs mappa-rendszer, de a szerver mappat kovetel -- a valasztot MOST mutatjuk (nem zsakutca).
        render(); window.showToast(r.message); return
      }
      if (r.data.ask) {
        WB.intakeAsk = { options: r.data.options || INTAKE_KINDS, message: r.data.message || '' }
        render()
        return
      }
      WB.intakeAsk = null
      WB.intakeDraft = ''
      WB.intakeName = ''
      WB.formOpen = false
      window.showToast(r.data.message || t('workbench.new.created', { title: r.data.item.title }))
      var made = r.data.item
      // Az egyszeru nezet jobb oldala azonnal mutasson egy (akar ures) kiindulo munkadarabot.
      seedEmptyStart(made, r.data.kind).then(function () {
        selectItem(made.id)
        load(WB.projectId)
        // A mondat az Agenthez: o kezdi el a munkat az uj munkadarabon.
        if (text) handOffToAgent(text)
      })
    })
  }

  /** The "Table" start button: an empty spreadsheet work item (xlsx next to the project files); the
   *  sentence, if any, goes to the agent to fill it, like for the other kinds. */
  function intakeCreateTable(text, name) {
    var payload = { project_id: WB.projectId, title: name || t('workbench.table.default_title') }
    var pf = document.getElementById('wbNewFolder')
    if (pf) WB.pickFolder = pf.value
    if (WB.pickFolder) payload.folder = WB.pickFolder
    WB.intakeBusy = true
    render()
    api('POST', '/api/workbench/items/new-table', payload).then(function (r) {
      WB.intakeBusy = false
      if (!r.ok) {
        render(); window.showToast(r.message); return
      }
      WB.intakeAsk = null; WB.intakeDraft = ''; WB.intakeName = ''; WB.formOpen = false
      window.showToast(t('workbench.table.created', { name: r.data.name || '' }) + (r.data.folder_existed ? ' ' + t('workbench.new.folder_existed') : ''))
      selectItem(r.data.item.id)
      load(WB.projectId)
      if (text) handOffToAgent(text)
    })
  }

  /** Egy ures kiindulo munkadarab a jobb oldalra: ures vaszon, egy ures dia, egy
   *  ures fejezet. A jegyzetnek (md) a belepo mar letrehozta az ures fajlt; a
   *  videonak az idosav ures allapotban is latszik. Hiba nem akasztja meg a megnyitast. */
  function seedEmptyStart(item, kind) {
    var base = '/api/workbench/items/' + encodeURIComponent(item.id)
    var call = null
    if (item.type === 'graphic') {
      var pf = kind === 'social_post' ? intakePlatformNow() : { w: 1080, h: 1080 }
      call = api('PUT', base + '/canvas', { canvas: { width: pf.w, height: pf.h, background: '#ffffff', objects: [] } })
    } else if (item.type === 'presentation' && kind === 'business_card') {
      // Nevjegykartya: kartyameret (EU 85 x 55 mm), ket oldal -- elol a nev, hatul egy ures lap.
      call = api('POST', base + '/deck/ops', { ops: [
        { op: 'setSize', size: 'card-eu' },
        { op: 'addSlide', layout: 'title', at: 1, title: t('workbench.card.front_title'), body: t('workbench.card.front_body') },
        { op: 'addSlide', layout: 'blank', at: 2 },
      ] })
    } else if (item.type === 'presentation') {
      call = api('POST', base + '/deck/ops', { ops: [{ op: 'addSlide', layout: 'title', at: 1, title: t('workbench.deck.new_title'), body: t('workbench.deck.new_subtitle') }] })
    } else if (item.type === 'document') {
      call = api('POST', base + '/outline/sections', { title: t('workbench.sh.seed.section') })
    }
    if (!call) return Promise.resolve()
    return call.then(function () {}, function () {})
  }

  /** Egy mondat az Agentnek, mintha a tulajdonos a chatbe irta volna. Futo
   *  valasz kozben sorba all, ahogy a kezzel irt uzenet is. */
  function handOffToAgent(text) {
    var st = chatState()
    WB.chatForceBottom = true
    if (WB.chatStreaming) {
      st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true, queued: true })
      renderChat()
      return
    }
    st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    startChatTurn(text)
  }

  function newFormHtml() {
    var types = ['document', 'image', 'graphic', 'video', 'presentation', 'note']
    return intakeHtml()
      + '<details class="wb-new-manual"><summary>' + esc(t('workbench.intake.manual')) + '</summary>'
      + '<form class="wb-form" id="wbNewForm">'
      + '<label class="wb-label" for="wbNewTitle">' + esc(t('workbench.new.name_label')) + '</label>'
      + '<input class="wb-input" id="wbNewTitle" type="text" maxlength="200" value="' + escA(WB.newDraft ? WB.newDraft.title : '') + '" placeholder="' + escA(t('workbench.new.name_placeholder')) + '" autocomplete="off">'
      + '<label class="wb-label" for="wbNewType">' + esc(t('workbench.new.type_label')) + '</label>'
      + '<select class="wb-input" id="wbNewType">'
      + types.map(function (ty) { return '<option value="' + escA(ty) + '"' + (WB.newDraft && WB.newDraft.type === ty ? ' selected' : '') + '>' + esc(typeLabel(ty)) + '</option>' }).join('')
      + '</select>'
      + '<p class="wb-hint">' + esc(t('workbench.new.type_hint')) + '</p>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="create"' + (WB.busy ? ' disabled' : '') + '>'
      + esc(WB.busy ? t('workbench.new.creating') : t('workbench.new.create')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="cancel-new">' + esc(t('common.cancel')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.table.new_hint')) + '</p>'
      + '<div class="wb-form-actions"><button type="button" class="btn-secondary" data-wb-act="create-table"' + (WB.busy ? ' disabled' : '') + '>'
      + esc(t('workbench.table.new')) + '</button></div>'
      + '</form></details>'
  }

  // ---- sablonok (#406, 11. pont) --------------------------------------------
  //
  // Egy kattintas: uj munkadarab, a szerkezet mar benne (ajanlat, level,
  // kozossegi poszt, meghivo). A sablonok a szerverrol jonnek a felulet
  // nyelven; friss telepitesen is ott vannak, nincs mit beallitani.

  function loadTemplates() {
    var lang = window._lang || 'hu'
    return api('GET', '/api/workbench/templates').then(function (r) {
      if (!r.ok) { WB.templatesError = r.message; render(); return }
      WB.templatesError = null
      WB.templates = (r.data && r.data.templates) || []
      WB.templatesLang = lang
      render()
    })
  }

  function templatesHtml() {
    var body
    if (WB.templatesError) {
      body = '<div class="info-box depo-bad">' + esc(t('workbench.tpl.load_failed', { error: WB.templatesError })) + '</div>'
        + '<button type="button" class="btn-secondary" data-wb-act="tpl-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.templates === null) {
      body = '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    } else if (!WB.templates.length) {
      body = '<p class="wb-muted">' + esc(t('workbench.tpl.none')) + '</p>'
    } else {
      body = '<div class="wb-tpl-list">' + WB.templates.map(function (tp) {
        var busy = WB.tplBusy === tp.id
        return '<button type="button" class="wb-tpl-btn" data-wb-act="tpl-use" data-wb-tpl="' + escA(tp.id) + '"'
          + (WB.tplBusy ? ' disabled' : '') + ' title="' + escA(tp.description) + '">'
          + '<span class="wb-tpl-name">' + esc(busy ? t('workbench.tpl.creating') : tp.name) + '</span>'
          + '<span class="wb-tpl-desc">' + esc(tp.description) + '</span>'
          + '</button>'
      }).join('') + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.tpl.hint')) + '</p>'
    }
    return '<div class="wb-tpl">'
      + '<p class="wb-label">' + esc(t('workbench.tpl.title')) + '</p>'
      + body
      + '</div>'
  }

  function useTemplate(id) {
    if (!id || WB.tplBusy || archived()) return
    WB.tplBusy = id
    render()
    api('POST', '/api/workbench/templates/use', { project_id: WB.projectId, template: id }).then(function (r) {
      WB.tplBusy = null
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      window.showToast(t('workbench.tpl.created', { title: r.data.item.title }))
      // Rogton megnyitjuk: a szerkezet mar ott van, lehet atirni.
      selectItem(r.data.item.id)
      load(WB.projectId)
    })
  }

  // ---- reszek: VEGYES munkadarab (3. fazis) ---------------------------------
  //
  // Boss, 2026-09-21: "egy munkadarabban lehet egyszerre kep ES szoveg (pl.
  // Facebook-poszt: foto + iras)". A jovahagyott irany a kompozit modell: a
  // munkadarab KONTENER, a tartalom RESZEKBOL all. A fajta csak cimke.

  function partsOf() { return (WB.detail && WB.detail.parts) || [] }

  /** A kep megjelenitese a MEGLEVO fajl-kiszolgalon at (Intezo, #164) -- nem
   *  masoljuk be a bajtokat sehova. A parameter neve `rel` (NEM `path`): a
   *  `/api/life/file` ezt olvassa, a `path`-szal 404-et adna vissza. */
  function partImageSrc(part) {
    return '/api/life/file?rel=' + encodeURIComponent(part.asset_path || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
  }

  function partBodyHtml(part) {
    if (WB.partEdit === part.id) {
      var value = WB.partDraft && WB.partDraft.id === part.id
        ? WB.partDraft.value
        : (part.kind === 'text' ? (part.text || '') : (part.caption || ''))
      return '<form class="wb-part-form" id="wbPartForm">'
        + (part.kind === 'image'
          ? '<label class="wb-label" for="wbPartText">' + esc(t('workbench.parts.caption_label')) + '</label>'
          : '')
        + '<textarea class="wb-input wb-part-input" id="wbPartText" rows="' + (part.kind === 'text' ? 6 : 2) + '"'
        + ' placeholder="' + escA(t(part.kind === 'text' ? 'workbench.parts.text_placeholder' : 'workbench.parts.caption_placeholder')) + '">'
        + esc(value) + '</textarea>'
        + '<div class="wb-form-actions">'
        + micButtonHtml('wbPartText')
        + '<button type="submit" class="btn-primary" data-wb-act="part-save" data-wb-part="' + escA(part.id) + '"' + (WB.partBusy ? ' disabled' : '') + '>'
        + esc(WB.partBusy ? t('workbench.parts.saving') : t('workbench.parts.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="part-cancel">' + esc(t('common.cancel')) + '</button>'
        + '</div></form>'
    }
    if (part.kind === 'image') {
      return '<img class="wb-part-image" src="' + escA(partImageSrc(part)) + '" alt="' + escA(part.caption || t('workbench.parts.image_alt')) + '">'
        + '<p class="' + (part.caption ? 'wb-part-caption' : 'wb-muted') + '">'
        + esc(part.caption || t('workbench.parts.no_caption')) + '</p>'
    }
    return '<p class="wb-part-text">' + esc(part.text || '') + '</p>'
  }

  function partHtml(part, index, total) {
    // Archivalt projekt = CSAK OLVASHATO: a szerkeszto gombok el sem keszulnek,
    // hogy ne kinaljunk olyat, amit a szerver ugyis visszautasit.
    var tools = archived() ? '' : ('<span class="wb-part-tools">'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-up" data-wb-part="' + escA(part.id) + '"'
      + (index === 0 ? ' disabled' : '') + ' title="' + escA(t('workbench.parts.up')) + '">&uarr;</button>'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-down" data-wb-part="' + escA(part.id) + '"'
      + (index === total - 1 ? ' disabled' : '') + ' title="' + escA(t('workbench.parts.down')) + '">&darr;</button>'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-edit" data-wb-part="' + escA(part.id) + '">'
      + esc(t('workbench.parts.edit')) + '</button>'
      + '<button type="button" class="wb-part-btn wb-part-btn-bad" data-wb-act="part-remove" data-wb-part="' + escA(part.id) + '">'
      + esc(t('workbench.parts.remove')) + '</button>'
      + '</span>')
    return '<li class="wb-part" data-wb-part-row="' + escA(part.id) + '">'
      + '<div class="wb-part-head">'
      + '<span class="wb-pill">' + esc(t(part.kind === 'image' ? 'workbench.parts.image_kind' : 'workbench.parts.text_kind')) + '</span>'
      + ((part.kind === 'text' ? part.text : part.caption) ? ttsButtonHtml('part:' + part.id) : '')
      + tools + '</div>'
      + partBodyHtml(part)
      + '</li>'
  }

  /** Kimondjuk, hogy a mentes nem ir felul semmit -- es hol tartunk. */
  function editVersionHintHtml() {
    if (archived() || !WB.detail) return ''
    var cur = null
    var it = WB.detail.item
    ;(WB.detail.versions || []).forEach(function (v) { if (it && v.id === it.current_version_id) cur = v })
    return '<p class="wb-hint wb-edit-hint">' + esc(cur
      ? t('workbench.edit.hint_n', { n: cur.version_no })
      : t('workbench.edit.hint')) + '</p>'
  }

  function partsHtml() {
    var parts = partsOf()
    var list = parts.length
      ? '<ul class="wb-parts">' + parts.map(function (p, i) { return partHtml(p, i, parts.length) }).join('') + '</ul>'
      : '<p class="wb-muted wb-parts-empty">' + esc(t('workbench.parts.empty')) + '</p>'
    var adder = WB.partNewOpen
      ? '<form class="wb-part-form" id="wbPartNewForm">'
        + '<textarea class="wb-input wb-part-input" id="wbPartNewText" rows="5" placeholder="'
        + escA(t('workbench.parts.text_placeholder')) + '">' + esc(WB.partNewDraft || '') + '</textarea>'
        + '<div class="wb-form-actions">'
        + micButtonHtml('wbPartNewText')
        + '<button type="submit" class="btn-primary" data-wb-act="part-add-text"' + (WB.partBusy ? ' disabled' : '') + '>'
        + esc(WB.partBusy ? t('workbench.parts.saving') : t('workbench.parts.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="part-cancel">' + esc(t('common.cancel')) + '</button>'
        + '</div></form>'
      : ''
    return '<div class="wb-parts-block">'
      + editVersionHintHtml()
      + '<h4 class="wb-parts-title">' + esc(t('workbench.parts.title'))
      + (parts.length ? ' <span class="wb-muted">(' + esc(parts.length === 1 ? t('workbench.parts.count_one') : t('workbench.parts.count', { n: parts.length })) + ')</span>' : '')
      + '</h4>'
      + list
      + adder
      + (archived() ? '' : '<div class="wb-part-actions">'
        + '<button type="button" class="btn-secondary" data-wb-act="part-new-text">' + esc(t('workbench.parts.add_text')) + '</button>'
        + '<label class="btn-secondary wb-part-upload" for="wbPartImage">' + esc(WB.partBusy ? t('workbench.parts.uploading') : t('workbench.parts.add_image')) + '</label>'
        + '<input type="file" id="wbPartImage" accept="image/*" class="wb-file-input">'
        + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.parts.image_hint')) + '</p>')
      + '</div>'
  }

  // ---- kozossegi poszt elonezet (#406, Boss TG 6642/6653) --------------------
  //
  // "Ugy nezzen ki, mint a valodi poszt": a vegyes munkadarab szovegreszei a
  // poszt szovege, az elso kepresze a poszt kepe. A meretek a kutatasbol
  // (#406 komment 1623): minden platform 1080 px szeles kepet var. A kepet a
  // valasztott aranyra vagjuk; a kivagas huzhato (focus x/y szazalekban), es a
  // letoltes (kovetkezo adag) ugyanezt a kivagast rajzolja ki. Markajel nincs:
  // semleges kor a nev kezdobetujevel, semleges reakcio-sor.
  var POST_PLATFORMS = [
    { id: 'fb_feed', net: 'fb', w: 1080, h: 1350 },
    { id: 'fb_square', net: 'fb', w: 1080, h: 1080 },
    { id: 'fb_link', net: 'fb', w: 1200, h: 630 },
    { id: 'fb_story', net: 'fb', w: 1080, h: 1920, story: true },
    { id: 'ig_feed', net: 'ig', w: 1080, h: 1350 },
    { id: 'ig_portrait', net: 'ig', w: 1080, h: 1440 },
    { id: 'ig_square', net: 'ig', w: 1080, h: 1080 },
    { id: 'ig_story', net: 'ig', w: 1080, h: 1920, story: true },
    { id: 'li_landscape', net: 'li', w: 1200, h: 627 },
    { id: 'li_square', net: 'li', w: 1080, h: 1080 },
    { id: 'li_portrait', net: 'li', w: 1080, h: 1350 },
  ]
  // Sorok a "Tovabbiak" elott: a levagast a SOROK szama dontik el, nem a
  // karakterszam (#406 komment 1623); a karakterszamot csak kiirjuk.
  var POST_LINES = { fb: { mobile: 3, desktop: 5 }, ig: { mobile: 2, desktop: 2 }, li: { mobile: 3, desktop: 3 } }

  function postPlatform(id) {
    for (var i = 0; i < POST_PLATFORMS.length; i++) if (POST_PLATFORMS[i].id === id) return POST_PLATFORMS[i]
    return POST_PLATFORMS[0]
  }

  function postState() {
    if (!WB.post || WB.post.itemId !== WB.selectedId) {
      WB.post = { itemId: WB.selectedId, open: false, platform: 'fb_feed', view: 'mobile', more: false, fx: 50, fy: 50 }
    }
    return WB.post
  }

  function postText() {
    return partsOf().filter(function (p) { return p.kind === 'text' && (p.text || '').trim() })
      .map(function (p) { return p.text.trim() }).join('\n\n')
  }

  function postImage() {
    var parts = partsOf()
    for (var i = 0; i < parts.length; i++) if (parts[i].kind === 'image' && parts[i].asset_path) return parts[i]
    return null
  }

  function postAuthor() {
    var name = (WB.project && WB.project.name) || t('workbench.post.author_fallback')
    var initial = (name.trim().charAt(0) || '?').toUpperCase()
    return { name: name, initial: initial }
  }

  /** Kivagas a forrasképbol, pontosan ugy, mint a CSS object-fit:cover +
   *  object-position fx% fy% (amit az elonezetben huzott): a letoltott kep
   *  ugyanazt mutatja, mint a keret. Tiszta szamitas -- a tesztek ezt merik. */
  function postCrop(nw, nh, w, h, fx, fy) {
    nw = +nw || 0; nh = +nh || 0
    if (nw <= 0 || nh <= 0 || w <= 0 || h <= 0) return null
    var scale = Math.max(w / nw, h / nh)
    var sw = w / scale
    var sh = h / scale
    var cx = Math.min(100, Math.max(0, +fx || 0)) / 100
    var cy = Math.min(100, Math.max(0, +fy || 0)) / 100
    return { sx: (nw - sw) * cx, sy: (nh - sh) * cy, sw: sw, sh: sh }
  }

  // Feltoltesi felso hatar: a LinkedIn 5 MB-ot enged (#406 komment 1623), a
  // Facebook/Instagram tobbet -- a legszigorubbhoz igazodunk, igy barhova megy.
  var POST_MAX_BYTES = 5 * 1024 * 1024

  function postFileName(pf, ext) {
    var title = ((WB.detail && WB.detail.item && WB.detail.item.title) || 'poszt').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'poszt'
    return title + ' - ' + pf.id + ' ' + pf.w + 'x' + pf.h + '.' + ext
  }

  /** A kep a platform PONTOS mereteben, a huzott kivagassal. JPG-nel 0.9-es
   *  minoseg, es ha 5 MB folott lenne, lepcsozetesen lejjebb. */
  function postRender(fmt) {
    var st = postState()
    var img = postImage()
    var pf = postPlatform(st.platform)
    if (!img) return Promise.reject(new Error(''))
    return loadImg(partImageSrc(img)).then(function (im) {
      var c = postCrop(im.naturalWidth, im.naturalHeight, pf.w, pf.h, st.fx, st.fy)
      if (!c) throw new Error('')
      var cv = document.createElement('canvas')
      cv.width = pf.w
      cv.height = pf.h
      var ctx = cv.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, pf.w, pf.h)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(im, c.sx, c.sy, c.sw, c.sh, 0, 0, pf.w, pf.h)
      return new Promise(function (resolve, reject) {
        if (fmt === 'png') {
          cv.toBlob(function (blob) { blob ? resolve({ blob: blob, pf: pf, ext: 'png' }) : reject(new Error('')) }, 'image/png')
          return
        }
        var q = 0.9
        var step = function () {
          cv.toBlob(function (blob) {
            if (!blob) { reject(new Error('')); return }
            if (blob.size > POST_MAX_BYTES && q > 0.55) { q = Math.round((q - 0.1) * 100) / 100; step(); return }
            resolve({ blob: blob, pf: pf, ext: 'jpg' })
          }, 'image/jpeg', q)
        }
        step()
      })
    })
  }

  function postDownload(fmt) {
    var st = postState()
    if (!postImage() || st.busy) return
    st.busy = true
    render()
    postRender(fmt).then(function (r) {
      st.busy = false
      render()
      var ok = downloadBlob(r.blob, postFileName(r.pf, r.ext))
      window.showToast(ok ? t('workbench.post.dl_done', { w: r.pf.w, h: r.pf.h }) : t('workbench.post.dl_failed', { message: '' }))
    }).catch(function (e) {
      st.busy = false
      render()
      window.showToast(t('workbench.post.dl_failed', { message: (e && e.message) || '' }))
    })
  }

  /** Az elmentett platform-kepek (a betekinto link ezeket adja). A NULLA ket
   *  dolog: "meg nincs" (ures lista) vs "nem latok oda" (hiba) -- kulon mondat. */
  function loadPostFiles() {
    var st = postState()
    var itemId = st.itemId
    st.filesError = null
    api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/post-files').then(function (r) {
      if (WB.selectedId !== itemId) return
      if (r.ok) { st.files = (r.data && r.data.files) || []; st.filesError = null } else st.filesError = r.message
      render()
    })
  }

  /** A kesz kep UJ fajlkent a projekt mappajaba (sosem ir felul), hogy a
   *  betekinto link letoltesre kinalhassa. Mindig JPG (5 MB alatt). */
  function postSave() {
    var st = postState()
    if (!postImage() || st.busy || archived()) return
    var itemId = st.itemId
    st.busy = true
    render()
    var fail = function (msg) { st.busy = false; render(); window.showToast(t('workbench.post.save_failed', { message: msg || '' })) }
    postRender('jpg').then(function (r) {
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/post-files?platform=' + encodeURIComponent(r.pf.id)
        + '&lang=' + encodeURIComponent(window._lang || 'hu')
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: r.blob }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (data) {
          if (!res.ok) { fail((data && data.message) || t('workbench.err.http', { status: res.status })); return }
          st.busy = false
          window.showToast(t('workbench.post.saved', { name: (data && data.name) || '' }))
          loadPostFiles()
        })
      })
    }).catch(function (e) { fail((e && e.message) || t('workbench.err.network')) })
  }

  function postFilesHtml(st) {
    if (st.filesError) return '<p class="wb-hint">' + esc(t('workbench.post.files_error', { message: st.filesError })) + '</p>'
    if (!st.files) return ''
    if (!st.files.length) return '<p class="wb-hint">' + esc(t('workbench.post.files_none')) + '</p>'
    return '<div class="wb-post-files"><p class="wb-hint">' + esc(t('workbench.post.files_title')) + '</p><ul>'
      + st.files.map(function (f) {
        var pf = postPlatform(f.platform)
        return '<li>' + esc(t('workbench.post.pf.' + pf.id, { w: pf.w, h: pf.h })) + ': '
          + (f.available
            ? '<a href="/api/life/file?rel=' + escA(encodeURIComponent(f.rel)) + '&download=1" target="_blank" rel="noopener">' + esc(f.name) + '</a>'
            : '<span class="wb-muted">' + esc(t('workbench.post.file_missing', { name: f.name })) + '</span>')
          + '</li>'
      }).join('') + '</ul></div>'
  }

  /** A poszt-nezet PDF-kent: a bongeszo sajat nyomtatasa (Mentes PDF-kent),
   *  csak az elonezeti kartya kerul a lapra. Nincs uj csomag, telefonon is megy. */
  function postPdf() {
    if (typeof window.print !== 'function') return
    var cls = 'wb-printing-post'
    document.body.classList.add(cls)
    var off = function () { document.body.classList.remove(cls); window.removeEventListener('afterprint', off) }
    window.addEventListener('afterprint', off)
    try { window.print() } finally { setTimeout(off, 1000) }
  }

  function postPreviewHtml() {
    var it = WB.detail && WB.detail.item
    if (!it || it.type !== 'composite') return ''
    var st = postState()
    var head = '<div class="wb-post-head"><h4 class="wb-parts-title">' + esc(t('workbench.post.title')) + '</h4>'
      + '<button type="button" class="btn-secondary" data-wb-act="post-toggle" aria-expanded="' + (st.open ? 'true' : 'false') + '">'
      + esc(t(st.open ? 'workbench.post.hide' : 'workbench.post.show')) + '</button></div>'
    if (!st.open) return '<div class="wb-post-block">' + head + '<p class="wb-hint">' + esc(t('workbench.post.intro')) + '</p></div>'
    var pf = postPlatform(st.platform)
    var opts = POST_PLATFORMS.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === pf.id ? ' selected' : '') + '>'
        + esc(t('workbench.post.pf.' + p.id, { w: p.w, h: p.h })) + '</option>'
    }).join('')
    var controls = '<div class="wb-post-controls">'
      + '<label class="wb-label" for="wbPostPlatform">' + esc(t('workbench.post.platform')) + '</label>'
      + '<select id="wbPostPlatform" class="wb-input" data-wb-post="platform">' + opts + '</select>'
      + '<div class="wb-post-views" role="group" aria-label="' + escA(t('workbench.post.view')) + '">'
      + ['mobile', 'desktop'].map(function (v) {
        return '<button type="button" class="btn-secondary' + (st.view === v ? ' wb-post-view-on' : '') + '" data-wb-act="post-view" data-wb-view="' + v + '" aria-pressed="' + (st.view === v ? 'true' : 'false') + '">'
          + esc(t('workbench.post.view_' + v)) + '</button>'
      }).join('')
      + '</div></div>'
    var text = postText()
    var img = postImage()
    var au = postAuthor()
    var ratio = pf.w + ' / ' + pf.h
    var imgHtml = img
      ? '<div class="wb-post-frame" data-wb-post-frame style="aspect-ratio:' + ratio + '" title="' + escA(t('workbench.post.drag_hint')) + '">'
        + '<img src="' + escA(partImageSrc(img)) + '" alt="' + escA(img.caption || t('workbench.parts.image_alt')) + '" draggable="false"'
        + ' style="object-position:' + st.fx + '% ' + st.fy + '%">'
        + (pf.story ? '<div class="wb-post-safe wb-post-safe-top"></div><div class="wb-post-safe wb-post-safe-bottom"></div>' : '')
        + '</div>'
      : '<div class="wb-post-frame wb-post-noimg" style="aspect-ratio:' + ratio + '"><p>' + esc(t('workbench.post.no_image')) + '</p></div>'
    var lines = POST_LINES[pf.net][st.view]
    var textHtml = text
      ? '<div class="wb-post-text' + (st.more ? '' : ' wb-post-clamp') + '" style="--wb-post-lines:' + lines + '">' + esc(text) + '</div>'
        + '<button type="button" class="wb-post-more" data-wb-act="post-more">' + esc(t(st.more ? 'workbench.post.less' : (pf.net === 'fb' ? 'workbench.post.more_fb' : 'workbench.post.more'))) + '</button>'
      : '<p class="wb-muted">' + esc(t('workbench.post.no_text')) + '</p>'
    var authorHtml = '<div class="wb-post-author"><span class="wb-post-avatar" aria-hidden="true">' + esc(au.initial) + '</span>'
      + '<span><strong>' + esc(au.name) + '</strong><br><span class="wb-muted">' + esc(t('workbench.post.just_now')) + '</span></span></div>'
    var reactions = '<div class="wb-post-reactions" aria-hidden="true">'
      + (pf.net === 'ig'
        ? '<span>♡</span><span>💬</span><span>↗</span>'
        : '<span>👍 ' + esc(t('workbench.post.like')) + '</span><span>💬 ' + esc(t('workbench.post.comment')) + '</span><span>↗ ' + esc(t('workbench.post.share')) + '</span>')
      + '</div>'
    var card
    if (pf.story) {
      card = '<div class="wb-post-card wb-post-story">' + authorHtml + imgHtml + '</div>'
    } else if (pf.net === 'ig') {
      card = '<div class="wb-post-card">' + authorHtml + imgHtml + reactions + textHtml + '</div>'
    } else {
      card = '<div class="wb-post-card">' + authorHtml + textHtml + imgHtml + reactions + '</div>'
    }
    var facts = '<p class="wb-hint">' + esc(t('workbench.post.facts', { w: pf.w, h: pf.h, n: text.length, lines: lines }))
      + (pf.story ? ' ' + esc(t('workbench.post.story_hint')) : '') + '</p>'
    var dl = '<div class="wb-post-dl" role="group" aria-label="' + escA(t('workbench.post.dl_title')) + '">'
      + '<button type="button" class="btn-primary" data-wb-act="post-dl" data-wb-fmt="jpg"' + (img && !st.busy ? '' : ' disabled') + '>'
      + esc(t(st.busy ? 'workbench.post.dl_busy' : 'workbench.post.dl_jpg', { w: pf.w, h: pf.h })) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="post-dl" data-wb-fmt="png"' + (img && !st.busy ? '' : ' disabled') + '>'
      + esc(t('workbench.post.dl_png')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="post-pdf">' + esc(t('workbench.post.dl_pdf')) + '</button>'
      + (archived() ? '' : '<button type="button" class="btn-secondary" data-wb-act="post-save"' + (img && !st.busy ? '' : ' disabled') + '>'
        + esc(t('workbench.post.save', { w: pf.w, h: pf.h })) + '</button>')
      + '</div>'
      + '<p class="wb-hint">' + esc(t(img ? 'workbench.post.dl_hint' : 'workbench.post.dl_no_image')) + '</p>'
      + (img ? '<p class="wb-hint">' + esc(t('workbench.post.save_hint')) + '</p>' : '') + postFilesHtml(st)
    return '<div class="wb-post-block">' + head + controls
      + '<div class="wb-post-stage wb-post-' + st.view + '">' + card + '</div>' + facts + dl + '</div>'
  }

  // ---- elonezet (4. fazis) ---------------------------------------------------
  //
  // A bajtokat a MEGLEVO fajl-kiszolgalo adja (`/api/life/file?rel=`), a PDF-et
  // maga a bongeszo jeleniti meg: igy friss telepitesen, halozat nelkul is megy,
  // es nincs uj csomag-fuggoseg. Ami nem mutathato meg, arra EMBERI mondat jon
  // a szervertol -- es kulon mondat arra, ha "nem latok oda" (nincs Raktar,
  // nincs projektmappa, eltunt a fajl), mint arra, ha "meg nincs semmi".
  /** `keep === true`: a MOSTANI elonezet a helyen marad, amig az uj meg nem
   *  jon. Ez akkor helyes, ha UGYANARROL a munkadarabrol kerunk friss adatot
   *  (pl. a vaszon egy muvelete utan): kulonben a kep es a huzogato reteg
   *  minden mozdulat utan eltunne egy pillanatra, es a masodik huzast mar nem
   *  lehetne elkezdeni. Munkadarab- vagy verzio-valtasnal NEM szabad megtartani:
   *  ott a regi kep MAS dolgot mutatna, mint amit a felhasznalo kert. */
  function loadPreview(itemId, versionId, keep) {
    if (!keep) WB.preview = null
    // Az elozo munkadarab atalakitasi hibaja NEM tartozik ehhez: toroljuk.
    WB.convertError = null
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/preview'
      + (versionId ? '?version=' + encodeURIComponent(versionId) + '&' : '?')
      + 'lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        // Kozben mashova kattintott: a regi valasz nem irhatja felul a kepernyot.
        if (WB.selectedId !== itemId) return
        WB.preview = data && typeof data === 'object'
          ? data
          : { available: false, message: t('workbench.err.http', { status: res.status }) }
        render()
      })
    }).catch(function () {
      if (WB.selectedId !== itemId) return
      WB.preview = { available: false, message: t('workbench.err.network') }
      render()
    })
  }

  function previewVersionPickerHtml() {
    var versions = (WB.preview && WB.preview.versions) || (WB.detail && WB.detail.versions) || []
    if (versions.length < 2) return ''
    var cur = WB.previewVersion || (WB.preview && WB.preview.version_id) || ''
    return '<label class="wb-label" for="wbPreviewVersion">' + esc(t('workbench.preview.version_label')) + '</label>'
      + '<select class="wb-input wb-preview-version" id="wbPreviewVersion" data-wb-act="preview-version">'
      + versions.map(function (v) {
        return '<option value="' + escA(v.id) + '"' + (v.id === cur ? ' selected' : '') + '>'
          + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) })) + '</option>'
      }).join('') + '</select>'
  }

  function previewBodyHtml(p) {
    // IRODAI DOKUMENTUM (7. fazis): amit latsz, az a belole keszult PDF -- ezt
    // KI IS MONDJUK, hogy senki ne higgye, hogy a .docx-et szerkeszti itt.
    if (p.kind === 'office') {
      return docButtonsHtml(p) + pdfSlotHtml(p.url)
        + '<p class="wb-hint">' + esc(t('workbench.preview.office_from_pdf')) + '</p>'
        + '<p class="wb-hint"><a href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">'
        + esc(t('workbench.preview.office_download_pdf')) + '</a>'
        + (p.rel
          ? ' &middot; <a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.office_download_source')) + '</a>'
          : '')
        + '</p>'
    }
    if (p.kind === 'pdf') {
      return docButtonsHtml(p) + pdfSlotHtml(p.url)
        + '<p class="wb-hint"><a href="' + escA(p.url) + '" target="_blank" rel="noopener">' + esc(t('workbench.preview.open_new_tab')) + '</a>'
        + ' &middot; <a href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">' + esc(t('workbench.preview.download')) + '</a></p>'
    }
    if (p.kind === 'canvas') {
      // A rajzot a SZERVER rajzolja ki SVG-be: a bongeszonek nem kell hozza
      // semmilyen kulso konyvtar, es a letoltott kep ugyanez a kep. A
      // huzogatashoz csak egy ATLATSZO doboz-reteg kerul fole -- a kepet
      // tovabbra sem a bongeszo rajzolja.
      return canvasStageHtml(p.name || t('workbench.preview.title'))
        + '<p class="wb-hint"><a href="' + escA(canvasSvgUrl(WB.selectedId, true)) + '" target="_blank" rel="noopener">'
        + esc(t('workbench.canvas.download')) + '</a></p>'
    }
    if (p.kind === 'image') {
      // KEPSZERKESZTES (#406, 16. pont): csak a mostani verzio, nem archivalt projektben.
      if (imgState()) return imageEditorHtml()
      return (imgCanEdit(p) ? '<p><button type="button" class="btn-primary" data-wb-act="img-open">' + esc(t('workbench.img.open')) + '</button></p>' : '')
        + '<img class="wb-preview-image" src="' + escA(p.url) + '" alt="' + escA(p.name || t('workbench.preview.title')) + '">'
    }
    if (p.kind === 'video') {
      return '<video class="wb-preview-video" id="wbVideo" src="' + escA(p.url) + '" controls preload="metadata" playsinline></video>'
        + videoToolsHtml(p)
    }
    if (p.kind === 'audio') {
      return '<audio class="wb-preview-audio" src="' + escA(p.url) + '" controls></audio>'
    }
    if (p.kind === 'text') {
      if (WB.textEdit && WB.textEdit.itemId === WB.selectedId) return textEditHtml()
      // KOZVETLEN SZERKESZTES (#406, 4. pont): csak a MOSTANI verziot, es csak
      // ha az egeszet latjuk -- a levagott elonezet visszairasa a fajl vegenek
      // elvesztese lenne.
      var current = !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
      var canEdit = !archived() && !p.truncated && current
      return (canEdit
        ? '<p><button type="button" class="btn-secondary" data-wb-act="text-edit">' + esc(t('workbench.edit.text_open')) + '</button> ' + ttsButtonHtml('preview') + '</p>'
        : (p.text ? '<p>' + ttsButtonHtml('preview') + '</p>' : ''))
        + (p.text ? '<div class="wb-tr-head wb-tr-reader">' + trRightControlsHtml(false) + '</div>' : '')
        + (WB.tr.mode === 'translation' && p.text ? trResultHtml(isMarkdownPreview(p)) : (isMarkdownPreview(p) ? mdLiveHtml(p.text || '') : '<pre class="wb-preview-text">' + esc(p.text || '') + '</pre>'))
        + (p.truncated ? '<p class="wb-hint">' + esc(t('workbench.preview.truncated')) + '</p>' : '')
        + (!archived() && !current ? '<p class="wb-hint">' + esc(t('workbench.edit.text_old_version')) + '</p>' : '')
    }
    return ''
  }

  // ---- VIDEOMUNKA (#406, 19. pont) -------------------------------------------
  // Lejatszas a bongeszo sajat lejatszojaval; vagas es kepkocka FFmpeg-gel a
  // szerveren. Minden mentes UJ fajl: a vagas a video UJ verzioja, a kepkocka
  // UJ kep munkadarab. FFmpeg nelkul emberi mondat + ut a Kepessegek panelre.

  function videoRestore(keep) {
    var v = document.getElementById('wbVideo')
    if (!v || !v.getAttribute || v.getAttribute('src') !== keep.src) return
    var go = function () { try { v.currentTime = keep.at } catch (_e) { /* meg nem toltott be */ } }
    go()
    if (typeof v.addEventListener === 'function') v.addEventListener('loadedmetadata', go, { once: true })
  }

  function vidCanEdit(p) {
    var current = !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
    return !!(p && p.available && p.kind === 'video' && !archived() && current && WB.detail && WB.detail.item)
  }

  function vidState() {
    if (!WB.vid || WB.vid.itemId !== WB.selectedId) WB.vid = { itemId: WB.selectedId, start: '', end: '', busy: null, error: null, detail: null }
    return WB.vid
  }

  function loadVideoStatus() {
    if (WB.vidLoading) return
    WB.vidLoading = true
    api('GET', '/api/workbench/video-status').then(function (r) {
      WB.vidLoading = false
      WB.vidStatus = r.ok && r.data && r.data.video ? r.data.video : { state: 'check_failed', message: r.message || t('workbench.vid.status_failed') }
      render()
    }).catch(function () {
      WB.vidLoading = false
      WB.vidStatus = { state: 'check_failed', message: t('workbench.vid.status_failed') }
      render()
    })
  }

  /** 65.4 -> "1:05.4" (a mezobe; tizedmasodperc pontossaggal). */
  function vidFmt(sec) {
    var s = Math.max(0, Math.round(sec * 10) / 10)
    var m = Math.floor(s / 60)
    var r = s - m * 60
    var rs = (r < 10 ? '0' : '') + (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, '')
    return m + ':' + rs
  }

  function videoToolsHtml(p) {
    if (!vidCanEdit(p)) return ''
    if (!WB.vidStatus) {
      loadVideoStatus()
      return '<p class="wb-hint">' + esc(t('workbench.loading')) + '</p>'
    }
    if (WB.vidStatus.state !== 'ok') {
      // EXTRA kepesseg: a hianya nem vészjelzes, csak egy mondat es egy ut.
      return '<div class="wb-vid-tools"><p class="wb-hint">' + esc(WB.vidStatus.message || t('workbench.vid.status_failed')) + '</p>'
        + '<button type="button" class="btn-secondary btn-compact" data-wb-act="caps-open" aria-pressed="' + !!WB.capsOpen + '">' + esc(t('workbench.caps.open')) + '</button></div>'
    }
    var st = vidState()
    var busy = !!st.busy
    var dis = busy ? ' disabled' : ''
    var row = function (which, id, label, mark) {
      return '<div class="wb-vid-row"><label class="wb-label" for="' + id + '">' + esc(t(label)) + '</label>'
        + '<input class="wb-input wb-vid-time" id="' + id + '" type="text" inputmode="decimal" placeholder="0:00" value="' + escA(st[which]) + '"' + dis + '>'
        + '<button type="button" class="btn-secondary btn-compact" data-wb-act="vid-mark" data-wb-which="' + which + '"' + dis + '>' + esc(t(mark)) + '</button></div>'
    }
    return '<div class="wb-vid-tools" role="region" aria-label="' + escA(t('workbench.vid.title')) + '">'
      + '<h4 class="wb-exp-title">' + esc(t('workbench.vid.trim_title')) + '</h4>'
      + '<p class="wb-hint">' + esc(t('workbench.vid.trim_hint')) + '</p>'
      + row('start', 'wbVidStart', 'workbench.vid.start', 'workbench.vid.mark_start')
      + row('end', 'wbVidEnd', 'workbench.vid.end', 'workbench.vid.mark_end')
      + '<p><button type="button" class="btn-primary" data-wb-act="vid-trim"' + dis + '>'
      + esc(t(st.busy === 'trim' ? 'workbench.vid.trimming' : 'workbench.vid.trim')) + '</button></p>'
      + '<h4 class="wb-exp-title">' + esc(t('workbench.vid.frame_title')) + '</h4>'
      + '<p class="wb-hint">' + esc(t('workbench.vid.frame_hint')) + '</p>'
      + '<p><button type="button" class="btn-secondary" data-wb-act="vid-frame"' + dis + '>'
      + esc(t(st.busy === 'frame' ? 'workbench.vid.framing' : 'workbench.vid.frame')) + '</button></p>'
      + (st.error ? '<div class="info-box depo-bad">' + esc(st.error) + (st.detail ? '<br><small>' + esc(st.detail) + '</small>' : '') + '</div>' : '')
      + '</div>'
  }

  /** A lejatszo mostani helye (masodperc), vagy null, ha nincs lejatszo. */
  function vidNow() {
    var v = document.getElementById('wbVideo')
    return v && typeof v.currentTime === 'number' && isFinite(v.currentTime) ? v.currentTime : null
  }

  /** A begepelt ertekeket az allapotba (az ujrarajzolas ne torolje oket). */
  function vidReadInputs(st) {
    var a = document.getElementById('wbVidStart')
    var b = document.getElementById('wbVidEnd')
    if (a && typeof a.value === 'string') st.start = a.value.trim()
    if (b && typeof b.value === 'string') st.end = b.value.trim()
  }

  function vidMark(which) {
    var st = vidState()
    vidReadInputs(st)
    var now = vidNow()
    if (now === null) return
    st[which] = vidFmt(now)
    // Nem rajzolunk ujra: a mezot kozvetlenul irjuk, a lejatszo ott marad, ahol van.
    var el = document.getElementById(which === 'start' ? 'wbVidStart' : 'wbVidEnd')
    if (el) el.value = st[which]
    else render()
  }

  function vidSave(kind) {
    var st = vidState()
    if (st.busy || !WB.selectedId || !WB.detail || !WB.detail.item) return
    vidReadInputs(st)
    var body = { base_version: WB.detail.item.current_version_id }
    if (kind === 'trim') {
      if (!st.start && !st.end) { window.showToast(t('workbench.vid.need_times')); return }
      body.start = st.start || '0'
      body.end = st.end
    } else {
      var now = vidNow()
      body.at = now === null ? (st.start || '0') : now
    }
    var itemId = WB.selectedId
    st.busy = kind
    st.error = null
    st.detail = null
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/video-' + kind, body).then(function (r) {
      var s2 = WB.vid && WB.vid.itemId === itemId ? WB.vid : null
      if (s2) s2.busy = null
      if (!r.ok) {
        if (s2) { s2.error = r.message; s2.detail = (r.data && r.data.detail) || null }
        render()
        return
      }
      if (kind === 'trim') {
        if (s2) { s2.start = ''; s2.end = '' }
        window.showToast(t('workbench.vid.trim_saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
        if (WB.selectedId === itemId) applyVersions(r.data)
        else render()
      } else {
        window.showToast(t('workbench.vid.frame_saved', { name: (r.data && r.data.name) || '' }))
        render()
        load(WB.projectId)
      }
    }).catch(function () {
      var s2 = WB.vid && WB.vid.itemId === itemId ? WB.vid : null
      if (s2) { s2.busy = null; s2.error = t('workbench.err.network') }
      render()
    })
  }

  /** A markdown fajl: a .md/.markdown kiterjesztes vagy a markdown mime. */
  function isMarkdownPreview(p) {
    return !!p && p.kind === 'text' && (/\.(md|markdown)$/i.test(String(p.name || '')) || /markdown/i.test(String(p.mime || '')))
  }

  /** A markdown kirajzolasa (a dashboard sajat, HTML-t escape-elo renderere). */
  function mdLiveHtml(text) {
    if (typeof window.renderMarkdown !== 'function') return '<pre class="wb-preview-text">' + esc(text || '') + '</pre>'
    return '<div class="wb-md-live">' + window.renderMarkdown(text || '') + '</div>'
  }

  /** A szerkeszto melletti elo elonezet frissitese gepeleskor (ujrarajzolas nelkul). */
  function updateMdLive(value) {
    var el = document.getElementById('wbTextEditLive')
    if (el && WB.tr.mode !== 'translation') el.innerHTML = mdLiveHtml(value)
  }

  function textEditHtml() {
    var busy = WB.textEdit && WB.textEdit.busy
    var md = isMarkdownPreview(WB.preview)
    var area = '<textarea class="wb-input wb-part-input wb-text-edit" id="wbTextEdit" rows="16">' + esc(WB.textEdit.value) + '</textarea>'
    return '<form class="wb-part-form' + (md ? ' wb-md-form' : '') + '" id="wbTextEditForm">'
      + (md ? '' : '<label class="wb-label" for="wbTextEdit">' + esc(t('workbench.edit.text_label')) + '</label>')
      + (md
        ? '<div class="wb-md-split"><div class="wb-md-live-wrap"><div class="wb-tr-head"><label class="wb-label" for="wbTextEdit">' + esc(t('workbench.edit.text_label')) + '</label>' + trLeftControlsHtml() + '</div>' + area + '</div>'
          + '<div class="wb-md-live-wrap"><div class="wb-tr-head"><p class="wb-label">' + esc(t('workbench.edit.md_live')) + '</p>' + trRightControlsHtml(true) + '</div>' + trRightBodyHtml(WB.textEdit.value) + '</div></div>'
        : area)
      + '<div class="wb-form-actions">'
      + micButtonHtml('wbTextEdit')
      + '<button type="submit" class="btn-primary" data-wb-act="text-save"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.parts.saving') : t('workbench.edit.text_save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="text-cancel">' + esc(t('common.cancel')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.edit.text_hint')) + '</p>'
      + '</form>'
  }

  function openTextEdit() {
    var p = WB.preview
    if (!p || p.kind !== 'text' || p.truncated || archived() || !WB.selectedId) return
    WB.textEdit = { itemId: WB.selectedId, value: p.text || '', busy: false, baseVersion: (WB.detail && WB.detail.item && WB.detail.item.current_version_id) || '' }
    render()
    var el = document.getElementById('wbTextEdit')
    if (el && typeof el.focus === 'function') el.focus()
  }

  function saveTextEdit() {
    if (!WB.textEdit || WB.textEdit.busy || !WB.selectedId) return
    var el = document.getElementById('wbTextEdit')
    if (el && typeof el.value === 'string') WB.textEdit.value = el.value
    var itemId = WB.selectedId
    WB.textEdit.busy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/text', { text: WB.textEdit.value, base_version: WB.textEdit.baseVersion || undefined }).then(function (r) {
      if (WB.selectedId !== itemId || !WB.textEdit) return
      WB.textEdit.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.textEdit = null
      applyVersions(r.data)
      window.showToast(t('workbench.edit.text_saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  // ---- DOKUMENTUM-SZERKESZTES A MUNKAPADON (#444) ---------------------------
  //
  // A tulajdonos: "ezen a munkapadon belul tudjam szerkeszteni [...] nem az,
  // hogy letolteni, valamivel szerkeszteni, aztan ide-vissza." Dontese: 1A +
  // 2C. Ezert:
  //   - Word (docx/doc/odt/rtf): formazott szerkeszto. A szerver a dokumentumot
  //     HTML-le alakitja (LibreOffice), itt formazva szerkesztheto, a mentes
  //     ugyanabban a formatumban UJ fajl + UJ verzio.
  //   - PDF: raíras, kiemeles, kitakaras a lapokra; ES atalakitas
  //     szerkesztheto Word-de (uj verziokent, a PDF megmarad).
  //
  // MIERT TARTOS DOM-CSOMOPONT (mint a PDF-nezegetonel): a `render()` az egesz
  // feluletet ujraepiti (egy chat-uzenet is). Ha a szerkeszto abban ulne,
  // minden ujrarajzolas elvinne a kurzort es a be nem mentett modositast. A
  // szerkeszto sajat csomopontban el, amit a render() utan visszateszunk.

  var DOC_EDIT_EXTS = { docx: 1, doc: 1, odt: 1, rtf: 1 }

  function docCurrent() {
    return !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
  }

  function docCanEdit(p) {
    return !!(p && !archived() && docCurrent() && WB.detail && WB.detail.item && WB.selectedId)
  }

  function docEditableExt(p) {
    if (!p || p.kind !== 'office') return null
    var ext = (p.office && p.office.ext) || String(p.name || '').split('.').pop().toLowerCase()
    return DOC_EDIT_EXTS[ext] ? ext : null
  }

  function docEditOpen() { return !!(WB.docEdit && WB.docEdit.itemId === WB.selectedId) }
  function pdfEditOpen() { return !!(WB.pdfEdit && WB.pdfEdit.itemId === WB.selectedId) }

  /** A szerkeszto-gombok az elonezet felett (Word: szerkesztes; PDF: jeloles +
   *  atalakitas). Regi verzional es archivalt projektben NINCS gomb, csak egy
   *  mondat, hogy miert. */
  function docButtonsHtml(p) {
    if (!p) return ''
    var isDoc = !!docEditableExt(p)
    var isPdf = p.kind === 'pdf' && p.available
    if (!isDoc && !isPdf) return ''
    if (!docCanEdit(p)) {
      return (!archived() && !docCurrent()) ? '<p class="wb-hint">' + esc(t('workbench.docedit.old_version')) + '</p>' : ''
    }
    if (isDoc) {
      return '<p class="wb-docedit-actions"><button type="button" class="btn-primary" data-wb-act="doc-edit">' + esc(t('workbench.docedit.open')) + '</button></p>'
        + '<p class="wb-hint">' + esc(t('workbench.docedit.open_hint')) + '</p>'
    }
    var busy = WB.pdfToDocxBusy === WB.selectedId
    return '<p class="wb-docedit-actions"><button type="button" class="btn-primary" data-wb-act="pdf-edit">' + esc(t('workbench.pdfedit.open')) + '</button> '
      + '<button type="button" class="btn-secondary" data-wb-act="pdf-to-docx"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.pdfedit.to_docx_busy') : t('workbench.pdfedit.to_docx')) + '</button></p>'
      + '<p class="wb-hint">' + esc(t('workbench.pdfedit.open_hint')) + '</p>'
  }

  // ---- Word-szerkeszto ----

  /** Egy dokumentum-HTML-bol MINDEN futtathato reszt kiveszunk, mielott az
   *  oldalba kerul (a szerver is tisztit; ez a masodik zar). A DOMParser
   *  dokumentuma "halott": abban semmi nem fut le, amig at nem visszuk. */
  function docCleanTree(root) {
    var bad = root.querySelectorAll('script,iframe,object,embed,frame,frameset,applet,link,meta,base,form,input,button,textarea,select')
    for (var i = bad.length - 1; i >= 0; i--) { if (bad[i].parentNode) bad[i].parentNode.removeChild(bad[i]) }
    var all = root.querySelectorAll('*')
    for (var j = 0; j < all.length; j++) {
      var el = all[j]
      for (var k = el.attributes.length - 1; k >= 0; k--) {
        var an = el.attributes[k].name.toLowerCase()
        var av = String(el.attributes[k].value || '').trim().toLowerCase()
        if (an.indexOf('on') === 0) el.removeAttribute(el.attributes[k].name)
        else if ((an === 'href' || an === 'src' || an === 'xlink:href') && /^(javascript|vbscript):/.test(av)) el.removeAttribute(el.attributes[k].name)
        else if (an === 'src' && el.tagName === 'IMG' && av.indexOf('data:') !== 0) el.removeAttribute('src')
      }
    }
  }

  /** A dokumentum sajat stilusait a szerkeszto-lapra SZUKITJUK, hogy ne
   *  szinezzek at a Munkapad tobbi reszet. Az eredeti stilus-szoveg valtozatlanul
   *  megmarad a menteshez. */
  function docScopeCss(css) {
    var out = []
    String(css || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '')
      .replace(/([^{}@]+)\{([^{}]*)\}/g, function (_m, sel, body) {
        var scoped = String(sel).split(',').map(function (s) {
          s = s.trim()
          if (!s) return ''
          if (/^(html|body)\b/i.test(s)) return '.wb-docedit-page' + s.replace(/^(html|body)/i, '')
          return '.wb-docedit-page ' + s
        }).filter(Boolean).join(', ')
        if (scoped) out.push(scoped + ' {' + body + '}')
        return ''
      })
    return out.join('\n')
  }

  function openDocEdit() {
    var p = WB.preview
    var ext = docEditableExt(p)
    if (!ext || !docCanEdit(p)) return
    var itemId = WB.selectedId
    WB.docEdit = { itemId: itemId, ext: ext, name: p.name || '', loading: true, busy: false, error: null, detail: null, dirty: false, host: null, page: null, head: '', baseVersion: null, range: null, brandKey: null }
    // The toolbar shows the brand colours first (K-4.2), so the brand is loaded in the background.
    ensureBrand()
    render()
    api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/doc-html').then(function (r) {
      var st = WB.docEdit
      if (!st || st.itemId !== itemId) return
      st.loading = false
      if (!r.ok) {
        st.error = r.message
        st.detail = (r.data && r.data.detail) || null
        render()
        return
      }
      st.baseVersion = r.data.base_version || ''
      docBuildHost(st, String(r.data.html || ''))
      render()
      if (st.page && typeof st.page.focus === 'function') st.page.focus()
    })
  }

  function docEditHtml() {
    var st = WB.docEdit
    if (st.loading) return '<p class="wb-muted">' + esc(t('workbench.docedit.loading')) + '</p>'
    if (st.error) {
      return '<p class="wb-preview-bad">' + esc(st.error) + '</p>'
        + (st.detail ? '<p class="wb-hint">' + esc(st.detail) + '</p>' : '')
        + '<p><button type="button" class="btn-secondary" data-wb-act="doc-edit-close">' + esc(t('workbench.docedit.back')) + '</button></p>'
    }
    return '<div class="wb-docedit-slot" data-wb-docedit="1"></div>'
  }

  var DOC_TOOLS = [
    ['undo', '&#8630;'], ['redo', '&#8631;'], ['|'],
    ['bold', '<b>B</b>'], ['italic', '<i>I</i>'], ['underline', '<u>U</u>'], ['strikeThrough', '<s>S</s>'], ['|'],
    ['block', ''], ['size', ''], ['|'],
    ['insertUnorderedList', '&#8226;&#8226;'], ['insertOrderedList', '1.2.'], ['outdent', '&#8676;'], ['indent', '&#8677;'], ['|'],
    ['justifyLeft', '&#8676;&#8801;'], ['justifyCenter', '&#8801;'], ['justifyRight', '&#8801;&#8677;'], ['justifyFull', '&#9776;'], ['|'],
    ['foreColor', ''], ['hiliteColor', ''], ['removeFormat', '&#10007;']
  ]

  function docBuildHost(st, html) {
    var doc = new DOMParser().parseFromString(html, 'text/html')
    var styles = doc.querySelectorAll('style')
    var css = ''
    for (var i = 0; i < styles.length; i++) css += styles[i].textContent + '\n'
    // A mentes a DOKUMENTUM eredeti fejevel megy vissza (lapmeret, margok,
    // bekezdes-stilusok) -- a LibreOffice ebbol tudja, mi volt az eredeti.
    st.head = '<meta charset="utf-8"><title></title>' + (css ? '<style type="text/css">' + css.replace(/<\/style/gi, '') + '</style>' : '')
    docCleanTree(doc.body)
    var host = document.createElement('div')
    host.className = 'wb-docedit'
    var bar = document.createElement('div')
    bar.className = 'wb-docedit-bar'
    bar.innerHTML = DOC_TOOLS.map(function (tool) {
      var c = tool[0]
      if (c === '|') return '<span class="wb-docedit-sep"></span>'
      if (c === 'block') {
        return '<select class="wb-docedit-select" data-de-block title="' + escA(t('workbench.docedit.t_block')) + '">'
          + '<option value="">' + esc(t('workbench.docedit.t_block')) + '</option>'
          + '<option value="p">' + esc(t('workbench.docedit.block_p')) + '</option>'
          + '<option value="h1">' + esc(t('workbench.docedit.block_h1')) + '</option>'
          + '<option value="h2">' + esc(t('workbench.docedit.block_h2')) + '</option>'
          + '<option value="h3">' + esc(t('workbench.docedit.block_h3')) + '</option></select>'
      }
      if (c === 'size') {
        return '<select class="wb-docedit-select" data-de-size title="' + escA(t('workbench.docedit.t_size')) + '">'
          + '<option value="">' + esc(t('workbench.docedit.t_size')) + '</option>'
          + [['1', '8'], ['2', '10'], ['3', '12'], ['4', '14'], ['5', '18'], ['6', '24'], ['7', '36']].map(function (o) {
            return '<option value="' + o[0] + '">' + o[1] + ' pt</option>'
          }).join('') + '</select>'
      }
      if (c === 'foreColor' || c === 'hiliteColor') {
        // The project's brand colours go in front of the colour field (K-4.2); docBrandFill fills the slot.
        return '<span class="wb-docedit-brand" data-de-brand="' + c + '"></span>'
          + '<label class="wb-docedit-color" title="' + escA(t('workbench.docedit.t_' + c)) + '">'
          + (c === 'foreColor' ? 'A' : '&#9608;')
          + '<input type="color" data-de-color="' + c + '" value="' + (c === 'foreColor' ? '#c00000' : '#ffff00') + '"></label>'
      }
      return '<button type="button" class="wb-docedit-btn" data-de="' + c + '" title="' + escA(t('workbench.docedit.t_' + c)) + '">' + tool[1] + '</button>'
    }).join('')
    var style = document.createElement('style')
    style.textContent = docScopeCss(css)
    var paper = document.createElement('div')
    paper.className = 'wb-docedit-paper'
    var page = document.createElement('div')
    page.className = 'wb-docedit-page'
    page.setAttribute('contenteditable', 'true')
    page.setAttribute('spellcheck', 'true')
    page.setAttribute('role', 'textbox')
    page.setAttribute('aria-multiline', 'true')
    page.setAttribute('aria-label', st.name || t('workbench.docedit.open'))
    // adoptNode MOVES the node out of the parsed document. importNode only copied it, so
    // doc.body.firstChild never changed and the loop never ended: the tab froze on any document
    // that had content.
    while (doc.body.firstChild) page.appendChild(document.adoptNode(doc.body.firstChild))
    paper.appendChild(page)
    var foot = document.createElement('div')
    foot.className = 'wb-docedit-foot'
    foot.innerHTML = '<button type="button" class="btn-primary" data-de-act="save">' + esc(t('workbench.docedit.save')) + '</button> '
      + '<button type="button" class="btn-secondary" data-de-act="cancel">' + esc(t('common.cancel')) + '</button>'
      + '<span class="wb-docedit-status" data-de-status></span>'
      + '<p class="wb-hint">' + esc(t('workbench.docedit.hint', { ext: '.' + st.ext })) + '</p>'
    host.appendChild(style)
    host.appendChild(bar)
    host.appendChild(paper)
    host.appendChild(foot)
    // Sajat figyelok: a gepeles es a formazas NEM rajzolja ujra a Munkapadot.
    bar.addEventListener('mousedown', function (e) {
      // A gomb ne vegye el a kijelolest a szovegtol.
      if (e.target && e.target.closest && e.target.closest('[data-de], [data-de-swatch]')) e.preventDefault()
    })
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-de]') : null
      if (b) { docExec(b.getAttribute('data-de')); return }
      var sw = e.target && e.target.closest ? e.target.closest('[data-de-swatch]') : null
      if (!sw) return
      var cmd = sw.getAttribute('data-de-swatch')
      var hex = sw.getAttribute('data-wb-hex')
      if ((cmd !== 'foreColor' && cmd !== 'hiliteColor') || !/^#[0-9a-fA-F]{6}$/.test(hex || '')) return
      docExec(cmd, hex)
      // The colour field next to the buttons shows the colour just used, as after picking it there.
      var field = bar.querySelector('[data-de-color="' + cmd + '"]')
      if (field) field.value = hex
    })
    bar.addEventListener('change', function (e) {
      var el = e.target
      if (!el) return
      if (el.hasAttribute('data-de-block') && el.value) { docExec('formatBlock', el.value); el.value = '' }
      else if (el.hasAttribute('data-de-size') && el.value) { docExec('fontSize', el.value); el.value = '' }
      else if (el.hasAttribute('data-de-color')) docExec(el.getAttribute('data-de-color'), el.value)
    })
    page.addEventListener('input', function () { st.dirty = true; docStatus('') })
    var remember = function () { docSaveRange(st) }
    page.addEventListener('keyup', remember)
    page.addEventListener('mouseup', remember)
    page.addEventListener('blur', remember)
    foot.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-de-act]') : null
      if (!b) return
      if (b.getAttribute('data-de-act') === 'save') saveDocEdit()
      else closeDocEdit(false)
    })
    st.host = host
    st.page = page
    docBrandFill(st)
  }

  /** The brand colour buttons in front of the editor's colour fields (K-4.2: brand colours first in
   *  every colour picker). The toolbar is built once, when the document opens, and the brand may
   *  arrive (or change) later -- so every render calls this, and it rewrites the slots only when the
   *  brand colours changed. Without a brand the slots stay empty. */
  function docBrandFill(st) {
    if (!st || !st.host) return
    var key = JSON.stringify((WB.brand && WB.brand.colors) || [])
    if (st.brandKey === key) return
    st.brandKey = key
    var slots = st.host.querySelectorAll('[data-de-brand]')
    for (var i = 0; i < slots.length; i++) {
      slots[i].innerHTML = brandSwatchRow('data-de-swatch="' + escA(slots[i].getAttribute('data-de-brand')) + '"', '')
    }
  }

  function docSaveRange(st) {
    try {
      var sel = window.getSelection && window.getSelection()
      if (sel && sel.rangeCount && st.page && st.page.contains(sel.anchorNode)) st.range = sel.getRangeAt(0).cloneRange()
    } catch (_e) { /* nincs kijeloles */ }
  }

  function docRestoreRange(st) {
    if (!st.range || !st.page) return
    try {
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(st.range)
    } catch (_e) { /* a kijeloles mar nem ervenyes */ }
  }

  function docExec(cmd, value) {
    var st = WB.docEdit
    if (!st || !st.page || st.busy) return
    if (document.activeElement !== st.page) { st.page.focus(); docRestoreRange(st) }
    try {
      if (cmd === 'hiliteColor' && !document.queryCommandSupported('hiliteColor')) cmd = 'backColor'
      document.execCommand('styleWithCSS', false, cmd === 'hiliteColor' || cmd === 'backColor')
      if (cmd === 'formatBlock') document.execCommand('formatBlock', false, '<' + value + '>')
      else document.execCommand(cmd, false, value == null ? null : value)
    } catch (_e) { /* a bongeszo nem ismeri: nem tortenik semmi */ }
    st.dirty = true
    docSaveRange(st)
  }

  function docStatus(text) {
    var st = WB.docEdit
    if (!st || !st.host) return
    var el = st.host.querySelector('[data-de-status]')
    if (el) el.textContent = text || ''
  }

  function docEditMount() {
    if (!pdfDomOk()) return
    var st = WB.docEdit
    var slot = document.querySelector('[data-wb-docedit]')
    if (!st || !st.host || !slot) return
    docBrandFill(st)
    if (st.host.parentNode !== slot) {
      var had = document.activeElement === st.page || (st.host.parentNode == null && st.range)
      slot.appendChild(st.host)
      if (had && st.page) { st.page.focus(); docRestoreRange(st) }
    }
  }

  function closeDocEdit(force) {
    var st = WB.docEdit
    if (!st) return
    if (!force && st.dirty && !window.confirm(t('workbench.docedit.confirm_discard'))) return
    WB.docEdit = null
    render()
  }

  function saveDocEdit() {
    var st = WB.docEdit
    if (!st || st.busy || !st.page) return
    var itemId = st.itemId
    var html = '<!DOCTYPE html>\n<html><head>' + st.head + '</head><body>' + st.page.innerHTML + '</body></html>\n'
    st.busy = true
    docStatus(t('workbench.docedit.saving'))
    var btns = st.host.querySelectorAll('[data-de-act]')
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/doc-html?base_version=' + encodeURIComponent(st.baseVersion || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
    var done = function (msg, detail) {
      var s2 = WB.docEdit
      if (!s2 || s2.itemId !== itemId) return
      s2.busy = false
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false
      docStatus(msg + (detail ? ' (' + detail + ')' : ''))
      window.showToast(msg)
    }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        if (!res.ok) { done((data && data.message) || t('workbench.err.http', { status: res.status }), data && data.detail); return }
        if (WB.docEdit && WB.docEdit.itemId === itemId) WB.docEdit = null
        applyVersions(data)
        window.showToast(t('workbench.docedit.saved', { n: data && data.version ? data.version.version_no : '', name: (data && data.name) || '' }))
      })
    }).catch(function () { done(t('workbench.err.network')) })
  }

  // ---- PDF: raíras, kiemeles, kitakaras ----
  //
  // A lapokat a mar meglevo pdf.js rajzolja ki (sajat kiszolgalorol, halozat
  // nelkul is). A jelolesek PDF-pontban tarolodnak (nagyitasfuggetlenul), es
  // mentesnel a lap + a jelolesek EGY kepkent kerulnek az uj PDF-be: igy a
  // kitakart szoveg VALOBAN eltunik (nem csak egy fekete doboz takarja).

  var PDFEDIT_SAVE_SCALE = 2
  var PDFEDIT_MAX_PX = 2600
  var PDFEDIT_COLORS = { black: '#000000', red: '#c00000', blue: '#1f4fbf' }

  function openPdfEdit() {
    var p = WB.preview
    if (!p || p.kind !== 'pdf' || !p.url || !docCanEdit(p)) return
    var itemId = WB.selectedId
    WB.pdfEdit = {
      itemId: itemId, url: p.url, name: p.name || '', baseVersion: (WB.detail && WB.detail.item && WB.detail.item.current_version_id) || '',
      loading: true, error: null, detail: null, busy: false, host: null, doc: null, pages: [], anns: [],
      tool: 'hl', color: 'black', size: 14, drag: null,
    }
    render()
    pdfLoadLib().then(function (lib) {
      return lib.getDocument({ url: p.url, isEvalSupported: false, cMapUrl: PDFJS_VENDOR_BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS_VENDOR_BASE + 'standard_fonts/', wasmUrl: PDFJS_VENDOR_BASE + 'wasm/', iccUrl: PDFJS_VENDOR_BASE + 'iccs/' }).promise
    }).then(function (doc) {
      var st = WB.pdfEdit
      if (!st || st.itemId !== itemId) { try { doc.destroy() } catch (_e) {} return }
      st.doc = doc
      st.loading = false
      pdfEditBuildHost(st)
      render()
      pdfEditRenderPages(st)
    }).catch(function (err) {
      var st = WB.pdfEdit
      if (!st || st.itemId !== itemId) return
      st.loading = false
      st.error = (err && err.message) || t('workbench.pdf.failed')
      st.detail = (err && err.detail) || null
      render()
    })
  }

  function pdfEditHtml() {
    var st = WB.pdfEdit
    if (st.loading) return '<p class="wb-muted">' + esc(t('workbench.pdfedit.loading')) + '</p>'
    if (st.error) {
      return '<p class="wb-preview-bad">' + esc(st.error) + '</p>'
        + (st.detail ? '<p class="wb-hint">' + esc(st.detail) + '</p>' : '')
        + '<p><button type="button" class="btn-secondary" data-wb-act="pdf-edit-close">' + esc(t('workbench.docedit.back')) + '</button></p>'
    }
    return '<div class="wb-docedit-slot" data-wb-pdfedit="1"></div>'
  }

  function pdfEditBuildHost(st) {
    var host = document.createElement('div')
    host.className = 'wb-pdfedit'
    var bar = document.createElement('div')
    bar.className = 'wb-docedit-bar wb-pdfedit-bar'
    bar.innerHTML = ['hl', 'redact', 'text'].map(function (k) {
      return '<button type="button" class="wb-docedit-btn wb-pdfedit-tool" data-pe-tool="' + k + '" aria-pressed="' + (st.tool === k) + '">'
        + esc(t('workbench.pdfedit.tool_' + k)) + '</button>'
    }).join('')
      + '<input type="text" class="wb-input wb-pdfedit-text" data-pe-text placeholder="' + escA(t('workbench.pdfedit.text_placeholder')) + '" aria-label="' + escA(t('workbench.pdfedit.text_placeholder')) + '">'
      + '<select class="wb-docedit-select" data-pe-size title="' + escA(t('workbench.pdfedit.size')) + '">'
      + [10, 12, 14, 18, 24, 32].map(function (n) { return '<option value="' + n + '"' + (n === st.size ? ' selected' : '') + '>' + n + ' pt</option>' }).join('') + '</select>'
      + '<select class="wb-docedit-select" data-pe-color title="' + escA(t('workbench.pdfedit.color')) + '">'
      + Object.keys(PDFEDIT_COLORS).map(function (c) { return '<option value="' + c + '">' + esc(t('workbench.pdfedit.color_' + c)) + '</option>' }).join('') + '</select>'
      + '<span class="wb-docedit-sep"></span>'
      + '<button type="button" class="wb-docedit-btn" data-pe-act="undo">' + esc(t('workbench.pdfedit.undo')) + '</button>'
    var pages = document.createElement('div')
    pages.className = 'wb-pdfedit-pages'
    var foot = document.createElement('div')
    foot.className = 'wb-docedit-foot'
    foot.innerHTML = '<button type="button" class="btn-primary" data-pe-act="save">' + esc(t('workbench.pdfedit.save')) + '</button> '
      + '<button type="button" class="btn-secondary" data-pe-act="cancel">' + esc(t('common.cancel')) + '</button>'
      + '<span class="wb-docedit-status" data-pe-status></span>'
      + '<p class="wb-hint">' + esc(t('workbench.pdfedit.hint')) + '</p>'
    host.appendChild(bar)
    host.appendChild(pages)
    host.appendChild(foot)
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-pe-tool],[data-pe-act]') : null
      if (!b) return
      if (b.hasAttribute('data-pe-tool')) {
        st.tool = b.getAttribute('data-pe-tool')
        var all = bar.querySelectorAll('[data-pe-tool]')
        for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-pressed', String(all[i] === b))
        if (st.tool === 'text') { var ti = bar.querySelector('[data-pe-text]'); if (ti) ti.focus() }
      } else if (b.getAttribute('data-pe-act') === 'undo') {
        var last = st.anns.pop()
        if (last) pdfEditDrawOverlay(st, last.page)
      }
    })
    bar.addEventListener('change', function (e) {
      var el = e.target
      if (el && el.hasAttribute('data-pe-size')) st.size = Number(el.value) || 14
      if (el && el.hasAttribute('data-pe-color')) st.color = PDFEDIT_COLORS[el.value] ? el.value : 'black'
    })
    foot.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-pe-act]') : null
      if (!b) return
      if (b.getAttribute('data-pe-act') === 'save') savePdfEdit()
      else closePdfEdit(false)
    })
    st.host = host
    st.pagesEl = pages
    st.barEl = bar
  }

  /** A lapok kirajzolasa a szerkeszto szelessegere. Minden laphoz egy
   *  atlatszo reteg tartozik: arra huzol, arra kerulnek a jelolesek. */
  function pdfEditRenderPages(st) {
    var n = st.doc.numPages
    var width = Math.max(320, Math.min(900, (st.pagesEl.clientWidth || 800) - 8))
    var chain = Promise.resolve()
    for (var i = 1; i <= n; i++) {
      (function (no) {
        chain = chain.then(function () {
          if (WB.pdfEdit !== st) return null
          return st.doc.getPage(no).then(function (page) {
            var vp1 = page.getViewport({ scale: 1 })
            var ds = width / vp1.width
            var vp = page.getViewport({ scale: ds })
            var wrap = document.createElement('div')
            wrap.className = 'wb-pdfedit-page'
            wrap.style.width = Math.floor(vp.width) + 'px'
            wrap.style.height = Math.floor(vp.height) + 'px'
            var base = document.createElement('canvas')
            base.width = Math.floor(vp.width)
            base.height = Math.floor(vp.height)
            var over = document.createElement('canvas')
            over.className = 'wb-pdfedit-overlay'
            over.width = base.width
            over.height = base.height
            wrap.appendChild(base)
            wrap.appendChild(over)
            st.pagesEl.appendChild(wrap)
            st.pages[no - 1] = { no: no, w: vp1.width, h: vp1.height, ds: ds, over: over }
            pdfEditBindOverlay(st, no - 1)
            return page.render({ canvasContext: base.getContext('2d'), viewport: vp }).promise
          })
        })
      })(i)
    }
    chain.catch(function (err) {
      if (WB.pdfEdit !== st) return
      window.showToast(t('workbench.pdfedit.render_failed', { message: (err && err.message) || '' }))
    })
  }

  function pdfEditBindOverlay(st, idx) {
    var pg = st.pages[idx]
    var over = pg.over
    var pt = function (e) {
      var r = over.getBoundingClientRect()
      return { x: (e.clientX - r.left) * (over.width / (r.width || 1)) / pg.ds, y: (e.clientY - r.top) * (over.height / (r.height || 1)) / pg.ds }
    }
    over.addEventListener('pointerdown', function (e) {
      if (st.busy) return
      e.preventDefault()
      try { over.setPointerCapture(e.pointerId) } catch (_e) {}
      var p0 = pt(e)
      st.drag = { idx: idx, x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y }
    })
    over.addEventListener('pointermove', function (e) {
      if (!st.drag || st.drag.idx !== idx) return
      var p1 = pt(e)
      st.drag.x1 = p1.x
      st.drag.y1 = p1.y
      pdfEditDrawOverlay(st, idx)
    })
    var end = function (e) {
      var d = st.drag
      if (!d || d.idx !== idx) return
      st.drag = null
      var p1 = pt(e)
      var x = Math.min(d.x0, p1.x), y = Math.min(d.y0, p1.y)
      var w = Math.abs(p1.x - d.x0), h = Math.abs(p1.y - d.y0)
      if (st.tool === 'text') {
        var ti = st.barEl && st.barEl.querySelector('[data-pe-text]')
        var text = ti ? String(ti.value || '').trim() : ''
        if (!text) { window.showToast(t('workbench.pdfedit.text_needed')); pdfEditDrawOverlay(st, idx); return }
        st.anns.push({ page: idx, type: 'text', x: d.x0, y: d.y0, text: text, size: st.size, color: PDFEDIT_COLORS[st.color] })
      } else if (w > 2 && h > 2) {
        st.anns.push({ page: idx, type: st.tool, x: x, y: y, w: w, h: h })
      }
      pdfEditDrawOverlay(st, idx)
    }
    over.addEventListener('pointerup', end)
    over.addEventListener('pointercancel', function () { st.drag = null; pdfEditDrawOverlay(st, idx) })
  }

  /** A jelolesek kirajzolasa egy lapra `s` meretaranyban (kepernyo vagy mentes). */
  function pdfEditPaint(ctx, anns, s) {
    anns.forEach(function (a) {
      if (a.type === 'hl') { ctx.fillStyle = 'rgba(255, 230, 0, 0.4)'; ctx.fillRect(a.x * s, a.y * s, a.w * s, a.h * s) }
      else if (a.type === 'redact') { ctx.fillStyle = '#000000'; ctx.fillRect(a.x * s, a.y * s, a.w * s, a.h * s) }
      else if (a.type === 'text') {
        ctx.fillStyle = a.color || '#000000'
        ctx.font = Math.round(a.size * s) + 'px sans-serif'
        ctx.textBaseline = 'top'
        ctx.fillText(a.text, a.x * s, a.y * s)
      }
    })
  }

  function pdfEditDrawOverlay(st, idx) {
    var pg = st.pages[idx]
    if (!pg) return
    var ctx = pg.over.getContext('2d')
    ctx.clearRect(0, 0, pg.over.width, pg.over.height)
    pdfEditPaint(ctx, st.anns.filter(function (a) { return a.page === idx }), pg.ds)
    var d = st.drag
    if (d && d.idx === idx && st.tool !== 'text') {
      ctx.strokeStyle = st.tool === 'redact' ? '#000' : '#c9a400'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(Math.min(d.x0, d.x1) * pg.ds, Math.min(d.y0, d.y1) * pg.ds, Math.abs(d.x1 - d.x0) * pg.ds, Math.abs(d.y1 - d.y0) * pg.ds)
      ctx.setLineDash([])
    }
  }

  function pdfEditMount() {
    if (!pdfDomOk()) return
    var st = WB.pdfEdit
    var slot = document.querySelector('[data-wb-pdfedit]')
    if (!st || !st.host || !slot) return
    if (st.host.parentNode !== slot) slot.appendChild(st.host)
  }

  function pdfEditStatus(text) {
    var st = WB.pdfEdit
    if (!st || !st.host) return
    var el = st.host.querySelector('[data-pe-status]')
    if (el) el.textContent = text || ''
  }

  function closePdfEdit(force) {
    var st = WB.pdfEdit
    if (!st) return
    if (!force && st.anns.length && !window.confirm(t('workbench.docedit.confirm_discard'))) return
    if (st.doc && st.doc.destroy) { try { st.doc.destroy() } catch (_e) {} }
    WB.pdfEdit = null
    render()
  }

  /** Egy JPEG-lapokbol allo PDF bajtjai. Szandekosan a legegyszerubb ervenyes
   *  PDF: lapnkent egy kep, a lap meretere feszitve (nincs kulso konyvtar). */
  function pdfFromJpegs(pages) {
    var enc = new TextEncoder()
    var chunks = []
    var pos = 0
    var offsets = []
    var push = function (x) { var b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); pos += b.length }
    var num = function (v) { return (Math.round(v * 100) / 100).toString() }
    push('%PDF-1.4\n')
    push(new Uint8Array([37, 226, 227, 207, 211, 10]))
    var n = pages.length
    var total = 2 + n * 3
    var obj = function (id, body) { offsets[id] = pos; push(id + ' 0 obj\n'); push(body); push('\nendobj\n') }
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    var kids = []
    for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R')
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>')
    pages.forEach(function (p, i) {
      var pid = 3 + i * 3, cid = pid + 1, iid = pid + 2
      obj(pid, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(p.w) + ' ' + num(p.h) + '] /Resources << /XObject << /Im0 ' + iid + ' 0 R >> >> /Contents ' + cid + ' 0 R >>')
      var content = 'q ' + num(p.w) + ' 0 0 ' + num(p.h) + ' 0 0 cm /Im0 Do Q'
      obj(cid, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream')
      offsets[iid] = pos
      push(iid + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + p.pw + ' /Height ' + p.ph
        + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n')
      push(p.jpeg)
      push('\nendstream\nendobj\n')
    })
    var xref = pos
    var x = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n'
    for (var k = 1; k <= total; k++) x += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n'
    push(x)
    push('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
    return new Blob(chunks, { type: 'application/pdf' })
  }

  function savePdfEdit() {
    var st = WB.pdfEdit
    if (!st || st.busy || !st.doc) return
    if (!st.anns.length) { window.showToast(t('workbench.pdfedit.empty')); return }
    st.busy = true
    var itemId = st.itemId
    var n = st.doc.numPages
    var out = []
    var btns = st.host.querySelectorAll('[data-pe-act]')
    for (var b = 0; b < btns.length; b++) btns[b].disabled = true
    var fail = function (msg) {
      var s2 = WB.pdfEdit
      if (!s2 || s2.itemId !== itemId) return
      s2.busy = false
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false
      pdfEditStatus(msg)
      window.showToast(msg)
    }
    var chain = Promise.resolve()
    for (var i = 1; i <= n; i++) {
      (function (no) {
        chain = chain.then(function () {
          pdfEditStatus(t('workbench.pdfedit.saving', { i: no, n: n }))
          return st.doc.getPage(no).then(function (page) {
            var vp1 = page.getViewport({ scale: 1 })
            var s = Math.min(PDFEDIT_SAVE_SCALE, PDFEDIT_MAX_PX / Math.max(vp1.width, vp1.height))
            var vp = page.getViewport({ scale: s })
            var cv = document.createElement('canvas')
            cv.width = Math.max(1, Math.floor(vp.width))
            cv.height = Math.max(1, Math.floor(vp.height))
            var ctx = cv.getContext('2d')
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, cv.width, cv.height)
            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              pdfEditPaint(ctx, st.anns.filter(function (a) { return a.page === no - 1 }), s)
              return new Promise(function (resolve, reject) {
                cv.toBlob(function (blob) {
                  if (!blob) { reject(new Error('toBlob')); return }
                  blob.arrayBuffer().then(function (ab) {
                    out.push({ w: vp1.width, h: vp1.height, pw: cv.width, ph: cv.height, jpeg: new Uint8Array(ab) })
                    resolve()
                  }, reject)
                }, 'image/jpeg', 0.9)
              })
            })
          })
        })
      })(i)
    }
    chain.then(function () {
      var blob = pdfFromJpegs(out)
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/pdf-edit?base_version=' + encodeURIComponent(st.baseVersion || '')
        + '&lang=' + encodeURIComponent(window._lang || 'hu')
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: blob }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (data) {
          if (!res.ok) { fail((data && data.message) || t('workbench.err.http', { status: res.status })); return }
          if (WB.pdfEdit && WB.pdfEdit.itemId === itemId) {
            try { WB.pdfEdit.doc.destroy() } catch (_e) {}
            WB.pdfEdit = null
          }
          applyVersions(data)
          window.showToast(t('workbench.pdfedit.saved', { n: data && data.version ? data.version.version_no : '', name: (data && data.name) || '' }))
        })
      }, function () { fail(t('workbench.err.network')) })
    }).catch(function (err) {
      fail(t('workbench.pdfedit.render_failed', { message: (err && err.message) || '' }))
    })
  }

  function pdfToDocx() {
    var p = WB.preview
    if (!p || p.kind !== 'pdf' || !docCanEdit(p) || WB.pdfToDocxBusy) return
    var itemId = WB.selectedId
    WB.pdfToDocxBusy = itemId
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/pdf-to-docx', {
      base_version: (WB.detail && WB.detail.item && WB.detail.item.current_version_id) || '',
    }).then(function (r) {
      WB.pdfToDocxBusy = null
      if (WB.selectedId !== itemId) return
      if (!r.ok) {
        render()
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        return
      }
      applyVersions(r.data)
      window.showToast(t('workbench.pdfedit.to_docx_done', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  // ---- TABLAZAT-SZERKESZTES (#406, 15. pont) --------------------------------
  //
  // Az .xlsx / .csv munkadarab racskent: a cellak helyben irhatok, a mentes UJ
  // fajlt es UJ verziot csinal (a szerver foltozza az eredetit, a formazas
  // marad). A racs tartalma az ALLAPOTBAN el (minden gepeles oda megy), igy egy
  // kozben erkezo ujrarajzolas (chat, attekinto) nem torli a begepelt cellat,
  // es a fokuszt is visszatesszuk ugyanarra a cellara.

  var TABLE_PAGE = 100

  function isTableName(name) { return /\.(xlsx|xlsm|csv|tsv)$/i.test(String(name || '')) }

  function tableOpen() { return !!(WB.table && WB.table.itemId === WB.selectedId) }

  function tableEditable() {
    var tb = WB.table
    return !!(tb && tb.data && tb.data.current && !archived())
  }

  function tableSheet() {
    var tb = WB.table
    return tb && tb.sheets ? tb.sheets[tb.sheet] || null : null
  }

  function tableButtonHtml(p) {
    if (!p || !p.rel || !isTableName(p.name)) return ''
    if (!p.available && p.reason !== 'needs_conversion') return ''
    return '<p><button type="button" class="btn-primary" data-wb-act="table-open"' + (WB.table && WB.table.loading ? ' disabled' : '') + '>'
      + esc(t(archived() ? 'workbench.table.open_readonly' : 'workbench.table.open')) + '</button></p>'
  }

  function openTable(itemId, versionId) {
    if (!itemId) return
    WB.table = { itemId: itemId, loading: true, busy: false, data: null, sheets: null, sheet: 0, page: 0, sel: { r: 0, c: 0 }, dirty: false, error: null }
    render()
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/table' + (versionId ? '?version=' + encodeURIComponent(versionId) : '')
    api('GET', url).then(function (r) {
      if (!WB.table || WB.table.itemId !== itemId) return
      WB.table.loading = false
      if (!r.ok) {
        WB.table.error = { message: r.message, detail: r.data && r.data.detail }
        render()
        return
      }
      WB.table.data = r.data
      // Munkapeldany: a szerver valaszat nem irjuk at, igy latszik, mi valtozott.
      WB.table.sheets = (r.data.sheets || []).map(function (s) {
        return { name: s.name, rows: (s.rows || []).map(function (row) { return row.slice() }) }
      })
      if (!WB.table.sheets.length) WB.table.sheets = [{ name: '', rows: [['']] }]
      render()
    })
  }

  function closeTable() {
    if (WB.table && WB.table.dirty && !window.confirm(t('workbench.table.discard_confirm'))) return
    WB.table = null
    render()
  }

  function tableCols(rows) {
    var n = 0
    for (var i = 0; i < rows.length; i++) if (rows[i].length > n) n = rows[i].length
    return n
  }

  function colLetter(i) {
    var n = i + 1
    var s = ''
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
    return s
  }

  function tableTabsHtml() {
    var tb = WB.table
    if (!tb.sheets || tb.sheets.length < 2) return ''
    return '<div class="wb-table-tabs" role="tablist">' + tb.sheets.map(function (s, i) {
      return '<button type="button" role="tab" class="' + (i === tb.sheet ? 'btn-primary' : 'btn-secondary') + '"'
        + ' aria-selected="' + (i === tb.sheet) + '" data-wb-act="table-sheet" data-wb-sheet="' + i + '">' + esc(s.name || String(i + 1)) + '</button>'
    }).join('') + '</div>'
  }

  function tableToolsHtml() {
    if (!tableEditable()) return ''
    var csv = WB.table.data.format === 'csv'
    var b = function (act, key) {
      return '<button type="button" class="btn-secondary" data-wb-act="' + act + '">' + esc(t(key)) + '</button>'
    }
    if (csv) {
      return '<div class="wb-table-tools">'
        + b('table-row-add', 'workbench.table.row_insert')
        + b('table-row-del', 'workbench.table.row_delete')
        + b('table-col-add', 'workbench.table.col_insert')
        + b('table-col-del', 'workbench.table.col_delete')
        + '</div>'
    }
    return '<div class="wb-table-tools">'
      + b('table-row-add', 'workbench.table.row_append')
      + b('table-row-del', 'workbench.table.row_remove_last')
      + b('table-col-add', 'workbench.table.col_append')
      + b('table-col-del', 'workbench.table.col_remove_last')
      + '</div>'
  }

  function tableGridHtml() {
    var sh = tableSheet()
    if (!sh) return ''
    var rows = sh.rows
    var nCols = tableCols(rows)
    var pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE))
    var page = Math.min(WB.table.page, pages - 1)
    WB.table.page = page
    var from = page * TABLE_PAGE
    var to = Math.min(rows.length, from + TABLE_PAGE)
    var ro = tableEditable() ? '' : ' readonly'
    var html = '<div class="wb-table-scroll"><table class="wb-tgrid"><thead><tr><th class="wb-tgrid-corner"></th>'
    for (var c = 0; c < nCols; c++) html += '<th scope="col">' + colLetter(c) + '</th>'
    html += '</tr></thead><tbody>'
    for (var r = from; r < to; r++) {
      html += '<tr><th scope="row">' + (r + 1) + '</th>'
      for (var c2 = 0; c2 < nCols; c2++) {
        var v = rows[r][c2] == null ? '' : rows[r][c2]
        html += '<td><input class="wb-cell" type="text" id="wbCell_' + r + '_' + c2 + '" value="' + escA(v) + '"'
          + ' aria-label="' + escA(colLetter(c2) + (r + 1)) + '"' + ro + '></td>'
      }
      html += '</tr>'
    }
    html += '</tbody></table></div>'
    if (pages > 1) {
      html += '<div class="wb-table-pager">'
        + '<button type="button" class="btn-secondary" data-wb-act="table-page-prev"' + (page === 0 ? ' disabled' : '') + '>' + esc(t('workbench.table.page_prev')) + '</button>'
        + '<span class="wb-muted">' + esc(t('workbench.table.page_info', { from: from + 1, to: to, total: rows.length })) + '</span>'
        + '<button type="button" class="btn-secondary" data-wb-act="table-page-next"' + (page >= pages - 1 ? ' disabled' : '') + '>' + esc(t('workbench.table.page_next')) + '</button>'
        + '</div>'
    }
    return html
  }

  function tableHtml() {
    var tb = WB.table
    if (tb.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    var close = '<button type="button" class="btn-secondary" data-wb-act="table-close">' + esc(t('workbench.table.close')) + '</button>'
    if (tb.error) {
      return '<div class="wb-table"><p class="wb-preview-bad">' + esc(tb.error.message || '') + '</p>'
        + (tb.error.detail ? '<p class="wb-hint">' + esc(tb.error.detail) + '</p>' : '')
        + '<div class="wb-form-actions">' + close + '</div></div>'
    }
    var d = tb.data
    var hints = []
    if (!d.current) hints.push(t('workbench.table.old_version'))
    else if (archived()) hints.push(t('workbench.table.readonly_archived'))
    else {
      hints.push(t('workbench.table.hint_save'))
      hints.push(t(d.format === 'csv' ? 'workbench.table.hint_csv' : 'workbench.table.hint_xlsx'))
      hints.push(t('workbench.table.hint_formula'))
      if (d.format === 'xlsx') hints.push(t('workbench.table.hint_dates'))
    }
    return '<div class="wb-table">'
      + tableTabsHtml() + tableToolsHtml() + tableGridHtml()
      + '<div class="wb-form-actions">'
      + (tableEditable()
        ? '<button type="button" class="btn-primary" data-wb-act="table-save"' + (tb.busy ? ' disabled' : '') + '>'
          + esc(tb.busy ? t('workbench.parts.saving') : t('workbench.table.save')) + '</button>'
        : '')
      + close + '</div>'
      + hints.map(function (h) { return '<p class="wb-hint">' + esc(h) + '</p>' }).join('')
      + '</div>'
  }

  /** Egy cella tartalma az allapotba (gepeles kozben, ujrarajzolas NELKUL). */
  function tableCellInput(id, value) {
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(id || ''))
    var sh = tableSheet()
    if (!m || !sh || !tableEditable()) return false
    var r = Number(m[1])
    var c = Number(m[2])
    if (!sh.rows[r]) return false
    sh.rows[r][c] = String(value == null ? '' : value)
    WB.table.sel = { r: r, c: c }
    WB.table.dirty = true
    return true
  }

  function rowHasContent(row) {
    for (var i = 0; i < row.length; i++) if (row[i] !== '' && row[i] != null) return true
    return false
  }

  function tableStructure(what) {
    var sh = tableSheet()
    if (!sh || !tableEditable()) return
    var rows = sh.rows
    var nCols = Math.max(1, tableCols(rows))
    var csv = WB.table.data.format === 'csv'
    var sel = WB.table.sel
    var i
    if (what === 'row-add') {
      var blank = []
      for (i = 0; i < nCols; i++) blank.push('')
      var at = csv ? Math.min(rows.length, sel.r + 1) : rows.length
      rows.splice(at, 0, blank)
      WB.table.sel = { r: at, c: sel.c }
      WB.table.page = Math.floor(at / TABLE_PAGE)
    } else if (what === 'row-del') {
      if (rows.length <= 1) return
      var rIdx = csv ? Math.min(sel.r, rows.length - 1) : rows.length - 1
      if (rowHasContent(rows[rIdx]) && !window.confirm(t('workbench.table.row_delete_confirm', { n: rIdx + 1 }))) return
      rows.splice(rIdx, 1)
      WB.table.sel = { r: Math.max(0, Math.min(rIdx, rows.length - 1)), c: sel.c }
    } else if (what === 'col-add') {
      var cAt = csv ? Math.min(nCols, sel.c + 1) : nCols
      for (i = 0; i < rows.length; i++) {
        while (rows[i].length < nCols) rows[i].push('')
        rows[i].splice(cAt, 0, '')
      }
      WB.table.sel = { r: sel.r, c: cAt }
    } else if (what === 'col-del') {
      if (nCols <= 1) return
      var cIdx = csv ? Math.min(sel.c, nCols - 1) : nCols - 1
      var used = false
      for (i = 0; i < rows.length; i++) if (rows[i][cIdx]) used = true
      if (used && !window.confirm(t('workbench.table.col_delete_confirm', { c: colLetter(cIdx) }))) return
      for (i = 0; i < rows.length; i++) rows[i].splice(cIdx, 1)
      WB.table.sel = { r: sel.r, c: Math.max(0, Math.min(cIdx, nCols - 2)) }
    }
    WB.table.dirty = true
    render()
  }

  function saveTable() {
    var tb = WB.table
    if (!tb || tb.busy || !tableEditable() || !WB.selectedId) return
    var itemId = WB.selectedId
    tb.busy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/table', {
      base_version: tb.data.version_id,
      sheets: tb.sheets,
      delimiter: tb.data.delimiter,
    }).then(function (r) {
      if (!WB.table || WB.table.itemId !== itemId) return
      WB.table.busy = false
      if (!r.ok) {
        render()
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        return
      }
      WB.table = null
      applyVersions(r.data)
      window.showToast(t('workbench.table.saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  function createTable() {
    var titleEl = document.getElementById('wbNewTitle')
    if (!titleEl || WB.busy || archived()) return
    var title = String(titleEl.value || '').trim()
    if (!title) { window.showToast(t('workbench.table.title_required')); return }
    // #454: the "Which folder?" field of the same form holds here too.
    var folderEl = document.getElementById('wbNewFolder')
    var payload = { project_id: WB.projectId, title: title }
    if (folderEl && folderEl.value) payload.folder = folderEl.value
    var newFolderEl = document.getElementById('wbNewFolderName')
    if (newFolderEl && String(newFolderEl.value || '').trim()) payload.new_folder = String(newFolderEl.value).trim()
    WB.busy = true
    render()
    api('POST', '/api/workbench/items/new-table', payload).then(function (r) {
      WB.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      WB.selectedId = r.data.item.id
      WB.panel = 'editor'
      WB.detail = { item: r.data.item, versions: r.data.versions, project: WB.project }
      window.showToast(t('workbench.table.created', { name: r.data.name || '' }) + (r.data.folder_existed ? ' ' + t('workbench.new.folder_existed') : ''))
      load(WB.projectId)
      loadDetail(r.data.item.id)
      openTable(r.data.item.id, null)
    })
  }

  // ---- KEPSZERKESZTES EGERREL (#406, 16. pont) -------------------------------
  //
  // Minden a bongeszoben tortenik (canvas), a gepre nem kell kepszerkeszto. A
  // lepesek sorrendje rogzitett: forgatas/tukrozes -> vagas -> meret ->
  // hatter kivetele -> felirat. Mentes: a kesz kep UJ fajl + UJ verzio (a regi
  // kep megmarad). A vagokeret egerrel ES ujjal is huzhato (Pointer Events), es
  // szamokkal is megadhato -- a ket ut ugyanazt az allapotot irja.

  var IMG_PREVIEW_MAX = 900
  var IMG_MAX_SIDE = 8000
  var IMG_MAX_PIXELS = 16000000
  var IMG_ASPECTS = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 }

  function imgRotSize(w, h, rot) { return rot % 180 ? { w: h, h: w } : { w: w, h: h } }

  function imgClampCrop(c, W, H) {
    var w = Math.max(1, Math.min(W, Math.round(c.w)))
    var h = Math.max(1, Math.min(H, Math.round(c.h)))
    var x = Math.max(0, Math.min(W - w, Math.round(c.x)))
    var y = Math.max(0, Math.min(H - h, Math.round(c.y)))
    return { x: x, y: y, w: w, h: h }
  }

  /** A legnagyobb, adott aranyu, kozepre igazitott keret. */
  function imgAspectCrop(W, H, ratio) {
    if (!ratio) return { x: 0, y: 0, w: W, h: H }
    var w = W
    var h = Math.round(W / ratio)
    if (h > H) { h = H; w = Math.round(H * ratio) }
    return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: w, h: h }
  }

  /** A kimeneti meret: a kert szelesseg, aranyosan, a bongeszo canvas-hataran belul. */
  function imgOutSize(crop, outW) {
    var w = Math.max(1, Math.round(Number(outW) || crop.w))
    var h = Math.max(1, Math.round(crop.h * w / crop.w))
    var k = Math.min(1, IMG_MAX_SIDE / Math.max(w, h), Math.sqrt(IMG_MAX_PIXELS / (w * h)))
    return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) }
  }

  /** Egyszinu hatter kivetele: a kattintott pontbol ARASZTASSAL a hasonlo
   *  szinu, OSSZEFUGGO kepponteket atlatszova teszi. Igy a targyon beluli,
   *  veletlenul ugyanolyan szinu folt megmarad. `tol`: 0-255, csatornankent. */
  function imgFloodKey(data, W, H, seeds, tol) {
    var seen = new Uint8Array(W * H)
    var cleared = 0
    for (var s = 0; s < seeds.length; s++) {
      var sx = Math.max(0, Math.min(W - 1, Math.floor(seeds[s].x)))
      var sy = Math.max(0, Math.min(H - 1, Math.floor(seeds[s].y)))
      var si = (sy * W + sx) * 4
      var r0 = data[si]
      var g0 = data[si + 1]
      var b0 = data[si + 2]
      var stack = [sy * W + sx]
      while (stack.length) {
        var p = stack.pop()
        if (seen[p]) continue
        var i = p * 4
        if (Math.abs(data[i] - r0) > tol || Math.abs(data[i + 1] - g0) > tol || Math.abs(data[i + 2] - b0) > tol) continue
        seen[p] = 1
        if (data[i + 3] !== 0) { data[i + 3] = 0; cleared++ }
        var x = p % W
        if (x > 0) stack.push(p - 1)
        if (x < W - 1) stack.push(p + 1)
        if (p >= W) stack.push(p - W)
        if (p < W * (H - 1)) stack.push(p + W)
      }
    }
    return cleared
  }

  function imgState() { return WB.img && WB.img.itemId === WB.selectedId ? WB.img : null }

  function imgCanEdit(p) {
    var current = !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
    return !!(p && p.available && p.kind === 'image' && p.url && !archived() && current)
  }

  function openImageEditor() {
    var p = WB.preview
    if (!imgCanEdit(p) || !WB.detail) return
    var itemId = WB.selectedId
    WB.img = {
      itemId: itemId, baseVersion: WB.detail.item.current_version_id, name: p.name || '', src: p.url,
      loading: true, error: null, el: null, W: 0, H: 0, rot: 0, flip: false,
      crop: null, aspect: 'free', outW: 0,
      caption: { text: '', pos: 'bottom', size: 6, color: 'white', band: true },
      bg: { pick: false, seeds: [], tol: 32 }, rotUrl: '', outUrl: '', busy: false, dirty: false,
    }
    render()
    loadImg(p.url).then(function (im) {
      var st = imgState()
      if (!st || st.itemId !== itemId) return
      st.el = im
      st.W = im.naturalWidth || im.width
      st.H = im.naturalHeight || im.height
      st.loading = false
      imgResetGeometry(st)
      render()
      imgRefresh(true)
    }).catch(function () {
      var st = imgState()
      if (!st) return
      st.loading = false
      st.error = t('workbench.img.load_failed')
      render()
    })
  }

  function imgResetGeometry(st) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    st.crop = imgAspectCrop(rs.w, rs.h, IMG_ASPECTS[st.aspect] || 0)
    st.outW = st.crop.w
    st.bg.seeds = []
  }

  /** A forgatott/tukrozott teljes kep egy canvason. */
  function imgRotated(st, scale) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    var cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(rs.w * scale))
    cv.height = Math.max(1, Math.round(rs.h * scale))
    var ctx = cv.getContext('2d')
    ctx.save()
    ctx.translate(cv.width / 2, cv.height / 2)
    ctx.rotate(st.rot * Math.PI / 180)
    if (st.flip) ctx.scale(-1, 1)
    ctx.drawImage(st.el, -st.W * scale / 2, -st.H * scale / 2, st.W * scale, st.H * scale)
    ctx.restore()
    return cv
  }

  /** A KESZ kep. `maxSide`: elonezethez kicsinyitve, mentesnel teljes meretben. */
  function imgOutput(st, maxSide) {
    var out = imgOutSize(st.crop, st.outW)
    var k = maxSide ? Math.min(1, maxSide / Math.max(out.w, out.h)) : 1
    var ow = Math.max(1, Math.round(out.w * k))
    var oh = Math.max(1, Math.round(out.h * k))
    // A forrast csak akkora felbontasban forgatjuk, amekkora a kimenethez kell.
    var srcScale = Math.min(1, Math.max(ow / st.crop.w, oh / st.crop.h) * 1.001)
    var rot = imgRotated(st, srcScale)
    var cv = document.createElement('canvas')
    cv.width = ow
    cv.height = oh
    var ctx = cv.getContext('2d')
    ctx.drawImage(rot, st.crop.x * srcScale, st.crop.y * srcScale, st.crop.w * srcScale, st.crop.h * srcScale, 0, 0, ow, oh)
    if (st.bg.seeds.length) {
      var id = ctx.getImageData(0, 0, ow, oh)
      imgFloodKey(id.data, ow, oh, st.bg.seeds.map(function (s) { return { x: s.x * ow, y: s.y * oh } }), st.bg.tol)
      ctx.putImageData(id, 0, 0)
    }
    var cap = st.caption
    if (cap.text && cap.text.trim()) {
      var fs = Math.max(8, Math.round(oh * cap.size / 100))
      ctx.font = 'bold ' + fs + 'px sans-serif'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'center'
      var lines = wrapLines(ctx, cap.text.trim(), ow * 0.9)
      var lh = Math.round(fs * 1.25)
      var bh = lines.length * lh + Math.round(fs * 0.6)
      var top = cap.pos === 'top' ? 0 : cap.pos === 'middle' ? Math.round((oh - bh) / 2) : oh - bh
      if (cap.band) {
        ctx.fillStyle = cap.color === 'black' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'
        ctx.fillRect(0, top, ow, bh)
      }
      ctx.fillStyle = cap.color === 'black' ? '#111111' : '#ffffff'
      lines.forEach(function (ln, i) { ctx.fillText(ln, ow / 2, top + Math.round(fs * 0.3) + i * lh) })
    }
    return cv
  }

  function imgOutType(st) {
    if (st.bg.seeds.length) return 'image/png'
    return /\.jpe?g$/i.test(st.name) ? 'image/jpeg' : /\.webp$/i.test(st.name) ? 'image/webp' : 'image/png'
  }

  /** Az elonezet frissitese, ujrarajzolas NELKUL (a mezok fokusza marad). */
  function imgRefresh(rotChanged) {
    var st = imgState()
    if (!st || !st.el || typeof document.createElement !== 'function') return
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(function () {
      st.timer = null
      try {
        if (rotChanged || !st.rotUrl) {
          var rs = imgRotSize(st.W, st.H, st.rot)
          st.rotUrl = imgRotated(st, Math.min(1, IMG_PREVIEW_MAX / Math.max(rs.w, rs.h))).toDataURL('image/jpeg', 0.85)
          var stageImg = document.getElementById('wbImgStageImg')
          if (stageImg) stageImg.src = st.rotUrl
        }
        st.outUrl = imgOutput(st, IMG_PREVIEW_MAX).toDataURL('image/png')
        var outImg = document.getElementById('wbImgOut')
        if (outImg) outImg.src = st.outUrl
        else render()
      } catch (e) {
        st.error = t('workbench.img.render_failed', { message: (e && e.message) || '' })
        render()
      }
    }, 120)
  }

  function imgCropStyle(st) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    var pc = function (v, of) { return (Math.round(10000 * v / of) / 100) + '%' }
    return 'left:' + pc(st.crop.x, rs.w) + ';top:' + pc(st.crop.y, rs.h) + ';width:' + pc(st.crop.w, rs.w) + ';height:' + pc(st.crop.h, rs.h)
  }

  function imgNum(id, label, value) {
    return '<label class="wb-img-num"><span>' + esc(label) + '</span><input class="wb-input" type="number" inputmode="numeric" min="0" id="' + id + '" value="' + escA(value) + '"></label>'
  }

  function imageEditorHtml() {
    var st = imgState()
    var close = '<button type="button" class="btn-secondary" data-wb-act="img-close">' + esc(t('workbench.img.close')) + '</button>'
    if (st.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    if (st.error && !st.crop) return '<p class="wb-preview-bad">' + esc(st.error) + '</p><div class="wb-form-actions">' + close + '</div>'
    var out = imgOutSize(st.crop, st.outW)
    var cap = st.caption
    var aspects = Object.keys(IMG_ASPECTS).map(function (k) {
      return '<button type="button" class="' + (st.aspect === k ? 'btn-primary' : 'btn-secondary') + '" aria-pressed="' + (st.aspect === k) + '" data-wb-act="img-aspect" data-wb-aspect="' + escA(k) + '">'
        + esc(k === 'free' ? t('workbench.img.aspect_free') : k) + '</button>'
    }).join('')
    var sel = function (id, value, opts) {
      return '<select class="wb-input" id="' + id + '">' + opts.map(function (o) {
        return '<option value="' + escA(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
      }).join('') + '</select>'
    }
    return '<div class="wb-img">'
      + (st.error ? '<p class="wb-preview-bad">' + esc(st.error) + '</p>' : '')
      + '<div class="wb-img-cols">'
      // --- bal: vagas
      + '<div class="wb-img-col"><h5>' + esc(t('workbench.img.crop_title')) + '</h5>'
      + '<div class="wb-img-stage" id="wbImgStage"><img id="wbImgStageImg" alt="" draggable="false" src="' + escA(st.rotUrl || st.src) + '">'
      + '<div class="wb-img-crop" data-wb-crop="move" style="' + imgCropStyle(st) + '">'
      + ['nw', 'ne', 'sw', 'se'].map(function (h) { return '<span class="wb-img-h wb-img-h-' + h + '" data-wb-crop="' + h + '"></span>' }).join('')
      + '</div></div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.crop_hint')) + '</p>'
      + '<div class="wb-img-row">' + aspects + '</div>'
      + '<div class="wb-img-row">'
      + imgNum('wbImgCx', 'X', st.crop.x) + imgNum('wbImgCy', 'Y', st.crop.y)
      + imgNum('wbImgCw', t('workbench.img.width'), st.crop.w) + imgNum('wbImgCh', t('workbench.img.height'), st.crop.h)
      + '</div>'
      + '<div class="wb-img-row">'
      + '<button type="button" class="btn-secondary" data-wb-act="img-rot-left">' + esc(t('workbench.img.rotate_left')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-rot-right">' + esc(t('workbench.img.rotate_right')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-flip" aria-pressed="' + !!st.flip + '">' + esc(t('workbench.img.flip')) + '</button>'
      + '</div></div>'
      // --- jobb: eredmeny
      + '<div class="wb-img-col"><h5>' + esc(t('workbench.img.result_title')) + '</h5>'
      + '<div class="wb-img-result' + (st.bg.pick ? ' wb-img-picking' : '') + '"><img id="wbImgOut" alt="' + escA(t('workbench.img.result_title')) + '" draggable="false"'
      + (st.bg.pick ? ' data-wb-img-pick="1"' : '') + ' src="' + escA(st.outUrl || st.rotUrl || st.src) + '"></div>'
      + '<p class="wb-muted">' + esc(t('workbench.img.out_size', { w: out.w, h: out.h })) + '</p>'
      + '<div class="wb-img-row">' + imgNum('wbImgOutW', t('workbench.img.out_width'), st.outW)
      + '<button type="button" class="btn-secondary" data-wb-act="img-size-orig">' + esc(t('workbench.img.size_orig')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-size-half">50%</button></div>'
      + '<h5>' + esc(t('workbench.img.caption_title')) + '</h5>'
      + '<input class="wb-input" type="text" id="wbImgCapText" maxlength="300" placeholder="' + escA(t('workbench.img.caption_placeholder')) + '" value="' + escA(cap.text) + '">'
      + '<div class="wb-img-row">'
      + sel('wbImgCapPos', cap.pos, [['top', t('workbench.img.pos_top')], ['middle', t('workbench.img.pos_middle')], ['bottom', t('workbench.img.pos_bottom')]])
      + sel('wbImgCapColor', cap.color, [['white', t('workbench.img.color_white')], ['black', t('workbench.img.color_black')]])
      + '<label class="wb-img-num"><span>' + esc(t('workbench.img.caption_size')) + '</span><input type="range" id="wbImgCapSize" min="2" max="20" value="' + escA(cap.size) + '"></label>'
      + '<label class="wb-img-check"><input type="checkbox" id="wbImgCapBand"' + (cap.band ? ' checked' : '') + '> ' + esc(t('workbench.img.caption_band')) + '</label>'
      + '</div>'
      + '<h5>' + esc(t('workbench.img.bg_title')) + '</h5>'
      + '<div class="wb-img-row">'
      + '<button type="button" class="' + (st.bg.pick ? 'btn-primary' : 'btn-secondary') + '" aria-pressed="' + !!st.bg.pick + '" data-wb-act="img-bg-pick">' + esc(t(st.bg.pick ? 'workbench.img.bg_picking' : 'workbench.img.bg_pick')) + '</button>'
      + (st.bg.seeds.length ? '<button type="button" class="btn-secondary" data-wb-act="img-bg-clear">' + esc(t('workbench.img.bg_clear', { n: st.bg.seeds.length })) + '</button>' : '')
      + '<label class="wb-img-num"><span>' + esc(t('workbench.img.bg_tol')) + '</span><input type="range" id="wbImgTol" min="0" max="120" value="' + escA(st.bg.tol) + '"></label>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.bg_hint')) + '</p>'
      + '</div></div>'
      + '<div class="wb-form-actions">'
      + '<button type="button" class="btn-primary" data-wb-act="img-save"' + (st.busy ? ' disabled' : '') + '>' + esc(st.busy ? t('workbench.parts.saving') : t('workbench.img.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-reset">' + esc(t('workbench.img.reset')) + '</button>'
      + close + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.save_hint')) + '</p>'
      + '</div>'
  }

  function imgClose() {
    var st = imgState()
    if (st && st.dirty && !window.confirm(t('workbench.img.discard_confirm'))) return
    WB.img = null
    render()
  }

  function imgSetAspect(key) {
    var st = imgState()
    if (!st || !st.crop || !(key in IMG_ASPECTS)) return
    st.aspect = key
    var rs = imgRotSize(st.W, st.H, st.rot)
    st.crop = imgAspectCrop(rs.w, rs.h, IMG_ASPECTS[key])
    st.outW = st.crop.w
    st.bg.seeds = []
    st.dirty = true
    render()
    imgRefresh(false)
  }

  function imgRotate(delta) {
    var st = imgState()
    if (!st || !st.crop) return
    st.rot = (st.rot + delta + 360) % 360
    imgResetGeometry(st)
    st.dirty = true
    render()
    imgRefresh(true)
  }

  /** Egy mezo az allapotba. Az ujrarajzolast csak a szam-mezok kerik (a keret
   *  helye valtozik); a szoveges mezo alatt csak az elonezet frissul. */
  function imgField(id, el) {
    var st = imgState()
    if (!st || !st.crop) return false
    var v = el.value
    var rs = imgRotSize(st.W, st.H, st.rot)
    if (id === 'wbImgCx' || id === 'wbImgCy' || id === 'wbImgCw' || id === 'wbImgCh') {
      var n = Number(v)
      if (!Number.isFinite(n)) return true
      var c = { x: st.crop.x, y: st.crop.y, w: st.crop.w, h: st.crop.h }
      if (id === 'wbImgCx') c.x = n
      else if (id === 'wbImgCy') c.y = n
      else if (id === 'wbImgCw') c.w = n
      else c.h = n
      st.crop = imgClampCrop(c, rs.w, rs.h)
      st.aspect = 'free'
      st.outW = st.crop.w
      st.bg.seeds = []
      var box = document.querySelector && document.querySelector('[data-wb-crop="move"]')
      if (box && box.setAttribute) box.setAttribute('style', imgCropStyle(st))
    } else if (id === 'wbImgOutW') {
      var w = Number(v)
      if (Number.isFinite(w) && w > 0) st.outW = Math.min(IMG_MAX_SIDE, Math.round(w))
    } else if (id === 'wbImgCapText') st.caption.text = String(v || '')
    else if (id === 'wbImgCapPos') st.caption.pos = v
    else if (id === 'wbImgCapColor') st.caption.color = v
    else if (id === 'wbImgCapSize') st.caption.size = Math.max(2, Math.min(20, Number(v) || 6))
    else if (id === 'wbImgCapBand') st.caption.band = !!el.checked
    else if (id === 'wbImgTol') st.bg.tol = Math.max(0, Math.min(120, Number(v) || 0))
    else return false
    st.dirty = true
    imgRefresh(false)
    return true
  }

  function imgSave() {
    var st = imgState()
    if (!st || st.busy || !st.crop || !WB.selectedId) return
    var itemId = WB.selectedId
    var type = imgOutType(st)
    st.busy = true
    st.error = null
    render()
    var fail = function (msg) {
      var s2 = imgState()
      if (!s2) return
      s2.busy = false
      render()
      window.showToast(msg)
    }
    var cv
    try { cv = imgOutput(st, 0) } catch (e) { fail(t('workbench.img.render_failed', { message: (e && e.message) || '' })); return }
    cv.toBlob(function (blob) {
      if (!blob) { fail(t('workbench.img.render_failed', { message: '' })); return }
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/image-edit?base_version=' + encodeURIComponent(st.baseVersion || '')
        + '&lang=' + encodeURIComponent(window._lang || 'hu')
      fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || type }, body: blob }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (data) {
          if (!res.ok) { fail((data && data.message) || t('workbench.err.http', { status: res.status })); return }
          WB.img = null
          applyVersions(data)
          window.showToast(t('workbench.img.saved', { n: data && data.version ? data.version.version_no : '', name: (data && data.name) || '' }))
        })
      }).catch(function () { fail(t('workbench.err.network')) })
    }, type, type === 'image/png' ? undefined : 0.92)
  }

  // Vagokeret huzasa (eger + erintes). Huzas kozben csak a doboz stilusa
  // valtozik; elengedeskor kerul az allapotba, es akkor frissul az eredmeny.
  var imgDrag = null

  function imgDragApply(d, clientX, clientY) {
    var st = imgState()
    if (!st) return null
    var rs = imgRotSize(st.W, st.H, st.rot)
    var dx = (clientX - d.x0) * rs.w / (d.rect.width || 1)
    var dy = (clientY - d.y0) * rs.h / (d.rect.height || 1)
    var c = { x: d.crop.x, y: d.crop.y, w: d.crop.w, h: d.crop.h }
    var ratio = IMG_ASPECTS[st.aspect] || 0
    if (d.mode === 'move') { c.x += dx; c.y += dy; return imgClampCrop(c, rs.w, rs.h) }
    var right = c.x + c.w
    var bottom = c.y + c.h
    if (d.mode === 'nw' || d.mode === 'sw') c.x = Math.min(right - 8, Math.max(0, c.x + dx))
    if (d.mode === 'nw' || d.mode === 'ne') c.y = Math.min(bottom - 8, Math.max(0, c.y + dy))
    c.w = d.mode === 'ne' || d.mode === 'se' ? Math.max(8, Math.min(rs.w - c.x, c.w + dx)) : right - c.x
    c.h = d.mode === 'sw' || d.mode === 'se' ? Math.max(8, Math.min(rs.h - c.y, c.h + dy)) : bottom - c.y
    if (ratio) {
      c.h = c.w / ratio
      if (c.y + c.h > rs.h) { c.h = rs.h - c.y; c.w = c.h * ratio }
      if (d.mode === 'nw' || d.mode === 'ne') c.y = bottom - c.h
      if (d.mode === 'nw' || d.mode === 'sw') c.x = right - c.w
    }
    return imgClampCrop(c, rs.w, rs.h)
  }

  // ---- DIKTALAS ES FELOLVASAS (#406, 17. pont) --------------------------------
  //
  // A bongeszo SAJAT eszkozeivel, szerver-oldali fuggoseg nelkul:
  //  - diktalas: Web Speech API (Chrome, Edge, Safari -- telefonon is). Ahol
  //    nincs (pl. Firefox), azt KIMONDJUK, es a telefon billentyuzetenek
  //    mikrofonjat ajanljuk (az barmelyik mezoben mukodik).
  //  - felolvasas: speechSynthesis -- a gep / telefon sajat hangjai, halozat
  //    nelkul. Ha nincs magyar hang telepitve, azt is kimondjuk.

  function speechRecCtor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null }
  function speechLang() { return window._lang === 'en' ? 'en-US' : 'hu-HU' }

  function micButtonHtml(targetId) {
    var on = !!(WB.dict && WB.dict.target === targetId)
    return '<button type="button" class="btn-secondary wb-mic' + (on ? ' wb-mic-on' : '') + '" data-wb-act="dict" data-wb-dict="' + escA(targetId) + '"'
      + ' aria-pressed="' + on + '" title="' + escA(t('workbench.voice.mic_title')) + '">'
      + esc(on ? t('workbench.voice.mic_stop') : t('workbench.voice.mic')) + '</button>'
  }

  function dictValue(targetId) {
    var el = document.getElementById(targetId)
    if (el && typeof el.value === 'string') return el.value
    if (targetId === 'wbChatInput') return WB.chatDraft || ''
    if (targetId === 'wbTextEdit' && WB.textEdit) return WB.textEdit.value || ''
    if (targetId === 'wbPartText' && WB.partDraft) return WB.partDraft.value || ''
    return ''
  }

  function dictSetValue(targetId, v, caret) {
    var el = document.getElementById(targetId)
    if (el && 'value' in el) {
      el.value = v
      // Keep the caret right after the dictated text, so the next words (and the user's typing) continue there.
      if (typeof caret === 'number' && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(caret, caret) } catch (_e) { /* not a text field */ } }
    }
    if (targetId === 'wbChatInput') WB.chatDraft = v
    else if (targetId === 'wbTextEdit' && WB.textEdit) WB.textEdit.value = v
    else if (targetId === 'wbPartText' && WB.partEdit) WB.partDraft = { id: WB.partEdit, value: v }
    else if (targetId === 'wbPartNewText') WB.partNewDraft = v
  }

  function dictJoin(base, parts) {
    var said = parts.filter(function (s) { return s && s.trim() }).map(function (s) { return s.trim() }).join(' ')
    if (!said) return base
    return base + (base && !/\s$/.test(base) ? ' ' : '') + said
  }

  /** The dictated words go AT THE CURSOR: d.before is the text left of it, d.after the text right of it
   *  (the selection, if any, is replaced). Returns the whole new value and where the caret belongs. */
  function dictCompose(d, parts) {
    var head = dictJoin(d.before, parts)
    var said = head !== d.before
    var tail = d.after
    if (said && tail && !/^\s/.test(tail)) tail = ' ' + tail
    return { value: head + tail, caret: head.length }
  }
  window._wbDictCompose = dictCompose

  function dictApply(d, parts) {
    var c = dictCompose(d, parts)
    dictSetValue(d.target, c.value, c.caret)
    // The editor's own input handler keeps the draft and the live markdown preview in step.
    var el = document.getElementById(d.target)
    if (el && typeof el.dispatchEvent === 'function' && typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  var DICT_ERRORS = { 'not-allowed': 'denied', 'service-not-allowed': 'denied', 'no-speech': 'no_speech', 'audio-capture': 'no_mic', network: 'network', 'language-not-supported': 'lang' }

  function dictStop() {
    var d = WB.dict
    WB.dict = null
    // The browser still delivers the last words after stop(); onresult must accept them (d.stopping).
    if (d) d.stopping = true
    if (d && d.rec) { try { d.rec.stop() } catch (_e) { /* mar all */ } }
    render()
  }

  function dictToggle(targetId) {
    if (WB.dict) {
      var same = WB.dict.target === targetId
      dictStop()
      if (same) return
    }
    var SR = speechRecCtor()
    if (!SR) { window.showToast(t('workbench.voice.no_dictation')); return }
    var rec
    try { rec = new SR() } catch (_e) { window.showToast(t('workbench.voice.no_dictation')); return }
    rec.lang = speechLang()
    rec.interimResults = true
    rec.continuous = true
    var cur = dictValue(targetId)
    var field = document.getElementById(targetId)
    var selA = field && typeof field.selectionStart === 'number' ? field.selectionStart : cur.length
    var selB = field && typeof field.selectionEnd === 'number' ? field.selectionEnd : selA
    var d = { target: targetId, rec: rec, before: cur.slice(0, selA), after: cur.slice(selB), finals: [], interim: '', error: null, stopping: false }
    rec.onresult = function (ev) {
      if (WB.dict !== d && !(d.stopping && !WB.dict)) return
      var interim = ''
      for (var i = ev.resultIndex || 0; i < ev.results.length; i++) {
        var r = ev.results[i]
        var tx = r && r[0] ? String(r[0].transcript || '') : ''
        if (r.isFinal) d.finals.push(tx)
        else interim += tx
      }
      d.interim = interim
      dictApply(d, d.finals.concat([interim]))
    }
    rec.onerror = function (ev) { d.error = ev && ev.error ? String(ev.error) : 'other' }
    rec.onend = function () {
      // The final text stays (the half-heard part does not); stop() still delivers the last final words, accepted above.
      dictApply(d, d.finals)
      if (WB.dict === d) { WB.dict = null; render() }
      if (d.error && d.error !== 'aborted') {
        var k = DICT_ERRORS[d.error] || 'other'
        window.showToast(t('workbench.voice.err_' + k, { code: d.error }))
      }
    }
    WB.dict = d
    try { rec.start() } catch (e) {
      WB.dict = null
      window.showToast(t('workbench.voice.err_other', { code: (e && e.message) || '' }))
      return
    }
    render()
    var el = document.getElementById(targetId)
    if (el && typeof el.focus === 'function') el.focus()
  }

  // ---- ketnyelvu fordito + felolvasas a szerkesztoben es az olvasoban (#467, Boss TG 7607/7619) --------
  //
  // Bal oszlop: a forras (szerkesztheto), nyelvvalasztoval. Jobb oszlop: KULON kapcsolo "Vegeredmeny" /
  // "Fordites": a formazott vegeredmeny megmarad, a fordites sajat modban jon elo a valasztott nyelven.
  // A fordito az e-mail fordito motorja (POST /api/workbench/translate -> translateEmailContent): a
  // nyelvlista es a nevek is onnan jonnek (app.js), nem masoljuk le.

  var TR_FALLBACK_CODES = ['en', 'de', 'hu', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ro', 'ru', 'uk', 'tr', 'ar', 'zh', 'ja']
  var TR_SPEECH = { hu: 'hu-HU', en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', pl: 'pl-PL', ro: 'ro-RO', ru: 'ru-RU', uk: 'uk-UA', tr: 'tr-TR', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP' }
  function trCodes() { return (typeof EMAIL_TRANSLATE_CODES !== 'undefined' && EMAIL_TRANSLATE_CODES) || TR_FALLBACK_CODES }
  function trLangName(code) {
    if (code === 'auto') return t('workbench.tr.auto')
    return typeof emailLangName === 'function' ? emailLangName(code) : String(code).toUpperCase()
  }
  function trOtherLang() { return window._lang === 'en' ? 'hu' : 'en' }
  WB.tr = { src: readPref('wb.tr.src', 'auto'), dst: readPref('wb.tr.dst', trOtherLang()), mode: 'final', result: null, forText: null, forSrc: null, forDst: null, detected: null, busy: false, error: null }

  function trCurrentText() {
    if (WB.textEdit && WB.textEdit.itemId === WB.selectedId) return WB.textEdit.value || ''
    return (WB.preview && WB.preview.text) || ''
  }
  function trFresh() {
    var tr = WB.tr
    return tr.result != null && tr.forText === trCurrentText() && tr.forSrc === tr.src && tr.forDst === tr.dst
  }
  /** The language the text on the left is in: the picked one, else what the translator detected, else the dashboard's. */
  function trLeftLang() {
    if (WB.tr.src !== 'auto') return WB.tr.src
    return WB.tr.detected || (window._lang === 'en' ? 'en' : 'hu')
  }
  function ttsLangFor(key) {
    var code = key === 'tr-left' ? trLeftLang()
      : key === 'tr-right' ? (WB.tr.mode === 'translation' ? WB.tr.dst : trLeftLang())
      : key === 'tr-read' ? WB.tr.dst : ''
    return TR_SPEECH[code] || speechLang()
  }
  function trSelectHtml(id, kind, value, withAuto) {
    var opts = (withAuto ? ['auto'] : []).concat(trCodes())
    return '<select class="btn-secondary btn-compact wb-tr-lang" id="' + id + '" data-wb-tr="' + kind + '" title="' + escA(t(kind === 'src' ? 'workbench.tr.src_title' : 'workbench.tr.dst_title')) + '">'
      + opts.map(function (c) { return '<option value="' + escA(c) + '"' + (c === value ? ' selected' : '') + '>' + esc(trLangName(c)) + '</option>' }).join('') + '</select>'
  }
  function trLeftControlsHtml() {
    return '<span class="wb-tr-ctl">' + trSelectHtml('wbTrSrc', 'src', WB.tr.src, true) + ttsButtonHtml('tr-left') + '</span>'
  }
  /** `edit`: the editor's right column (adds the swap button); the reader gets the same switch without it. */
  function trRightControlsHtml(edit) {
    var tr = WB.tr
    function mbtn(m, label) {
      return '<button type="button" class="btn-secondary btn-compact wb-tr-mode' + (tr.mode === m ? ' wb-tr-mode-on' : '') + '" data-wb-act="tr-mode" data-wb-mode="' + m + '" aria-pressed="' + (tr.mode === m) + '">' + esc(label) + '</button>'
    }
    return '<span class="wb-tr-ctl">' + mbtn('final', t(edit ? 'workbench.tr.final' : 'workbench.tr.original')) + mbtn('translation', t('workbench.tr.translation'))
      + trSelectHtml('wbTrDst', 'dst', tr.dst, false)
      + (tr.mode === 'translation' ? '<button type="button" class="btn-secondary btn-compact" data-wb-act="tr-run"' + (tr.busy ? ' disabled' : '') + '>' + esc(tr.busy ? t('workbench.tr.working') : t(trFresh() ? 'workbench.tr.again' : 'workbench.tr.run')) + '</button>' : '')
      + (edit && tr.mode === 'translation' ? '<button type="button" class="btn-secondary btn-compact" data-wb-act="tr-swap" title="' + escA(t('workbench.tr.swap_hint')) + '">&#8646;</button>' : '')
      + (tr.mode === 'translation' ? (tr.result ? ttsButtonHtml(edit ? 'tr-right' : 'tr-read') : '') : (edit && trCurrentText() ? ttsButtonHtml('tr-right') : ''))
      + '</span>'
  }
  /** The translated text (or why there is none yet), as the right column / reader shows it. */
  function trResultHtml(md) {
    var tr = WB.tr
    if (tr.busy) return '<p class="wb-muted wb-tr-note" id="wbTrOut">' + esc(t('workbench.tr.working')) + '</p>'
    if (tr.error) return '<div class="info-box depo-bad wb-tr-note" id="wbTrOut">' + esc(tr.error) + '</div>'
    if (tr.result == null) return '<p class="wb-muted wb-tr-note" id="wbTrOut">' + esc(t('workbench.tr.press_run', { lang: trLangName(tr.dst) })) + '</p>'
    return '<div id="wbTrOut">' + (trFresh() ? '' : '<p class="wb-hint wb-tr-stale">' + esc(t('workbench.tr.stale')) + '</p>')
      + (md ? mdLiveHtml(tr.result) : '<pre class="wb-preview-text">' + esc(tr.result) + '</pre>') + '</div>'
  }
  function trRightBodyHtml(value) {
    if (WB.tr.mode === 'translation') return '<div id="wbTextEditLive" class="wb-tr-out">' + trResultHtml(true) + '</div>'
    return '<div id="wbTextEditLive">' + mdLiveHtml(value) + '</div>'
  }
  function trRun() {
    var tr = WB.tr
    var text = trCurrentText()
    if (tr.busy) return
    if (!String(text).trim()) { window.showToast(t('workbench.tr.empty')); return }
    var itemId = WB.selectedId
    tr.busy = true; tr.error = null
    render()
    api('POST', '/api/workbench/translate', { text: text, source_lang: tr.src, target_lang: tr.dst }).then(function (r) {
      tr.busy = false
      if (WB.selectedId !== itemId) return
      if (!r.ok) { tr.error = r.message; render(); return }
      tr.error = null
      tr.result = r.data.translation || ''
      tr.forText = text; tr.forSrc = tr.src; tr.forDst = tr.dst
      if (r.data.source_lang && r.data.source_lang !== 'unknown') tr.detected = r.data.source_lang
      render()
    })
  }
  function trSetMode(mode) {
    WB.tr.mode = mode === 'translation' ? 'translation' : 'final'
    if (WB.tr.mode === 'translation' && !trFresh() && !WB.tr.busy && String(trCurrentText()).trim()) { trRun(); return }
    render()
  }
  function trSetLang(kind, value) {
    WB.tr[kind] = value
    writePref('wb.tr.' + kind, value)
    if (kind === 'src') WB.tr.detected = null
    if (WB.tr.mode === 'translation' && !WB.tr.busy && String(trCurrentText()).trim()) { trRun(); return }
    render()
  }
  /** Back-and-forth: the translation becomes the editable source, the languages swap, the old text is now the "translation". */
  function trSwap() {
    var tr = WB.tr
    if (!WB.textEdit || !trFresh()) { window.showToast(t('workbench.tr.swap_need')); return }
    var oldText = WB.textEdit.value
    var oldLeft = trLeftLang()
    WB.textEdit.value = tr.result
    tr.src = tr.dst; tr.dst = oldLeft
    writePref('wb.tr.src', tr.src); writePref('wb.tr.dst', tr.dst)
    tr.detected = null
    tr.result = oldText; tr.forText = WB.textEdit.value; tr.forSrc = tr.src; tr.forDst = tr.dst
    render()
  }
  /** Typing in the source makes a shown translation "old" without a full redraw (the textarea keeps its caret). */
  function trMarkStale() {
    if (WB.tr.mode !== 'translation' || WB.tr.result == null || typeof document.getElementById !== 'function') return
    var out = document.getElementById('wbTrOut')
    if (!out || trFresh() || (out.querySelector && out.querySelector('.wb-tr-stale'))) return
    if (out.insertAdjacentHTML) out.insertAdjacentHTML('afterbegin', '<p class="wb-hint wb-tr-stale">' + esc(t('workbench.tr.stale')) + '</p>')
  }

  function ttsSupported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance) }

  function ttsButtonHtml(key) {
    if (!ttsSupported()) return ''
    var on = WB.speaking === key
    return '<button type="button" class="wb-part-btn wb-tts' + (on ? ' wb-tts-on' : '') + '" data-wb-act="tts" data-wb-tts="' + escA(key) + '" aria-pressed="' + on + '">'
      + esc(on ? t('workbench.voice.tts_stop') : t('workbench.voice.tts')) + '</button>'
  }

  function ttsTextFor(key) {
    var k = String(key || '')
    if (k === 'tr-left') return trCurrentText()
    if (k === 'tr-right') return WB.tr.mode === 'translation' && WB.tr.result ? WB.tr.result : trCurrentText()
    if (k === 'tr-read') return WB.tr.result || ''
    if (k === 'preview') return (WB.preview && WB.preview.text) || ''
    if (k.indexOf('turn:') === 0) {
      var turn = chatState().turns[Number(k.slice(5))]
      return turn ? turn.text || '' : ''
    }
    if (k.indexOf('part:') === 0) {
      var id = k.slice(5)
      var part = partsOf().filter(function (p) { return p.id === id })[0]
      return part ? (part.kind === 'text' ? part.text : part.caption) || '' : ''
    }
    return ''
  }

  /** Felolvasasra: jelolo-karakterek nelkul, rovid darabokban (a Chrome a
   *  hosszu mondatot ~15 mp utan csendben elvagja). */
  function ttsChunks(text) {
    var clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    var sentences = clean.split(/(?<=[.!?…:;])\s+|\n+/)
    var out = []
    var cur = ''
    sentences.forEach(function (s) {
      s = s.replace(/\s+/g, ' ').trim()
      if (!s) return
      while (s.length > 220) { var cut = s.lastIndexOf(' ', 220); if (cut < 80) cut = 220; if (cur) { out.push(cur); cur = '' } out.push(s.slice(0, cut)); s = s.slice(cut).trim() }
      if (cur && (cur + ' ' + s).length > 220) { out.push(cur); cur = s } else cur = cur ? cur + ' ' + s : s
    })
    if (cur) out.push(cur)
    return out
  }

  function ttsStop() {
    WB.speaking = null
    if (ttsSupported()) { try { window.speechSynthesis.cancel() } catch (_e) { /* nem baj */ } }
  }

  function ttsToggle(key) {
    if (!ttsSupported()) { window.showToast(t('workbench.voice.no_tts')); return }
    var same = WB.speaking === key
    ttsStop()
    if (same) { render(); return }
    var chunks = ttsChunks(ttsTextFor(key))
    if (!chunks.length) { window.showToast(t('workbench.voice.tts_empty')); render(); return }
    var lang = ttsLangFor(key)
    var voices = []
    try { voices = window.speechSynthesis.getVoices() || [] } catch (_e) { voices = [] }
    var prefix = lang.slice(0, 2).toLowerCase()
    var voice = voices.filter(function (v) { return String(v.lang || '').toLowerCase().indexOf(prefix) === 0 })[0] || null
    // Ha a bongeszo MAR felsorolta a hangjait, es nincs koztuk ilyen nyelvu,
    // azt kimondjuk -- kulonben egy angol hang olvasna fel magyar szoveget.
    if (!voice && voices.length) window.showToast(t('workbench.voice.no_voice'))
    WB.speaking = key
    chunks.forEach(function (c, i) {
      var u = new window.SpeechSynthesisUtterance(c)
      u.lang = lang
      if (voice) u.voice = voice
      if (i === chunks.length - 1) {
        u.onend = function () { if (WB.speaking === key) { WB.speaking = null; render() } }
      }
      u.onerror = function (ev) {
        if (WB.speaking !== key) return
        WB.speaking = null
        render()
        var code = ev && ev.error ? String(ev.error) : ''
        if (code && code !== 'canceled' && code !== 'interrupted') window.showToast(t('workbench.voice.tts_failed', { code: code }))
      }
      window.speechSynthesis.speak(u)
    })
    render()
  }

  function previewHtml() {
    var p = WB.preview
    if (!p) return '<div class="wb-preview"><p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    // A sajat reszeit (szoveg + kep) a reszlista mutatja: nem duplazzuk meg.
    if (p.available && p.kind === 'parts') return ''
    // The timeline file is data: the timeline editor below shows it.
    if (p.available && p.kind === 'timeline') return ''
    // The deck file is data: the slide editor below shows it.
    if (p.available && p.kind === 'deck') return ''
    var head = '<div class="wb-preview-head"><h4>' + esc(t('workbench.preview.title')) + '</h4>'
      + (p.name ? '<span class="wb-muted">' + esc(p.name) + '</span>' : '')
      + previewVersionPickerHtml() + '</div>'
    // TABLAZAT (#406, 15. pont): nyitva a racs -> az van a helyen.
    if (tableOpen()) return '<div class="wb-preview">' + head + tableHtml() + '</div>'
    // DOKUMENTUM-SZERKESZTES (#444): nyitva a szerkeszto -> az van a helyen.
    if (docEditOpen()) return '<div class="wb-preview">' + head + docEditHtml() + '</div>'
    if (pdfEditOpen()) return '<div class="wb-preview">' + head + pdfEditHtml() + '</div>'
    var tableBtn = tableButtonHtml(p)
    if (!p.available && p.reason === 'needs_conversion') {
      // NEM HIBA, hanem TEENDO: ebbol a dokumentumbol tudunk elonezetet
      // csinalni. A gomb mellett ott a letoltes is -- ha a gepen nincs meg a
      // LibreOffice, a felhasznalo attol meg hozzafer a sajat fajljahoz.
      return '<div class="wb-preview">' + head + tableBtn + docButtonsHtml(p)
        + '<p class="wb-muted">' + esc(p.message || t('workbench.preview.none')) + '</p>'
        + '<p><button type="button" class="btn-primary" data-wb-act="preview-convert"' + (WB.convertBusy ? ' disabled' : '') + '>'
        + esc(WB.convertBusy ? t('workbench.preview.converting') : t('workbench.preview.convert')) + '</button></p>'
        + (WB.convertError
          ? '<p class="wb-preview-bad">' + esc(WB.convertError.message || '') + '</p>'
            + (WB.convertError.detail ? '<p class="wb-hint">' + esc(WB.convertError.detail) + '</p>' : '')
            + '<p><button type="button" class="wb-btn" data-wb-act="preview-convert-retry"' + (WB.convertBusy ? ' disabled' : '') + '>'
            + esc(t('workbench.preview.convert_retry')) + '</button></p>'
          : '')
        + (p.rel
          ? '<p class="wb-hint"><a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.download')) + '</a></p>'
          : '')
        + '</div>'
    }
    if (!p.available) {
      // A "nem latok oda" fajtak hangosak, a "meg nincs semmi" baratsagos.
      var loud = p.reason && p.reason !== 'no_source' && p.reason !== 'unsupported'
      return '<div class="wb-preview">' + head
        + '<p class="' + (loud ? 'wb-preview-bad' : 'wb-muted') + '">' + esc(p.message || t('workbench.preview.none')) + '</p>'
        + (p.reason === 'unsupported' && p.rel
          ? '<p class="wb-hint"><a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.download')) + '</a></p>'
          : '')
        + (p.detail ? '<p class="wb-hint">' + esc(p.detail) + '</p>' : '')
        + '</div>'
    }
    return '<div class="wb-preview">' + head + tableBtn + previewBodyHtml(p) + '</div>'
  }


  // ---- PDF-NEZEGETO (kartya f7d423e7) ---------------------------------------
  //
  // MIERT NEM A BONGESZO SAJAT NEZEGETOJE (a korabbi `<iframe>`): minden
  // bongeszo mast mutat -- mas eszkozsav, mas gorgetes, van, amelyik le se
  // rajzolja, csak letoltest ajanl. A tulajdonos EGYSEGES nezetet kert, ezert a
  // lapokat mi magunk rajzoljuk ki a pdf.js-sel.
  //
  // MIERT NEM CDN-ROL: a pdf.js a SAJAT kiszolgalonkrol jon (`/vendor/pdfjs/`,
  // a `pdfjs-dist` csomagbol), igy egy frissen telepitett, halozat nelkuli
  // gepen is mukodik. Ha a csomag nincs fent, azt KIMONDJUK a potlo paranccsal
  // egyutt -- a szerver 404-enek a TORZSEBOL olvassuk ki az okot, nem
  // talalgatunk.
  //
  // MIERT KULON DOM-CSOMOPONT: a `render()` az egesz felulet innerHTML-jet
  // ujraepiti (egy gepelés a chatben is ujrarajzol). Ha a kirajzolt lapok abban
  // ulnenek, minden billentyuleutesnel ujra kellene rajzolni oket. Ezert a
  // nezegeto sajat, TARTOS csomopontban el, amit a render() utan egyszeruen
  // visszateszunk a helyere.

  /** A nezegeto HELYE a felulet HTML-jeben. Ures marad: a tartalmat a
   *  render() utan futo `pdfMount()` teszi bele, mert a kirajzolt lapoknak
   *  TUL kell elniuk az ujrarajzolast. */
  function pdfSlotHtml(url) {
    return '<div class="wb-pdf-slot" data-wb-pdf="' + escA(url) + '"></div>'
  }

  var PDFJS_LIB_URL = '/vendor/pdfjs/build/pdf.min.mjs'
  var PDFJS_WORKER_URL = '/vendor/pdfjs/build/pdf.worker.min.mjs'
  var PDFJS_VENDOR_BASE = '/vendor/pdfjs/'
  /** Nagyitas-fokozatok. A "lapszelesseg" (fit) kulon allapot, nem fokozat. */
  var PDF_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  /** Ennel tobb lapot nem rajzolunk ki egyszerre elore, ha nincs
   *  IntersectionObserver: egy 900 oldalas PDF kulonben megfogna a bongeszot. */
  var PDF_EAGER_PAGES = 5

  /** Van-e annyi DOM, amennyi a nezegetohoz kell. A teszt-kornyezet (es egy
   *  nagyon regi bongeszo) keveset ad: ott a nezegeto NEM indul el, es a
   *  felulet tobbi resze valtozatlanul mukodik. */
  function pdfDomOk() {
    return !!(typeof document !== 'undefined' && document.createElement && document.querySelector)
  }

  /** A pdf.js konyvtar betoltese -- egyszer, keresre. Amig nem nezel PDF-et,
   *  egyetlen bajt sem toltodik le belole. */
  function pdfLoadLib() {
    if (WB.pdfLib) return Promise.resolve(WB.pdfLib)
    if (WB.pdfLibPromise) return WB.pdfLibPromise
    WB.pdfLibPromise = import(PDFJS_LIB_URL).then(function (mod) {
      var lib = (mod && mod.getDocument) ? mod : (mod && mod.default) || mod
      if (!lib || !lib.getDocument) throw new Error('pdfjs_shape')
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
      WB.pdfLib = lib
      return lib
    }).catch(function (err) {
      // A kovetkezo probalkozas induljon tisztan.
      WB.pdfLibPromise = null
      // NEM TALALGATUNK: megkerdezzuk magat a forrast, mi a baj.
      return pdfWhyLibFailed().then(function (why) { throw why })
    })
    return WB.pdfLibPromise
  }

  /** A betoltes-hiba VALODI oka. A kiszolgalo 404-e JSON-t ad, benne az ember
   *  altal olvashato mondattal (nincs telepitve a csomag -> potlo parancs). Ha
   *  ezt sem erjuk el, azt mondjuk ki, hogy nem tudjuk -- nem gyartunk okot. */
  function pdfWhyLibFailed() {
    var url = PDFJS_LIB_URL + '?lang=' + encodeURIComponent(window._lang || 'hu')
    return fetch(url).then(function (res) {
      if (res.status === 404) {
        return res.json().then(function (body) {
          return {
            message: (body && body.message) || t('workbench.pdf.failed'),
            detail: (body && body.detail) || '',
          }
        }).catch(function () {
          return { message: t('workbench.pdf.failed'), detail: '' }
        })
      }
      return { message: t('workbench.pdf.failed'), detail: t('workbench.pdf.failed_http', { status: res.status }) }
    }).catch(function () {
      return { message: t('workbench.pdf.failed'), detail: t('workbench.pdf.failed_offline') }
    })
  }

  function pdfState() {
    if (!WB.pdf) {
      WB.pdf = {
        url: null, host: null, pagesEl: null, doc: null, pages: 0,
        zoom: 1, fit: true, error: null, detail: null, loading: false, seq: 0,
        rendered: null, observer: null, current: 1,
      }
    }
    return WB.pdf
  }

  /** Mindent elenged, ami az elozo dokumentumhoz tartozott. */
  function pdfReset() {
    var s = pdfState()
    s.seq += 1
    if (s.observer && s.observer.disconnect) { try { s.observer.disconnect() } catch (e) {} }
    if (s.doc && s.doc.destroy) { try { s.doc.destroy() } catch (e) {} }
    s.url = null; s.host = null; s.pagesEl = null; s.doc = null; s.pages = 0
    s.error = null; s.detail = null; s.loading = false; s.rendered = null
    s.observer = null; s.current = 1
  }

  /** A `render()` utan: a helyorzobe visszatesszuk a tartos nezegetot, vagy
   *  (uj dokumentumnal) elindítjuk a betoltest. */
  function pdfMount() {
    if (!pdfDomOk()) return
    var slot = document.querySelector('[data-wb-pdf]')
    if (!slot) {
      // Nincs PDF a kepernyon: a memoriat sem tartjuk feleslegesen.
      if (WB.pdf && WB.pdf.url) pdfReset()
      return
    }
    var url = slot.getAttribute('data-wb-pdf')
    var s = pdfState()
    if (s.url !== url) { pdfReset(); s = pdfState(); s.url = url; pdfBuildHost(); pdfOpen(url) }
    if (s.host && s.host.parentNode !== slot) slot.appendChild(s.host)
  }

  /** A tartos csomopont: eszkozsav + lapok. Egyszer epul fel, utana csak a
   *  tartalma valtozik -- ezert nem vesznek el a mar kirajzolt lapok. */
  function pdfBuildHost() {
    var s = pdfState()
    var host = document.createElement('div')
    host.className = 'wb-pdf'
    var bar = document.createElement('div')
    bar.className = 'wb-pdf-bar'
    bar.innerHTML = '<button type="button" class="wb-pdf-btn" data-pdf="prev" title="' + escA(t('workbench.pdf.prev')) + '">&#8249;</button>'
      + '<span class="wb-pdf-pos" data-pdf-pos></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="next" title="' + escA(t('workbench.pdf.next')) + '">&#8250;</button>'
      + '<span class="wb-pdf-sep"></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="out" title="' + escA(t('workbench.pdf.zoom_out')) + '">&minus;</button>'
      + '<span class="wb-pdf-zoom" data-pdf-zoom></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="in" title="' + escA(t('workbench.pdf.zoom_in')) + '">+</button>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="fit">' + esc(t('workbench.pdf.fit_width')) + '</button>'
    var pages = document.createElement('div')
    pages.className = 'wb-pdf-pages'
    host.appendChild(bar)
    host.appendChild(pages)
    // Sajat figyelo: a nagyitas NE rajzolja ujra az egesz Munkapadot.
    bar.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-pdf]') : null
      if (!btn) return
      pdfToolbarAction(btn.getAttribute('data-pdf'))
    })
    // A gorgetes mondja meg, hanyadik lapot latod eppen.
    pages.addEventListener('scroll', function () { pdfSyncPosition() })
    s.host = host
    s.pagesEl = pages
    s.barEl = bar
  }

  function pdfToolbarAction(what) {
    var s = pdfState()
    if (!s.doc) return
    if (what === 'prev') { pdfGoTo(s.current - 1); return }
    if (what === 'next') { pdfGoTo(s.current + 1); return }
    if (what === 'fit') { s.fit = true; pdfRelayout(); return }
    var i = PDF_ZOOMS.indexOf(s.zoom)
    if (i < 0) i = PDF_ZOOMS.indexOf(1)
    if (what === 'in') i = Math.min(PDF_ZOOMS.length - 1, i + 1)
    if (what === 'out') i = Math.max(0, i - 1)
    s.fit = false
    s.zoom = PDF_ZOOMS[i]
    pdfRelayout()
  }

  function pdfGoTo(n) {
    var s = pdfState()
    if (!s.pagesEl || n < 1 || n > s.pages) return
    var el = s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' })
    s.current = n
    pdfUpdateBar()
  }

  /** Melyik lap van a nezet tetejen. A gorgetesbol szamoljuk, nem tippelunk. */
  function pdfSyncPosition() {
    var s = pdfState()
    if (!s.pagesEl) return
    var kids = s.pagesEl.children
    var top = s.pagesEl.scrollTop
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight > top + 8) {
        var n = parseInt(kids[i].getAttribute('data-pdf-page'), 10)
        if (n && n !== s.current) { s.current = n; pdfUpdateBar() }
        return
      }
    }
  }

  function pdfUpdateBar() {
    var s = pdfState()
    if (!s.barEl) return
    var pos = s.barEl.querySelector('[data-pdf-pos]')
    var zoom = s.barEl.querySelector('[data-pdf-zoom]')
    if (pos) pos.textContent = s.pages ? t('workbench.pdf.page_of', { n: s.current, total: s.pages }) : ''
    if (zoom) zoom.textContent = s.fit ? t('workbench.pdf.fit_short') : Math.round(s.zoom * 100) + '%'
  }

  /** A dokumentum megnyitasa. Hiba eseten a nezegeto helyen EMBERI mondat all,
   *  es ott a letoltes-ut is: a fajljahoz a felhasznalo akkor is hozzafer. */
  function pdfOpen(url) {
    var s = pdfState()
    var mySeq = s.seq
    s.loading = true
    pdfShowMessage(t('workbench.pdf.loading'), '')
    pdfLoadLib().then(function (lib) {
      if (s.seq !== mySeq) return null
      return lib.getDocument({
        url: url,
        // A pdf.js ezekbol tolti be a karakterkeszlet-terkepeket, a beepitett
        // betutipusokat es a kep-dekodereket. Enelkul a keleti szoveg es a
        // be nem agyazott betutipus helyen ures folt lenne.
        cMapUrl: PDFJS_VENDOR_BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_VENDOR_BASE + 'standard_fonts/',
        wasmUrl: PDFJS_VENDOR_BASE + 'wasm/',
        iccUrl: PDFJS_VENDOR_BASE + 'iccs/',
      }).promise
    }).then(function (doc) {
      if (!doc || s.seq !== mySeq) return
      s.doc = doc
      s.pages = doc.numPages
      s.loading = false
      s.error = null
      pdfBuildPages()
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      s.loading = false
      s.error = (err && err.message) || t('workbench.pdf.failed')
      s.detail = (err && err.detail) || ''
      pdfShowMessage(s.error, s.detail)
    })
  }

  function pdfShowMessage(message, detail) {
    var s = pdfState()
    if (!s.pagesEl) return
    s.pagesEl.innerHTML = '<p class="wb-pdf-msg">' + esc(message) + '</p>'
      + (detail ? '<p class="wb-pdf-detail">' + esc(detail) + '</p>' : '')
    pdfUpdateBar()
  }

  /** Lap-helyek letrehozasa a VALODI meretekkel, majd a lathato lapok
   *  kirajzolasa. A helyorzo azert kap pontos meretet, hogy a gorgeto ne
   *  ugraljon, amikor egy lap elkeszul. */
  function pdfBuildPages() {
    var s = pdfState()
    if (!s.doc || !s.pagesEl) return
    s.rendered = {}
    s.pagesEl.innerHTML = ''
    var mySeq = s.seq
    s.doc.getPage(1).then(function (page) {
      if (s.seq !== mySeq) return
      var base = page.getViewport({ scale: 1 })
      s.baseW = base.width
      s.baseH = base.height
      for (var n = 1; n <= s.pages; n++) {
        var d = document.createElement('div')
        d.className = 'wb-pdf-page'
        d.setAttribute('data-pdf-page', String(n))
        s.pagesEl.appendChild(d)
      }
      pdfRelayout()
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      pdfShowMessage(t('workbench.pdf.failed'), (err && err.message) || '')
    })
  }

  /** A megjelenitendo meretarany. "Lapszelesseg" eseten a panel szelessegehez
   *  igazodik -- ha a panel szelesseget meg nem tudjuk (0), akkor 1-es
   *  aranyt hasznalunk, es nem talalgatunk kepernyomeretet. */
  function pdfScale() {
    var s = pdfState()
    if (!s.fit) return s.zoom
    var w = s.pagesEl ? s.pagesEl.clientWidth : 0
    if (!w || !s.baseW) return 1
    return Math.max(0.2, (w - 24) / s.baseW)
  }

  /** Ujrameretezes: a mar kirajzolt lapokat eldobjuk, es a lathatokat ujra
   *  rajzoljuk. Igy a nagyitas eles marad, nem felnagyitott kep. */
  function pdfRelayout() {
    var s = pdfState()
    if (!s.pagesEl || !s.doc) return
    var scale = pdfScale()
    s.rendered = {}
    var kids = s.pagesEl.children
    for (var i = 0; i < kids.length; i++) {
      kids[i].innerHTML = ''
      kids[i].style.width = Math.round(s.baseW * scale) + 'px'
      kids[i].style.height = Math.round(s.baseH * scale) + 'px'
    }
    pdfObserve()
    pdfUpdateBar()
  }

  /** Csak azt rajzoljuk ki, ami lathato (vagy kozel van hozza). Ha a bongeszo
   *  nem tud IntersectionObservert, az elso par lap jon, es gorgetesre a tobbi
   *  -- nem marad ures a kepernyo. */
  function pdfObserve() {
    var s = pdfState()
    if (s.observer && s.observer.disconnect) { try { s.observer.disconnect() } catch (e) {} }
    s.observer = null
    var kids = s.pagesEl.children
    if (typeof IntersectionObserver === 'function') {
      s.observer = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) pdfDrawPage(parseInt(entries[i].target.getAttribute('data-pdf-page'), 10))
        }
      }, { root: s.pagesEl, rootMargin: '200px 0px' })
      for (var j = 0; j < kids.length; j++) s.observer.observe(kids[j])
      return
    }
    for (var k = 0; k < Math.min(kids.length, PDF_EAGER_PAGES); k++) pdfDrawPage(k + 1)
    s.pagesEl.addEventListener('scroll', pdfDrawNearby)
  }

  function pdfDrawNearby() {
    var s = pdfState()
    if (!s.pagesEl) return
    var kids = s.pagesEl.children
    var top = s.pagesEl.scrollTop
    var bottom = top + s.pagesEl.clientHeight + 400
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight >= top && kids[i].offsetTop <= bottom) {
        pdfDrawPage(parseInt(kids[i].getAttribute('data-pdf-page'), 10))
      }
    }
  }

  function pdfDrawPage(n) {
    var s = pdfState()
    if (!n || !s.doc || !s.rendered || s.rendered[n]) return
    s.rendered[n] = true
    var mySeq = s.seq
    var scale = pdfScale()
    s.doc.getPage(n).then(function (page) {
      if (s.seq !== mySeq) return
      var holder = s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
      if (!holder) return
      // A kepernyo sursege (retina) nelkul a szoveg elmosodna.
      var dpr = (window.devicePixelRatio || 1)
      var viewport = page.getViewport({ scale: scale * dpr })
      var canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      canvas.style.width = Math.round(viewport.width / dpr) + 'px'
      canvas.style.height = Math.round(viewport.height / dpr) + 'px'
      holder.innerHTML = ''
      holder.appendChild(canvas)
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      // EGY lap hibaja nem doli el az egesz dokumentumot: csak azt a lapot
      // jelezzuk, a tobbi marad olvashato.
      s.rendered[n] = false
      var holder = s.pagesEl && s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
      if (holder) holder.innerHTML = '<p class="wb-pdf-msg">' + esc(t('workbench.pdf.page_failed', { n: n })) + '</p>'
        + '<p class="wb-pdf-detail">' + esc((err && err.message) || '') + '</p>'
    })
  }


  // ---- rajzvaszon (9. fazis, spec 9) -----------------------------------------
  //
  // A rajz STRUKTURALT: elemekbol all, mindegyiknek STABIL azonositoja van.
  // Ezert nem "kepet festunk", hanem ELEMEKET allitunk -- es pontosan ugyanazt
  // a muveletkeszletet hasznalja a lenti gomb es az agent (`canvas.edit`).
  //
  // Miert nincs itt CDN-rol toltodo rajzolo konyvtar: a kepet a SZERVER
  // rajzolja ki (SVG), igy a Munkapad egy FRISSEN telepitett, halozat nelkuli
  // gepen is mukodik, es a letoltott kep pontosan az, amit a kepernyon latsz.
  // A vonszolasos (eger-huzos) szerkesztes kesobbi bovites lehet; a strukturalt
  // szerkesztes ettol fuggetlenul teljes.

  // A kep-URL vegere tett jelzo. Azert NEM eleg a `Date.now()`: ket mentes
  // eshet ugyanabba az ezredmasodpercbe, es akkor a bongeszo a REGI kepet
  // mutatna tovabb. A szamlalo mindig valtozik.
  var canvasStampSeq = 0
  function bumpCanvasStamp() {
    canvasStampSeq += 1
    WB.canvasStamp = String(Date.now()) + '-' + canvasStampSeq
  }

  /** Rajz-vaszon fajtak: ezeknel ajanljuk fel magatol a rajzolast. */
  function canvasKind(item) {
    return !!item && (item.type === 'graphic' || item.type === 'image')
  }

  function canvasSvgUrl(itemId, download) {
    if (deckMode() && deckCurrentSlide()) return deckSlideUrl(deckCurrentSlide().id)
    return '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas.svg'
      + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
      // A kep a vaszonnal egyutt valtozik: a bongeszo gyorsitotara kulonben a
      // mentes ELOTTI kepet mutatna tovabb.
      + '&v=' + encodeURIComponent(WB.canvasStamp || '0')
      + (download ? '&download=1' : '')
  }

  function loadCanvas(itemId) {
    // A slide deck keeps its drawings inside the deck file: the deck route loads them.
    if (isDeckItem()) return loadDeck(itemId)
    WB.canvasError = null
    return api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas').then(function (r) {
      if (WB.selectedId !== itemId) return
      if (!r.ok) {
        // A "nem latok oda" NEM ures rajz: kulon, hangos allapot, a rendszer
        // sajat uzenetevel egyutt.
        WB.canvas = null
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
      } else {
        WB.canvas = r.data
        bumpCanvasStamp()
        WB.brandCheck = null
        ensureBrand()
      }
      render()
    })
  }

  function canvasObjects() {
    return (WB.canvas && WB.canvas.canvas && WB.canvas.canvas.objects) || []
  }

  function canvasObject(id) {
    var list = canvasObjects()
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
    return null
  }

  /** Egy koteg muvelet elkuldese. UGYANAZ az ut, amit az agent hasznal. */
  function canvasOps(ops) {
    if (deckMode()) return deckSlideOps(ops)
    if (!WB.selectedId || WB.canvasBusy) return
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/ops', { ops: ops }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        // A hiba OKAT a szerver mondja meg (melyik elem, melyik mezo) -- nem
        // talaljuk ki helyette.
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
        render()
        return
      }
      WB.canvasError = null
      WB.canvasEdit = null
      canvasTake(r.data)
      // Az automatikus mentes nem ad buborekot minden mozdulatra: a "Mentve"
      // jelzes a vaszon fejeben all (K-2.2). Csak a rajz SZULETESET mondjuk ki.
      if (r.data.created) {
        window.showToast(r.data.renamed
          ? t('workbench.canvas.renamed', { name: r.data.name })
          : (r.data.message || t('workbench.canvas.saved')))
      }
      // A kozepso panel elonezete is a vaszonrol szol: ujra kell kerni -- de a
      // mostani kep a helyen marad, amig az uj meg nem jon (nincs villogas).
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  /** Egy szerver-valasz atvetele: a rajz, a munkapeldany allapota (K-2.2), a
   *  visszavonas (K-2.1) es a felbehagyott munkak. Ami a valaszban nincs, az a
   *  regi erteken marad -- nem talaljuk ki. */
  function canvasTake(d) {
    var old = WB.canvas || {}
    var ver = d.version || null
    WB.canvas = {
      canvas: d.canvas || old.canvas, exists: true,
      rel: d.rel || old.rel, name: d.name || old.name,
      version_id: ver ? ver.id : old.version_id,
      version_no: ver ? ver.version_no : old.version_no,
      current: true,
      draft: 'draft' in d ? d.draft : old.draft,
      history: 'history' in d ? d.history : old.history,
      orphans: 'orphans' in d ? d.orphans : old.orphans,
      platforms: 'platforms' in d ? d.platforms : old.platforms,
    }
    bumpCanvasStamp()
    WB.brandCheck = null
    ensureBrand()
    if (WB.detail && d.item) { WB.detail.item = d.item }
    if (WB.detail && d.versions) { WB.detail.versions = d.versions }
  }

  /** Visszavonas / ujra (K-2.1). A lepes lehet kezi vagy az agent egy egesz
   *  kerese -- a szerver tudja, mi tartozik egybe. */
  function canvasStep(dir) {
    if (deckMode()) return deckStep(dir)
    if (!WB.selectedId || WB.canvasBusy || archived()) return
    var h = WB.canvas && WB.canvas.history
    if (!h || !(dir === 'undo' ? h.can_undo : h.can_redo)) return
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/' + dir, {}).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        // Utkozes: a rajz kozben mashol valtozott. A mostani rajz erintetlen,
        // a szerver megmondja, melyik elem -- es a friss allapotot betoltjuk.
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        loadCanvas(WB.selectedId)
        return
      }
      WB.canvasEdit = null
      canvasTake(r.data)
      var step = r.data.step || {}
      window.showToast(t(dir === 'undo' ? 'workbench.canvas.undone' : 'workbench.canvas.redone', { what: canvasStepLabel(step) }))
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  /** A lepes emberi neve: a szerver gepi muveletneveket ad ("move,scale"). */
  function canvasStepLabel(step) {
    if (!step || !step.label) return ''
    var names = String(step.label).split(',').map(function (n) {
      var key = 'workbench.canvas.op_' + n
      var txt = t(key)
      return txt === key ? n : txt
    })
    var text = names.join(', ')
    return step.source === 'agent' ? t('workbench.canvas.by_agent', { what: text }) : text
  }

  /** "Verzio mentese" (K-2.3): nevvel, ha a tulajdonos ad nevet. */
  function canvasSaveVersion() {
    if (deckMode()) return deckSaveVersion()
    if (!WB.selectedId || WB.canvasBusy || archived()) return
    var label = typeof window.prompt === 'function' ? window.prompt(t('workbench.canvas.version_prompt'), '') : ''
    // Megse: nincs verzio. Az ures nev rendben van (nev nelkuli verzio).
    if (label === null) return
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/version', { label: label || '', reason: 'manual' }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      canvasTake(r.data)
      window.showToast(r.data.message || t('workbench.canvas.version_saved'))
      render()
    })
  }

  /** Felbehagyott munka (egy korabbi verziora epult munkapeldany): verzio
   *  legyen belole, vagy eldobjuk. Eldobas elott rakerdezunk -- az vegleges. */
  function canvasOrphan(base, restore) {
    if (!WB.selectedId || WB.canvasBusy || archived() || !base) return
    if (!restore && typeof window.confirm === 'function' && !window.confirm(t('workbench.canvas.orphan_discard_confirm'))) return
    WB.canvasBusy = true
    render()
    var url = '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/orphans/' + encodeURIComponent(base)
    api(restore ? 'POST' : 'DELETE', restore ? url + '/restore' : url, restore ? {} : undefined).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { window.showToast(r.message); loadCanvas(WB.selectedId); return }
      if (restore) {
        canvasTake(r.data)
        loadPreview(WB.selectedId, null, true)
      } else if (WB.canvas) {
        WB.canvas.orphans = r.data.orphans || []
      }
      window.showToast(r.data.message || '')
      render()
    })
  }

  /** A platformlista (K-2.8), ahogy a szerver adta: forrassal, ellenorzes napjaval. */
  function canvasPlatforms() {
    var pl = WB.canvas && WB.canvas.platforms
    return (pl && pl.platforms) || []
  }

  /** A mostani meretre illo platform (a biztonsagi zonaval rendelkezo elore:
   *  a Story es a TikTok merete ugyanaz). A merettel egyutt valtozik, ezert a
   *  bongeszo szamolja a lista alapjan, nem egy regi valaszbol veszi. */
  function canvasPlatformNow() {
    var doc = WB.canvas && WB.canvas.canvas
    if (!doc) return null
    var hit = null
    canvasPlatforms().forEach(function (p) {
      if (p.width === doc.width && p.height === doc.height && (!hit || (!hit.safe && p.safe))) hit = p
    })
    return hit
  }

  function platformLabel(p) {
    return (p.label && (window._lang === 'en' ? p.label.en : p.label.hu)) || p.id
  }

  /** Meret es platform (K-2.8, K-2.9): atmeretezes helyben (visszavonhato
   *  lepes), vagy valtozat uj verziokent. Minden meret mellett a forras. */
  function canvasPlatformHtml() {
    var list = canvasPlatforms()
    if (!list.length || archived() || (WB.canvas && WB.canvas.current === false)) return ''
    var now = canvasPlatformNow()
    var pick = WB.canvasPlatformPick || (now && now.id) || list[0].id
    var sel = null
    list.forEach(function (p) { if (p.id === pick) sel = p })
    if (!sel) sel = list[0]
    var busy = WB.canvasBusy ? ' disabled' : ''
    var info = ''
    if (sel.note) info += '<p class="wb-hint">' + esc(window._lang === 'en' ? sel.note.en : sel.note.hu) + '</p>'
    info += '<p class="wb-hint">' + esc(t('workbench.canvas.platform_source', { date: sel.checked })) + ' '
      + (sel.sources || []).map(function (src) {
        return '<a href="' + escA(src.url) + '" target="_blank" rel="noopener">' + esc(src.title) + '</a>'
      }).join(', ') + '</p>'
    if (sel.stale) info += '<p class="wb-preview-bad">' + esc(t('workbench.canvas.platform_stale', { date: sel.checked })) + '</p>'
    var fileErr = WB.canvas && WB.canvas.platforms && WB.canvas.platforms.file_error
    return '<div class="wb-can-platform">'
      + '<label class="wb-label" for="wbCanPlatform">' + esc(t('workbench.canvas.platform_label')) + '</label>'
      + '<select class="wb-input" id="wbCanPlatform">' + list.map(function (p) {
        return '<option value="' + escA(p.id) + '"' + (p.id === sel.id ? ' selected' : '') + '>'
          + esc(platformLabel(p) + ' · ' + p.width + ' × ' + p.height) + '</option>'
      }).join('') + '</select>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-resize" data-wb-arg="' + escA(sel.id) + '"' + busy + '>' + esc(t('workbench.canvas.platform_resize')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-variant" data-wb-arg="' + escA(sel.id) + '"' + busy + '>' + esc(t('workbench.canvas.platform_variant')) + '</button>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.platform_hint')) + '</p>'
      + info
      + (fileErr ? '<p class="wb-preview-bad">' + esc(t('workbench.canvas.platform_file_error', { detail: fileErr })) + '</p>' : '')
      + '</div>'
  }

  // ---- AI-kepszerkesztes (K-2.11 .. K-2.13) ---------------------------------

  /** A panel megnyitasa: elobb megkerdezzuk, elerheto-e (kulcs, erzekenyseg),
   *  es mennyibe kerul -- a futtatas gomb csak ezutan jelenik meg. */
  function canvasAiOpen(id) {
    if (!WB.selectedId || !id) return
    if (WB.canvasAi && WB.canvasAi.id === id) { WB.canvasAi = null; render(); return }
    WB.canvasAi = { id: id, info: null, busy: false, text: '' }
    render()
    var itemId = WB.selectedId
    api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas/ai-edit').then(function (r) {
      if (!WB.canvasAi || WB.canvasAi.id !== id || WB.selectedId !== itemId) return
      WB.canvasAi.info = r.ok ? r.data : { available: false, reason_message: r.message }
      render()
    })
  }

  function canvasAiRun() {
    var st = WB.canvasAi
    if (!st || st.busy || !WB.selectedId) return
    var el = document.getElementById('wbCanAiText')
    var text = String((el && el.value) || st.text || '').trim()
    st.text = text
    if (!text) { window.showToast(t('workbench.canvas.ai_need_text')); return }
    st.busy = true
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/ai-edit', { object_id: st.id, instruction: text, confirm_cost: true }).then(function (r) {
      WB.canvasBusy = false
      if (WB.canvasAi) WB.canvasAi.busy = false
      if (!r.ok) {
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        render()
        return
      }
      WB.canvasAi = null
      canvasTake(r.data)
      window.showToast(r.data.message || '')
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  function canvasAiHtml(o) {
    var st = WB.canvasAi
    var info = st.info
    if (!info) return '<div class="wb-can-ai"><p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    if (!info.available) {
      return '<div class="wb-can-ai"><p class="wb-hint">' + esc(info.reason_message || '') + '</p>'
        + (info.reason === 'ai_edit_not_configured' ? '<p><button type="button" class="wb-btn" data-wb-act="caps-open">' + esc(t('workbench.canvas.ai_setup')) + '</button></p>' : '')
        + '</div>'
    }
    var cost = info.estimate_usd == null ? t('workbench.canvas.ai_cost_unknown', { model: info.model })
      : t('workbench.canvas.ai_cost', { usd: '$' + Number(info.estimate_usd).toFixed(3), model: info.model })
    return '<div class="wb-can-ai">'
      + '<label class="wb-label" for="wbCanAiText">' + esc(t('workbench.canvas.ai_label')) + '</label>'
      + '<textarea class="wb-input" id="wbCanAiText" rows="2" maxlength="1000" placeholder="' + escA(t('workbench.canvas.ai_placeholder')) + '">' + esc(st.text || '') + '</textarea>'
      + '<p class="wb-hint">' + esc(cost) + ' <a href="' + escA((info.price_source && info.price_source.url) || '') + '" target="_blank" rel="noopener">' + esc(t('workbench.canvas.ai_price_source')) + '</a></p>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.ai_hint')) + '</p>'
      + '<div class="wb-form-actions">'
      + '<button type="button" class="btn-primary" data-wb-act="canvas-ai-run"' + (st.busy ? ' disabled' : '') + '>'
      + esc(st.busy ? t('workbench.canvas.ai_running') : t('workbench.canvas.ai_run', { usd: info.estimate_usd == null ? '?' : '$' + Number(info.estimate_usd).toFixed(3) })) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="canvas-ai-open" data-wb-obj="' + escA(o.id) + '">' + esc(t('common.cancel')) + '</button>'
      + '</div></div>'
  }

  /** K-2.13: jelzes a munkadarabnal, ha a rajzon AI-val keszult kep van -- es
   *  a letoltes AI-jelolessel (IPTC metaadat). A kotelezoseget nem minositjuk. */
  function canvasAiNoticeHtml() {
    var doc = WB.canvas && WB.canvas.canvas
    if (!doc) return ''
    var area = 0
    var any = false
    canvasObjects().forEach(function (o) {
      if (o.type !== 'image' || !o.ai) return
      any = true
      var w = Math.max(0, Math.min(doc.width, o.x + o.width) - Math.max(0, o.x))
      var h = Math.max(0, Math.min(doc.height, o.y + o.height) - Math.max(0, o.y))
      area += w * h
    })
    if (!any) return ''
    var big = area / (doc.width * doc.height) >= 0.25
    return '<div class="wb-can-ai-notice"><p class="wb-hint">' + esc(t(big ? 'workbench.canvas.ai_notice_big' : 'workbench.canvas.ai_notice_some')) + '</p>'
      + '<p class="wb-hint"><a href="' + escA(canvasSvgUrl(WB.selectedId, true) + '&ai_label=1') + '" target="_blank" rel="noopener">' + esc(t('workbench.canvas.ai_download_labeled')) + '</a></p></div>'
  }

  /** Valtozat mas platformra (K-2.9): uj verzio az uj meretben. */
  function canvasVariant(id) {
    if (!WB.selectedId || WB.canvasBusy || archived() || !id) return
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/variant', { platform: id }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      canvasTake(r.data)
      window.showToast(r.data.message || '')
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  /** A biztonsagi zona (K-2.10) a kep folott: a negy sav, amit a platform sajat
   *  gombjai, felirata eltakar. Csak jelzes -- a kepbe nem kerul bele. */
  function canvasSafeHtml() {
    var p = canvasPlatformNow()
    if (!p || !p.safe) return ''
    var z = p.safe
    var pc = function (v) { return (Math.round(v * 10000) / 100) + '%' }
    return '<span class="wb-can-safe" style="left:0;right:0;top:0;height:' + pc(z.top) + '"></span>'
      + '<span class="wb-can-safe" style="left:0;right:0;bottom:0;height:' + pc(z.bottom) + '"></span>'
      + '<span class="wb-can-safe" style="left:0;top:' + pc(z.top) + ';bottom:' + pc(z.bottom) + ';width:' + pc(z.left) + '"></span>'
      + '<span class="wb-can-safe" style="right:0;top:' + pc(z.top) + ';bottom:' + pc(z.bottom) + ';width:' + pc(z.right) + '"></span>'
  }

  /** A vaszon fejenek eszkozsora: visszavonas, ujra, mentes-allapot, verzio. */
  function canvasToolsHtml() {
    var c = WB.canvas
    if (!c || !c.exists || archived() || c.current === false) return ''
    var h = c.history || {}
    var busy = WB.canvasBusy
    var undoTitle = h.undo ? t('workbench.canvas.undo_what', { what: canvasStepLabel(h.undo) }) : t('workbench.canvas.undo_none')
    var redoTitle = h.redo ? t('workbench.canvas.redo_what', { what: canvasStepLabel(h.redo) }) : t('workbench.canvas.redo_none')
    var state = c.draft && c.draft.since_version
      ? t('workbench.canvas.state_unversioned', { when: when(c.draft.updated_at) })
      : t('workbench.canvas.state_clean')
    return '<div class="wb-can-tools">'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-undo"' + (busy || !h.can_undo ? ' disabled' : '')
      + ' title="' + escA(undoTitle + ' (Ctrl+Z)') + '" aria-label="' + escA(undoTitle) + '">↶ ' + esc(t('workbench.canvas.undo')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-redo"' + (busy || !h.can_redo ? ' disabled' : '')
      + ' title="' + escA(redoTitle + ' (Ctrl+Y)') + '" aria-label="' + escA(redoTitle) + '">↷ ' + esc(t('workbench.canvas.redo')) + '</button>'
      + '<span class="wb-can-state' + (c.draft && c.draft.since_version ? ' wb-can-state-dirty' : '') + '" aria-live="polite">'
      + esc(busy ? t('workbench.canvas.state_saving') : state) + '</span>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-version"' + (busy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.version_save')) + '</button>'
      + (deckMode() ? '' : '<button type="button" class="wb-btn" data-wb-act="canvas-brand-check" title="' + escA(t('workbench.brand.check_title')) + '">'
        + esc(t('workbench.brand.check')) + '</button>'
        + '<button type="button" class="wb-btn" data-wb-act="canvas-brand-tpl-save"' + (busy || WB.brandTplBusy ? ' disabled' : '')
        + ' title="' + escA(t('workbench.brand.tpl_save_title')) + '">' + esc(t('workbench.brand.tpl_save')) + '</button>')
      + '</div>'
      + (deckMode() ? '' : brandCheckHtml())
  }

  /** A felbehagyott munkak sava. Nem tunik el szo nelkul semmi: a tulajdonos
   *  dont, verzio legyen-e belole. */
  function canvasOrphansHtml() {
    var list = (WB.canvas && WB.canvas.orphans) || []
    if (!list.length || archived()) return ''
    return '<div class="wb-can-orphans">' + list.map(function (o) {
      var what = o.objects < 0
        ? t('workbench.canvas.orphan_unreadable')
        : t('workbench.canvas.orphan_line', { n: o.base_version_no == null ? '?' : o.base_version_no, when: when(o.updated_at), count: o.objects })
      return '<p class="wb-hint">' + esc(what) + ' '
        + (o.objects < 0 ? '' : '<button type="button" class="wb-mini-btn" data-wb-act="canvas-orphan-restore" data-wb-version="' + escA(o.base_version_id) + '"'
          + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.canvas.orphan_restore')) + '</button>')
        + '<button type="button" class="wb-mini-btn wb-mini-danger" data-wb-act="canvas-orphan-discard" data-wb-version="' + escA(o.base_version_id) + '"'
        + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.canvas.orphan_discard')) + '</button></p>'
    }).join('') + '</div>'
  }

  /** Az ures vaszon LETREHOZASA. Addig nincs fajl, amig a felhasznalo el nem
   *  kezdi -- es ez a gomb az, ami elkezdi. */
  function startCanvas() {
    if (!WB.selectedId || WB.canvasBusy) return
    WB.canvasBusy = true
    render()
    api('PUT', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas', {
      canvas: { width: 1080, height: 1080, background: '#ffffff', objects: [] },
      base_version: (WB.detail && WB.detail.item && WB.detail.item.current_version_id) || undefined,
    }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
        render()
        return
      }
      WB.canvasError = null
      canvasTake(r.data)
      loadPreview(WB.selectedId, null)
      render()
    })
  }

  function numField(id, fallback) {
    var el = document.getElementById(id)
    if (!el) return fallback
    var n = Number(el.value)
    return isFinite(n) ? n : fallback
  }

  function fieldValue(id, fallback) {
    var el = document.getElementById(id)
    return el ? el.value : fallback
  }

  function checked(id) {
    var el = document.getElementById(id)
    return !!(el && el.checked)
  }

  /** A szerkeszto urlap mentese: EGY `update` muvelet, ugyanaz, amit az agent
   *  kuldene. Igy a ket ut nem csuszhat szet. */
  function saveCanvasObject(id) {
    var o = canvasObject(id)
    if (!o) return
    var patch = {
      x: numField('wbCanX', o.x), y: numField('wbCanY', o.y),
      width: numField('wbCanW', o.width), height: numField('wbCanH', o.height),
      rotation: numField('wbCanRot', o.rotation || 0),
      opacity: Math.max(0, Math.min(100, numField('wbCanOpacity', Math.round((o.opacity == null ? 1 : o.opacity) * 100)))) / 100,
    }
    if (o.type === 'text') {
      patch.text = fieldValue('wbCanText', o.text)
      patch.font = fieldValue('wbCanFont', o.font)
      patch.fontSize = numField('wbCanFontSize', o.fontSize)
      patch.color = fieldValue('wbCanColor', o.color)
      patch.align = fieldValue('wbCanAlign', o.align)
      patch.bold = checked('wbCanBold')
      patch.italic = checked('wbCanItalic')
    } else if (o.type === 'rect') {
      patch.fill = fieldValue('wbCanFill', o.fill)
      patch.radius = numField('wbCanRadius', o.radius)
    } else if (o.type === 'ellipse' || o.type === 'line') {
      // A kitoltetlen kor korvonala csak akkor latszik, ha van vastagsaga.
      if (o.type === 'ellipse') patch.fill = fieldValue('wbCanFill', o.fill)
      patch.stroke = fieldValue('wbCanStroke', o.stroke)
      patch.strokeWidth = numField('wbCanStrokeWidth', o.strokeWidth)
    } else {
      patch.fit = fieldValue('wbCanFit', o.fit)
      patch.alt = fieldValue('wbCanAlt', o.alt)
    }
    canvasOps([{ op: 'update', id: id, patch: patch }])
  }

  /** A munkadarab MAR feltoltott kepei -- ezekbol lehet valasztani a vaszonra.
   *  Ha meg nincs egy sem, azt KIMONDJUK, es megmondjuk, hol lehet feltolteni. */
  function canvasImageChoices() {
    return partsOf().filter(function (p) { return p.kind === 'image' && p.asset_path })
  }

  function canvasAddText() {
    canvasOps([{
      op: 'add',
      object: { type: 'text', text: t('workbench.canvas.new_text'), x: 80, y: 80, width: 600, height: 120, fontSize: 64, color: '#111111' },
    }])
  }

  function canvasAddRect() {
    canvasOps([{ op: 'add', object: { type: 'rect', x: 80, y: 260, width: 400, height: 240, fill: '#dddddd', radius: 16 } }])
  }

  function canvasAddEllipse() {
    canvasOps([{ op: 'add', object: { type: 'ellipse', x: 120, y: 300, width: 240, height: 240, fill: '#dddddd' } }])
  }

  function canvasAddLine() {
    canvasOps([{ op: 'add', object: { type: 'line', x: 80, y: 540, width: 480, height: 20, stroke: '#111111', strokeWidth: 6 } }])
  }

  /** "Gomb" (K-2.6): elore osszerakott csoport -- lekerekitett doboz, rajta
   *  kozepre igazitott felirat. Egyben mozog, de mindket resze kulon allithato. */
  function canvasAddButton() {
    var taken = {}
    canvasObjects().forEach(function (o) { if (o.group) taken[o.group] = true })
    var base = t('workbench.canvas.button_group')
    var name = base
    for (var n = 2; taken[name]; n += 1) name = base + ' ' + n
    canvasOps([
      { op: 'add', object: { type: 'rect', x: 80, y: 700, width: 360, height: 96, fill: '#1a73e8', radius: 48, group: name } },
      { op: 'add', object: { type: 'text', text: t('workbench.canvas.button_text'), x: 80, y: 724, width: 360, height: 60, fontSize: 40, color: '#ffffff', align: 'center', bold: true, group: name } },
    ])
  }

  function canvasAddImage() {
    var src = fieldValue('wbCanNewImage', '')
    if (!src) return
    canvasOps([{ op: 'add', object: { type: 'image', src: src, x: 80, y: 80, width: 480, height: 360, fit: 'contain' } }])
  }

  /** A gyors gombok: KOZEPRE, NAGYOBB, KISEBB, ELORE, HATRA. Mindegyik
   *  ugyanazt a muveletet kuldi, amit az agent is kuldene -- a "tedd 30%-kal
   *  nagyobbra es kozepre" egy gombbal es egy mondattal ugyanaz. */
  function canvasQuickOp(op, id) {
    if (!id) return
    if (op === 'center') canvasOps([{ op: 'center', id: id, axis: 'both' }])
    else if (op === 'bigger') canvasOps([{ op: 'scale', id: id, factor: 1.3 }])
    else if (op === 'smaller') canvasOps([{ op: 'scale', id: id, factor: 1 / 1.3 }])
    else if (op === 'front') canvasOps([{ op: 'order', id: id, to: 'front' }])
    else if (op === 'back') canvasOps([{ op: 'order', id: id, to: 'back' }])
    else if (op === 'rotate') canvasOps([{ op: 'rotate', id: id, by: 15 }])
    else if (op === 'duplicate') canvasOps([{ op: 'duplicate', id: id }])
  }

  /** A kijelolt elemek, a vaszon sorrendjeben (a mar nem letezoket kihagyva). */
  function canvasPicked() {
    return canvasObjects().filter(function (o) { return !!WB.canvasPick[o.id] }).map(function (o) { return o.id })
  }

  /** Tobb elemre hato muvelet a kijelolten (K-2.5). Egy elemnel az igazitas a
   *  vaszonhoz igazit -- ezt a gomb felirata is megmondja. */
  function canvasMulti(kind, arg) {
    var ids = canvasPicked()
    if (!ids.length) return
    if (kind === 'align') canvasOps([{ op: 'align', ids: ids, to: arg }])
    else if (kind === 'distribute') canvasOps([{ op: 'distribute', ids: ids, axis: arg }])
    else if (kind === 'group') canvasOps([{ op: 'group', ids: ids }])
    else if (kind === 'ungroup') canvasOps([{ op: 'ungroup', ids: ids }])
  }

  /** A kijeloles eszkoztara: igazitas, elosztas, csoport. Kijeloles nelkul egy
   *  mondat mondja meg, hogyan lehet kijelolni -- nem ures sav. */
  function canvasPickBarHtml() {
    var ids = canvasPicked()
    var busy = WB.canvasBusy ? ' disabled' : ''
    if (!ids.length) return '<p class="wb-hint">' + esc(t('workbench.canvas.pick_hint')) + '</p>'
    var grouped = canvasObjects().some(function (o) { return WB.canvasPick[o.id] && o.group })
    var b = function (act, arg, label, off) {
      return '<button type="button" class="wb-mini-btn" data-wb-act="' + act + '" data-wb-arg="' + arg + '"' + (off ? ' disabled' : busy) + '>' + esc(label) + '</button>'
    }
    return '<div class="wb-can-pickbar">'
      + '<span class="wb-muted">' + esc(t(ids.length === 1 ? 'workbench.canvas.picked_one' : 'workbench.canvas.picked', { n: ids.length })) + '</span>'
      + ['left', 'center', 'right', 'top', 'middle', 'bottom'].map(function (a) { return b('canvas-align', a, t('workbench.canvas.align_to_' + a)) }).join('')
      + b('canvas-distribute', 'x', t('workbench.canvas.distribute_x'), ids.length < 3)
      + b('canvas-distribute', 'y', t('workbench.canvas.distribute_y'), ids.length < 3)
      + b('canvas-group', '', t('workbench.canvas.group'), ids.length < 2)
      + (grouped ? b('canvas-ungroup', '', t('workbench.canvas.ungroup')) : '')
      + b('canvas-unpick', '', t('workbench.canvas.unpick'))
      + '</div>'
  }

  /** Elem kivetele. A korabbi allapot NEM vesz el (uj verzio keletkezik), de
   *  a kerdest attol meg felteszunk: a felhasznalo ne veletlenul torolje. */
  function canvasRemoveObject(id) {
    if (!id || WB.canvasBusy) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.canvas.remove_confirm'))) return
    canvasOps([{ op: 'remove', id: id }])
  }

  // ---- huzogatos szerkesztes: a doboz-reteg (kartya d4b05d82) ---------------
  //
  // A KEPET tovabbra is a szerver rajzolja SVG-be -- ezert egyezik a letoltott
  // kep a latottal. A huzogatashoz csak egy ATLATSZO reteg kerul a kep fole:
  // elemenkent egy doboz, szazalekban megadott helyen, igy a kep barmilyen
  // meretben jelenhet meg, a dobozok vele egyutt mozdulnak.

  /** Az objektum-doboz also/felso hatara VASZON-egysegben. A szerver 1 es
   *  8000 kozott fogadja el (CANVAS_MAX_SIZE); 8 alatt nincs mit megfogni. */
  var CANVAS_OBJ_MIN = 8
  var CANVAS_OBJ_MAX = 8000
  var CANVAS_GRIPS = ['nw', 'ne', 'sw', 'se']

  /** A huzas UJ dobozat szamolja ki. Tiszta fuggveny: `dx`/`dy` mar
   *  VASZON-egysegben ertendo, es a kimenet kerekitett egesz. Atmeretezesnel a
   *  megfogott sarok ATELLENES pontja marad helyben -- ez az, amit a kez var. */
  function canvasDragBox(from, mode, dx, dy) {
    var x = from.x, y = from.y, w = from.width, h = from.height
    if (mode === 'move') {
      x = from.x + dx
      y = from.y + dy
    } else {
      var west = mode === 'nw' || mode === 'sw'
      var north = mode === 'nw' || mode === 'ne'
      w = west ? from.width - dx : from.width + dx
      h = north ? from.height - dy : from.height + dy
      if (w < CANVAS_OBJ_MIN) w = CANVAS_OBJ_MIN
      if (h < CANVAS_OBJ_MIN) h = CANVAS_OBJ_MIN
      if (w > CANVAS_OBJ_MAX) w = CANVAS_OBJ_MAX
      if (h > CANVAS_OBJ_MAX) h = CANVAS_OBJ_MAX
      if (west) x = from.x + from.width - w
      if (north) y = from.y + from.height - h
    }
    return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
  }

  /** A racs lepese vaszon-egysegben (K-2.7). */
  var CANVAS_GRID = 20

  /**
   * Illesztes (K-2.7) -- tiszta fuggveny. A huzott doboz szeleit es kozepet a
   * celvonalakhoz (a vaszon szelei es kozepe, a tobbi elem szelei es kozepe)
   * huzza, ha `tol` vaszon-egysegen belul vannak; ahogy a Figma es a Canva.
   * Atmeretezesnel csak a MOZGO szelek illeszkednek. Ha segedvonal nem fogja
   * meg, es a racs be van kapcsolva, a racsra kerekit.
   * Visszaad: az uj doboz + a megjelenitendo segedvonalak.
   */
  function canvasSnapBox(box, mode, others, doc, opts) {
    var tol = opts.tol
    var out = { x: box.x, y: box.y, width: box.width, height: box.height }
    var guides = []
    var targets = function (axis) {
      var list = axis === 'x' ? [0, doc.width / 2, doc.width] : [0, doc.height / 2, doc.height]
      others.forEach(function (o) {
        if (axis === 'x') list.push(o.x, o.x + o.width / 2, o.x + o.width)
        else list.push(o.y, o.y + o.height / 2, o.y + o.height)
      })
      return list
    }
    // Melyik pontok mozognak ezen a tengelyen: mozgatasnal mindharom (kezdet,
    // kozep, veg), atmeretezesnel csak a megfogott szel.
    var movers = function (axis) {
      var start = axis === 'x' ? out.x : out.y
      var size = axis === 'x' ? out.width : out.height
      if (mode === 'move') return [{ at: start, kind: 'start' }, { at: start + size / 2, kind: 'mid' }, { at: start + size, kind: 'end' }]
      var west = mode === 'nw' || mode === 'sw'
      var north = mode === 'nw' || mode === 'ne'
      var lead = axis === 'x' ? west : north
      return [lead ? { at: start, kind: 'start' } : { at: start + size, kind: 'end' }]
    }
    ;['x', 'y'].forEach(function (axis) {
      var best = null
      if (opts.guides) {
        var tg = targets(axis)
        movers(axis).forEach(function (m) {
          tg.forEach(function (at) {
            var d = at - m.at
            if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, kind: m.kind, at: at }
          })
        })
      }
      var startKey = axis === 'x' ? 'x' : 'y'
      var sizeKey = axis === 'x' ? 'width' : 'height'
      if (best) {
        if (mode === 'move') out[startKey] = out[startKey] + best.d
        else if (best.kind === 'start') { out[startKey] += best.d; out[sizeKey] -= best.d }
        else out[sizeKey] += best.d
        guides.push({ axis: axis, at: best.at })
      } else if (opts.grid) {
        var g = CANVAS_GRID
        if (mode === 'move') out[startKey] = Math.round(out[startKey] / g) * g
        else {
          var mv = movers(axis)[0]
          var snapped = Math.round(mv.at / g) * g
          var dd = snapped - mv.at
          if (mv.kind === 'start') { out[startKey] += dd; out[sizeKey] -= dd } else out[sizeKey] += dd
        }
      }
    })
    if (out.width < CANVAS_OBJ_MIN) out.width = CANVAS_OBJ_MIN
    if (out.height < CANVAS_OBJ_MIN) out.height = CANVAS_OBJ_MIN
    return {
      box: { x: Math.round(out.x), y: Math.round(out.y), width: Math.round(out.width), height: Math.round(out.height) },
      guides: guides,
    }
  }

  /** A doboz helye SZAZALEKBAN: a kep kicsinyitve is jo helyen all, es nem
   *  kell megmernunk a kepernyon elfoglalt meretet a kirajzolashoz. */
  function canvasBoxStyle(box, doc) {
    var pct = function (v, total) { return (Math.round((10000 * v) / total) / 100) + '%' }
    return 'left:' + pct(box.x, doc.width) + ';top:' + pct(box.y, doc.height)
      + ';width:' + pct(box.width, doc.width) + ';height:' + pct(box.height, doc.height)
      // A forgatott elem kerete is forog -- a kozeppontja korul, ahogy a kep.
      + (box.rotation ? ';transform:rotate(' + box.rotation + 'deg)' : '')
  }

  function canvasBoxHtml(o, doc) {
    return '<div class="wb-can-box' + (WB.canvasSel === o.id ? ' wb-can-box-sel' : '') + (WB.canvasPick[o.id] ? ' wb-can-box-picked' : '') + '"'
      + ' data-wb-box="' + escA(o.id) + '" data-wb-type="' + escA(o.type || '') + '" tabindex="0" role="button"'
      + ' title="' + escA(canvasObjectLabel(o)) + '"'
      + ' aria-label="' + escA(t('workbench.canvas.drag_aria', { name: canvasObjectLabel(o) })) + '"'
      + ' style="' + escA(canvasBoxStyle(o, doc)) + '">'
      + CANVAS_GRIPS.map(function (g) {
        return '<span class="wb-can-grip wb-can-grip-' + g + '" data-wb-grip="' + g + '" aria-hidden="true"></span>'
      }).join('')
      // Forgato fogantyu (Boss, 2026-10-02, TG 7319: "ott helyben forgatom, nagyitom"): a kijelolt elem
      // folott egy pottyel. Ugyanazt a `rotate` muveletet kuldi, mint a gomb es az agent.
      + (WB.canvasSel === o.id ? '<span class="wb-can-rot" data-wb-grip="rot" title="' + escA(t('workbench.canvas.rot_title')) + '" aria-hidden="true"></span>' : '')
      + '</div>'
  }

  /** A kijelolt elem LEBEGO eszkoztara (Canva-minta): a kijelolt elem folott all, a lapon. Minden gomb
   *  ugyanazt a vaszon-muveletet kuldi, amit az agent is kuldene. */
  function canvasFloatHtml(doc) {
    var o = WB.canvasSel ? canvasObject(WB.canvasSel) : null
    if (!o || WB.canvasEditId === o.id) return ''
    var flip = o.y < doc.height * 0.14
    var pct = function (v, total) { return (Math.round((10000 * v) / total) / 100) + '%' }
    var btn = function (op, label, title, on) {
      return '<button type="button" class="wb-can-fb' + (on ? ' wb-can-fb-on' : '') + '" data-wb-act="can-float" data-wb-fop="' + op + '"'
        + ' title="' + escA(title) + '" aria-label="' + escA(title) + '">' + label + '</button>'
    }
    var h = ''
    if (o.type === 'text') {
      h += btn('smaller', 'A\u2212', t('workbench.canvas.fl_smaller'))
        + '<span class="wb-can-fsize" title="' + escA(t('workbench.canvas.fl_size')) + '">' + esc(String(Math.round(o.fontSize || 0))) + '</span>'
        + btn('bigger', 'A+', t('workbench.canvas.fl_bigger'))
        + btn('bold', '<b>B</b>', t('workbench.canvas.fl_bold'), !!o.bold)
        + btn('italic', '<i>I</i>', t('workbench.canvas.fl_italic'), !!o.italic)
        + btn('alignleft', '\u2B05', t('workbench.canvas.fl_left'), o.align === 'left' || !o.align)
        + btn('aligncenter', '\u2194', t('workbench.canvas.fl_center'), o.align === 'center')
        + btn('alignright', '\u27A1', t('workbench.canvas.fl_right'), o.align === 'right')
        + brandFloatSwatchesHtml('color')
        + '<input type="color" class="wb-can-fcolor" data-wb-act="can-float-color" value="' + escA(/^#[0-9a-fA-F]{6}$/.test(o.color || '') ? o.color : '#111111') + '"'
        + ' title="' + escA(t('workbench.canvas.fl_color')) + '" aria-label="' + escA(t('workbench.canvas.fl_color')) + '">'
    } else if (o.type === 'rect' || o.type === 'ellipse') {
      h += brandFloatSwatchesHtml('fill')
        + '<input type="color" class="wb-can-fcolor" data-wb-act="can-float-fill" value="' + escA(/^#[0-9a-fA-F]{6}$/.test(o.fill || '') ? o.fill : '#dddddd') + '"'
        + ' title="' + escA(t('workbench.canvas.fl_fill')) + '" aria-label="' + escA(t('workbench.canvas.fl_fill')) + '">'
        + btn('smaller', '\u2212', t('workbench.canvas.fl_smaller')) + btn('bigger', '+', t('workbench.canvas.fl_bigger'))
    } else {
      h += btn('smaller', '\u2212', t('workbench.canvas.fl_smaller')) + btn('bigger', '+', t('workbench.canvas.fl_bigger'))
    }
    h += '<span class="wb-can-fsep"></span>'
      + btn('rotate', '\u21BB', t('workbench.canvas.fl_rotate'))
      + btn('front', '\u2B06', t('workbench.canvas.fl_front'))
      + btn('back', '\u2B07', t('workbench.canvas.fl_back'))
      + btn('duplicate', '\u29C9', t('workbench.canvas.fl_duplicate'))
      + btn('remove', '\uD83D\uDDD1', t('workbench.canvas.fl_remove'))
    return '<div class="wb-can-float' + (flip ? ' wb-can-float-below' : '') + '" data-wb-float="1"'
      + ' style="left:' + pct(o.x + o.width / 2, doc.width) + ';top:' + pct(flip ? o.y + o.height : o.y, doc.height) + '">' + h + '</div>'
  }

  /** A vaszon elonezete: a szerver rajzolta kep + (ha lehet) a huzogato reteg.
   *  Amikor a reteg NEM jelenik meg, azt KIMONDJUK, es megmondjuk, mi helyette
   *  az ut -- a nema hianyzas a legrosszabb valasz. */
  function canvasStageHtml(name, bare, noCaption) {
    return (noCaption ? '' : canvasSizeCaptionHtml()) + canvasStageInnerHtml(name, bare)
  }

  /** A vaszon fole kiirt meret: melyik platform, es a pontos meret pixelben (#493).
   *  Ha egyik platformhoz sem illik, ezt KIMONDJUK ("Egyedi meret"), nem hagyjuk uresen. */
  function canvasSizeCaptionHtml() {
    var doc = WB.canvas && WB.canvas.exists && WB.canvas.canvas
    if (!doc) return ''
    var p = canvasPlatformNow()
    var size = doc.width + ' \u00D7 ' + doc.height + ' px'
    return '<p class="wb-can-sizecap" id="wbCanSizeCap">' + esc((p ? platformLabel(p) : t('workbench.canvas.size_custom')) + ' \u00B7 ' + size) + '</p>'
  }

  function canvasStageInnerHtml(name, bare) {
    var img = '<img class="wb-preview-image" src="' + escA(canvasSvgUrl(WB.selectedId, false)) + '"'
      + ' alt="' + escA(name) + '">'
    // A NULLA itt ket dolgot jelenthet: "meg nem toltottuk be a rajz adatait"
    // (nem tudunk dobozt rajzolni) vagy "ures a vaszon" (van reteg, nincs
    // benne doboz). A kettot KULON kezeljuk.
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc) {
      return '<div class="wb-can-stage">' + img + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_unavailable')) + '</p>'
    }
    if (archived()) {
      return '<div class="wb-can-stage">' + img + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_archived')) + '</p>'
    }
    // Elo nezet (Egyszeru nezet kerete): CSAK a kesz kep, ahogy exportalva is latszik -- se doboz, se kijelolo-pont,
    // se huzas (nincs data-wb-stage, igy a huzo-kezelo sem kapcsol ra).
    if (bare && WB.frLive) return '<div class="wb-can-stage wb-can-stage-live">' + img + '</div>'
    return '<div class="wb-can-stage" data-wb-stage="1">' + img
      + '<div class="wb-can-layer' + (WB.canvasGrid ? ' wb-can-layer-grid' : '') + '"'
      + (WB.canvasGrid ? ' style="background-size:' + (Math.round(10000 * CANVAS_GRID / doc.width) / 100) + '% ' + (Math.round(10000 * CANVAS_GRID / doc.height) / 100) + '%"' : '') + '>'
      + canvasSafeHtml()
      + '<span class="wb-can-guide wb-can-guide-x" id="wbCanGuideX" hidden></span>'
      + '<span class="wb-can-guide wb-can-guide-y" id="wbCanGuideY" hidden></span>'
      + canvasObjects().map(function (o) { return canvasBoxHtml(o, doc) }).join('')
      + canvasFloatHtml(doc)
      + '</div>'
      + '<span class="wb-can-live" id="wbCanLive" aria-live="polite"></span>'
      + '</div>'
      // Az Egyszeru nezet kereteben csak a lap all (a segedvonal-kapcsolok az Eszkozok panelen vannak).
      + (bare ? '' : (canvasPlatformNow() && canvasPlatformNow().safe
        ? '<p class="wb-hint">' + esc(t('workbench.canvas.safe_hint', { name: platformLabel(canvasPlatformNow()) })) + '</p>' : '')
      + '<p class="wb-can-snapopts">'
      + '<label><input type="checkbox" data-wb-act="canvas-snap"' + (WB.canvasSnap ? ' checked' : '') + '> ' + esc(t('workbench.canvas.snap_guides')) + '</label>'
      + '<label><input type="checkbox" data-wb-act="canvas-grid"' + (WB.canvasGrid ? ' checked' : '') + '> ' + esc(t('workbench.canvas.snap_grid', { n: CANVAS_GRID })) + '</label>'
      + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_hint')) + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.drop_hint')) + '</p>')
  }

  function canvasFormHtml(o) {
    var common = '<div class="wb-can-grid">'
      + '<label class="wb-label" for="wbCanX">' + esc(t('workbench.canvas.label_x')) + '</label>'
      + '<input class="wb-input" id="wbCanX" type="number" value="' + escA(String(o.x)) + '">'
      + '<label class="wb-label" for="wbCanY">' + esc(t('workbench.canvas.label_y')) + '</label>'
      + '<input class="wb-input" id="wbCanY" type="number" value="' + escA(String(o.y)) + '">'
      + '<label class="wb-label" for="wbCanW">' + esc(t('workbench.canvas.label_width')) + '</label>'
      + '<input class="wb-input" id="wbCanW" type="number" value="' + escA(String(o.width)) + '">'
      + '<label class="wb-label" for="wbCanH">' + esc(t('workbench.canvas.label_height')) + '</label>'
      + '<input class="wb-input" id="wbCanH" type="number" value="' + escA(String(o.height)) + '">'
      + '<label class="wb-label" for="wbCanRot">' + esc(t('workbench.canvas.label_rotation')) + '</label>'
      + '<input class="wb-input" id="wbCanRot" type="number" min="-180" max="180" step="1" value="' + escA(String(o.rotation || 0)) + '">'
      + '<label class="wb-label" for="wbCanOpacity">' + esc(t('workbench.canvas.label_opacity')) + '</label>'
      + '<input class="wb-input" id="wbCanOpacity" type="number" min="0" max="100" step="5" value="' + escA(String(Math.round((o.opacity == null ? 1 : o.opacity) * 100))) + '">'
      + '</div>'
    var own = ''
    if (o.type === 'text') {
      own = '<label class="wb-label" for="wbCanText">' + esc(t('workbench.canvas.label_text')) + '</label>'
        + '<textarea class="wb-input" id="wbCanText" rows="3">' + esc(o.text || '') + '</textarea>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFont">' + esc(t('workbench.canvas.label_font')) + '</label>'
        + '<select class="wb-input" id="wbCanFont">'
        + ['sans', 'serif', 'mono'].map(function (f) {
          return '<option value="' + f + '"' + ((o.font || 'sans') === f ? ' selected' : '') + '>' + esc(t('workbench.canvas.font_' + f)) + '</option>'
        }).join('') + '</select>'
        + '<label class="wb-label" for="wbCanFontSize">' + esc(t('workbench.canvas.label_font_size')) + '</label>'
        + '<input class="wb-input" id="wbCanFontSize" type="number" min="4" max="1200" value="' + escA(String(o.fontSize)) + '">'
        + '<label class="wb-label" for="wbCanColor">' + esc(t('workbench.canvas.label_color')) + '</label>'
        + '<input class="wb-input" id="wbCanColor" type="color" value="' + escA(o.color || '#111111') + '">' + brandSwatchesHtml('wbCanColor')
        + '<label class="wb-label" for="wbCanAlign">' + esc(t('workbench.canvas.label_align')) + '</label>'
        + '<select class="wb-input" id="wbCanAlign">'
        + ['left', 'center', 'right'].map(function (a) {
          return '<option value="' + a + '"' + (o.align === a ? ' selected' : '') + '>' + esc(t('workbench.canvas.align_' + a)) + '</option>'
        }).join('') + '</select>'
        + '</div>'
        + '<p class="wb-can-checks">'
        + '<label><input type="checkbox" id="wbCanBold"' + (o.bold ? ' checked' : '') + '> ' + esc(t('workbench.canvas.label_bold')) + '</label>'
        + '<label><input type="checkbox" id="wbCanItalic"' + (o.italic ? ' checked' : '') + '> ' + esc(t('workbench.canvas.label_italic')) + '</label>'
        + '</p>'
    } else if (o.type === 'rect') {
      own = '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFill">' + esc(t('workbench.canvas.label_fill')) + '</label>'
        + '<input class="wb-input" id="wbCanFill" type="color" value="' + escA(o.fill || '#dddddd') + '">' + brandSwatchesHtml('wbCanFill')
        + '<label class="wb-label" for="wbCanRadius">' + esc(t('workbench.canvas.label_radius')) + '</label>'
        + '<input class="wb-input" id="wbCanRadius" type="number" min="0" value="' + escA(String(o.radius)) + '">'
        + '</div>'
    } else if (o.type === 'ellipse' || o.type === 'line') {
      own = '<div class="wb-can-grid">'
        + (o.type === 'ellipse'
          ? '<label class="wb-label" for="wbCanFill">' + esc(t('workbench.canvas.label_fill')) + '</label>'
            + '<input class="wb-input" id="wbCanFill" type="color" value="' + escA(o.fill && o.fill !== 'none' ? o.fill : '#dddddd') + '">' + brandSwatchesHtml('wbCanFill')
          : '')
        + '<label class="wb-label" for="wbCanStroke">' + esc(t('workbench.canvas.label_stroke')) + '</label>'
        + '<input class="wb-input" id="wbCanStroke" type="color" value="' + escA(o.stroke && o.stroke !== 'none' ? o.stroke : '#111111') + '">' + brandSwatchesHtml('wbCanStroke')
        + '<label class="wb-label" for="wbCanStrokeWidth">' + esc(t('workbench.canvas.label_stroke_width')) + '</label>'
        + '<input class="wb-input" id="wbCanStrokeWidth" type="number" min="0" max="400" value="' + escA(String(o.strokeWidth || 0)) + '">'
        + '</div>'
    } else {
      own = '<p class="wb-hint">' + esc(o.src || '') + '</p>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFit">' + esc(t('workbench.canvas.label_fit')) + '</label>'
        + '<select class="wb-input" id="wbCanFit">'
        + ['contain', 'cover'].map(function (f) {
          return '<option value="' + f + '"' + (o.fit === f ? ' selected' : '') + '>' + esc(t('workbench.canvas.fit_' + f)) + '</option>'
        }).join('') + '</select>'
        + '<label class="wb-label" for="wbCanAlt">' + esc(t('workbench.canvas.label_alt')) + '</label>'
        + '<input class="wb-input" id="wbCanAlt" type="text" value="' + escA(o.alt || '') + '">'
        + '</div>'
    }
    return '<form class="wb-can-form" id="wbCanForm">' + own + common
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="canvas-save" data-wb-obj="' + escA(o.id) + '"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(WB.canvasBusy ? t('workbench.canvas.saving') : t('workbench.canvas.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="canvas-cancel">' + esc(t('common.cancel')) + '</button>'
      + '</div></form>'
  }

  function canvasObjectLabel(o) {
    if (o.type === 'text') return t('workbench.canvas.obj_text', { text: (o.text || '').slice(0, 40) })
    if (o.type === 'rect') return t('workbench.canvas.obj_rect')
    if (o.type === 'ellipse') return t('workbench.canvas.obj_ellipse')
    if (o.type === 'line') return t('workbench.canvas.obj_line')
    return t('workbench.canvas.obj_image', { name: (o.src || '').split('/').pop() })
  }

  function canvasObjectHtml(o) {
    var btn = function (act, op, label) {
      return '<button type="button" class="wb-part-btn" data-wb-act="' + act + '" data-wb-op="' + op + '" data-wb-obj="' + escA(o.id) + '"'
        + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(label) + '</button>'
    }
    var ro = archived()
    return '<li class="wb-can-obj' + (WB.canvasPick[o.id] ? ' wb-can-obj-picked' : '') + '">'
      + '<div class="wb-can-obj-head">'
      + (ro ? '' : '<input type="checkbox" class="wb-can-pick-box" data-wb-act="canvas-pick" data-wb-obj="' + escA(o.id) + '"'
        + (WB.canvasPick[o.id] ? ' checked' : '') + ' aria-label="' + escA(t('workbench.canvas.pick_aria', { name: canvasObjectLabel(o) })) + '">')
      + '<span class="wb-pill">' + esc(t('workbench.canvas.type_' + o.type)) + '</span>'
      + '<span class="wb-can-obj-name">' + esc(canvasObjectLabel(o)) + '</span>'
      + '<code class="wb-can-id">' + esc(o.id) + '</code>'
      + (o.group ? ' <span class="wb-pill wb-can-group">' + esc(t('workbench.canvas.in_group', { name: o.group })) + '</span>' : '')
      + (o.rotation ? ' <span class="wb-muted">' + esc(t('workbench.canvas.turned', { deg: o.rotation })) + '</span>' : '')
      + (o.ai ? ' <span class="wb-pill wb-can-ai-pill" title="' + escA(t('workbench.canvas.ai_pill_title', { model: o.ai.model, prompt: o.ai.prompt })) + '">' + esc(t('workbench.canvas.ai_pill')) + '</span>' : '')
      + '</div>'
      + '<div class="wb-can-obj-actions">'
      + btn('canvas-op', 'center', t('workbench.canvas.center'))
      + btn('canvas-op', 'bigger', t('workbench.canvas.bigger'))
      + btn('canvas-op', 'smaller', t('workbench.canvas.smaller'))
      + btn('canvas-op', 'front', t('workbench.canvas.front'))
      + btn('canvas-op', 'back', t('workbench.canvas.back'))
      + btn('canvas-op', 'rotate', t('workbench.canvas.rotate'))
      + btn('canvas-op', 'duplicate', t('workbench.canvas.duplicate'))
      + (o.type === 'image' && !ro
        ? '<button type="button" class="wb-part-btn" data-wb-act="canvas-ai-open" data-wb-obj="' + escA(o.id) + '"' + (WB.canvasBusy ? ' disabled' : '') + '>'
          + esc(t('workbench.canvas.ai_open')) + '</button>'
        : '')
      + '<button type="button" class="wb-part-btn" data-wb-act="canvas-edit" data-wb-obj="' + escA(o.id) + '">'
      + esc(t('workbench.canvas.edit')) + '</button>'
      + '<button type="button" class="wb-part-btn wb-part-btn-bad" data-wb-act="canvas-remove" data-wb-obj="' + escA(o.id) + '"'
      + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.canvas.remove')) + '</button>'
      + '</div>'
      + (WB.canvasEdit === o.id ? canvasFormHtml(o) : '')
      + (WB.canvasAi && WB.canvasAi.id === o.id ? canvasAiHtml(o) : '')
      + '</li>'
  }

  function canvasAddHtml() {
    var images = canvasImageChoices()
    return '<div class="wb-can-add">'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-text"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_text')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-rect"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_rect')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-ellipse"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_ellipse')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-line"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_line')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-button"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_button')) + '</button>'
      + (images.length
        ? '<select class="wb-input wb-can-pick" id="wbCanNewImage">'
          + images.map(function (p) {
            return '<option value="' + escA(p.asset_path) + '">' + esc((p.asset_path || '').split('/').pop()) + '</option>'
          }).join('') + '</select>'
          + '<button type="button" class="wb-btn" data-wb-act="canvas-add-image"' + (WB.canvasBusy ? ' disabled' : '') + '>'
          + esc(t('workbench.canvas.add_image')) + '</button>'
        // A nulla itt "meg nincs feltoltott kep" -- es megmondjuk, HOL lehet.
        : '<span class="wb-hint">' + esc(t('workbench.canvas.no_images')) + '</span>')
      + '</div>'
  }

  // ---- video timeline (v4 spec phase 5) --------------------------------------
  //
  // Same shape as the canvas: every edit goes to the server at once (working
  // copy, undo, versions there); the page only shows what the server returns.

  function vtUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/timeline' + (tail || '')
  }

  function loadVideoTimeline(itemId) {
    WB.vtError = null
    return api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/timeline').then(function (r) {
      if (WB.selectedId !== itemId) return
      if (!r.ok) {
        WB.vt = null
        WB.vtError = { message: r.message, detail: (r.data && r.data.detail) || '' }
      } else {
        WB.vt = r.data && r.data.timeline ? r.data : null
      }
      render()
      loadVideoMedia()
    })
  }

  function loadVideoMedia() {
    if (!WB.projectId || WB.vtMedia !== null) return
    WB.vtMedia = []
    api('GET', '/api/workbench/media?project=' + encodeURIComponent(WB.projectId)).then(function (r) {
      if (r.ok) { WB.vtMedia = (r.data && r.data.files) || []; render() }
    })
  }

  function vtDoc() { return (WB.vt && WB.vt.timeline) || null }

  function vtTake(d) {
    var old = WB.vt || {}
    WB.vt = Object.assign({}, old, {
      timeline: d.timeline || old.timeline, exists: true,
      summary: d.summary || old.summary, duration: 'duration' in d ? d.duration : old.duration,
      offsets: d.offsets || old.offsets,
      draft: 'draft' in d ? d.draft : old.draft,
      history: 'history' in d ? d.history : old.history,
      orphans: 'orphans' in d ? d.orphans : old.orphans,
      last_render: 'last_render' in d ? d.last_render : old.last_render,
      current: true,
    })
    if (WB.detail && d.item) WB.detail.item = d.item
    if (WB.detail && d.versions) WB.detail.versions = d.versions
  }

  function vtFail(r) {
    WB.vtError = { message: r.message, detail: (r.data && r.data.detail) || '' }
  }

  /** A batch of operations: the same route the agent uses. */
  function vtOps(ops) {
    if (!WB.selectedId || WB.vtBusy || archived()) return
    WB.vtBusy = true
    render()
    api('POST', vtUrl('/ops'), { ops: ops }).then(function (r) {
      WB.vtBusy = false
      if (!r.ok) { vtFail(r); render(); return }
      WB.vtError = null
      vtTake(r.data)
      if (r.data.created) window.showToast(r.data.message || t('workbench.vt.saved'))
      render()
    })
  }

  function vtStep(dir) {
    var h = WB.vt && WB.vt.history
    if (!WB.selectedId || WB.vtBusy || archived() || !h || !(dir === 'undo' ? h.can_undo : h.can_redo)) return
    WB.vtBusy = true
    render()
    api('POST', vtUrl('/' + dir), {}).then(function (r) {
      WB.vtBusy = false
      if (!r.ok) {
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        loadVideoTimeline(WB.selectedId)
        return
      }
      vtTake(r.data)
      window.showToast(t(dir === 'undo' ? 'workbench.vt.undone' : 'workbench.vt.redone'))
      render()
    })
  }

  function vtVersion() {
    if (!WB.selectedId || WB.vtBusy || archived()) return
    var label = typeof window.prompt === 'function' ? window.prompt(t('workbench.canvas.version_prompt'), '') : ''
    if (label === null) return
    WB.vtBusy = true
    render()
    api('POST', vtUrl('/version'), { label: label || '', reason: 'manual' }).then(function (r) {
      WB.vtBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      vtTake(r.data)
      window.showToast(r.data.message || t('workbench.vt.version_saved'))
      render()
    })
  }

  /** Making the mp4 takes a while: one at a time, and the button says so. */
  function vtRenderNow() {
    if (!WB.selectedId || WB.vtBusy || WB.vtRender || archived()) return
    WB.vtRender = true
    WB.vtError = null
    render()
    api('POST', vtUrl('/render'), {}).then(function (r) {
      WB.vtRender = false
      if (!r.ok) { vtFail(r); render(); return }
      vtTake(r.data)
      window.showToast(r.data.message || t('workbench.vt.rendered'))
      render()
    })
  }

  /** Subtitles from the speech, by the recogniser on THIS machine: one request, takes about as long as the clips. */
  function vtAutoSubtitle() {
    if (!WB.selectedId || WB.vtBusy || WB.vtRender || WB.vtAuto || archived()) return
    var lang = vtText('auto-lang') || 'hu'
    var rep = vtInput('auto-replace')
    var replace = !!(rep && rep.checked)
    if (replace && typeof window.confirm === 'function' && !window.confirm(t('workbench.vt.auto_replace_confirm'))) return
    WB.vtAuto = true
    WB.vtError = null
    render()
    api('POST', vtUrl('/autosubtitle'), { language: lang, replace: replace }).then(function (r) {
      WB.vtAuto = false
      if (!r.ok) { vtFail(r); render(); return }
      vtTake(r.data)
      var skipped = r.data.skipped || []
      window.showToast((r.data.message || '') + (skipped.length ? ' ' + t('workbench.vt.auto_skipped', { n: skipped.length }) : ''))
      render()
    })
  }

  function vtInput(name, id) {
    return document.getElementById('wbVt-' + name + (id ? '-' + id : ''))
  }
  function vtNum(name, id) {
    var el = vtInput(name, id)
    if (!el || String(el.value).trim() === '') return undefined
    var n = Number(String(el.value).replace(',', '.'))
    return isNaN(n) ? NaN : n
  }
  function vtText(name, id) {
    var el = vtInput(name, id)
    return el ? String(el.value) : ''
  }
  /** A number the owner typed that is not a number: say so, send nothing. */
  function vtBad(v) {
    if (typeof v === 'number' && isNaN(v)) { window.showToast(t('workbench.vt.not_a_number')); return true }
    return false
  }

  function vtAddClip() {
    var src = vtText('clip-src')
    if (!src) { window.showToast(t('workbench.vt.pick_file')); return }
    var s = vtNum('clip-start'), e = vtNum('clip-end')
    if (vtBad(s) || vtBad(e)) return
    var op = { op: 'addClip', src: src, start: s === undefined ? 0 : s }
    if (e !== undefined) op.end = e
    vtOps([op])
  }
  function vtTrimClip(id) {
    var s = vtNum('start', id), e = vtNum('end', id)
    if (vtBad(s) || vtBad(e)) return
    var op = { op: 'trimClip', id: id }
    if (s !== undefined) op.start = s
    if (e !== undefined) op.end = e
    vtOps([op])
  }
  function vtMoveClip(id, delta) {
    var clips = (vtDoc() || {}).clips || []
    for (var i = 0; i < clips.length; i += 1) {
      if (clips[i].id === id) { vtOps([{ op: 'moveClip', id: id, to: i + 1 + delta }]); return }
    }
  }
  function vtSplitClip(id) {
    var raw = typeof window.prompt === 'function' ? window.prompt(t('workbench.vt.split_prompt'), '') : null
    if (raw === null || String(raw).trim() === '') return
    var n = Number(String(raw).replace(',', '.'))
    if (isNaN(n)) { window.showToast(t('workbench.vt.not_a_number')); return }
    vtOps([{ op: 'splitClip', id: id, at: n }])
  }
  function vtAddSubtitle() {
    var s = vtNum('sub-start'), e = vtNum('sub-end')
    if (vtBad(s) || vtBad(e)) return
    vtOps([{ op: 'addSubtitle', text: vtText('sub-text'), start: s, end: e }])
  }
  function vtSaveSubtitle(id) {
    var s = vtNum('start', id), e = vtNum('end', id)
    if (vtBad(s) || vtBad(e)) return
    var op = { op: 'updateSubtitle', id: id, text: vtText('text', id) }
    if (s !== undefined) op.start = s
    if (e !== undefined) op.end = e
    vtOps([op])
  }
  function vtMusicVolume() {
    var v = vtNum('music-volume')
    if (vtBad(v)) return null
    return v === undefined ? 0.5 : Math.max(0, Math.min(100, v)) / 100
  }
  function vtSetMusic() {
    var src = vtText('music-src')
    if (!src) { window.showToast(t('workbench.vt.pick_file')); return }
    var v = vtMusicVolume()
    if (v === null) return
    var d = vtInput('music-duck')
    vtOps([{ op: 'setMusic', src: src, volume: v, duck: !!(d && d.checked) }])
  }
  function vtSaveMusic() {
    var v = vtMusicVolume()
    if (v === null) return
    var d = vtInput('music-duck')
    vtOps([{ op: 'updateMusic', volume: v, duck: !!(d && d.checked) }])
  }
  function vtSaveVolume() {
    var v = vtNum('clip-volume')
    if (v === undefined || vtBad(v)) return
    vtOps([{ op: 'setClipVolume', volume: Math.max(0, Math.min(100, v)) / 100 }])
  }
  function vtOverlayFields(id) {
    var s = vtNum('start', id), e = vtNum('end', id), x = vtNum('x', id), y = vtNum('y', id), w = vtNum('width', id)
    if (vtBad(s) || vtBad(e) || vtBad(x) || vtBad(y) || vtBad(w)) return null
    var pct = function (n, d) { return n === undefined ? d : Math.max(0, Math.min(100, n)) / 100 }
    return { start: s, end: e, x: pct(x, 0.7), y: pct(y, 0.05), width: pct(w, 0.25) }
  }
  function vtAddOverlay() {
    var src = vtText('ov-src')
    if (!src) { window.showToast(t('workbench.vt.pick_file')); return }
    var f = vtOverlayFields('')
    if (!f) return
    vtOps([{ op: 'addOverlay', src: src, start: f.start, end: f.end, x: f.x, y: f.y, width: f.width, opacity: 1 }])
  }
  function vtSaveOverlay(id) {
    var f = vtOverlayFields(id)
    if (!f) return
    vtOps([{ op: 'updateOverlay', id: id, start: f.start, end: f.end, x: f.x, y: f.y, width: f.width }])
  }

  function vtSecs(n) { return String(Math.round(Number(n) * 10) / 10).replace('.', ',') }

  function vtMediaOptions(kind, chosen) {
    var list = (WB.vtMedia || []).filter(function (f) { return f.kind === kind })
    return '<option value="">' + esc(t('workbench.vt.pick_file')) + '</option>'
      + list.map(function (f) {
        return '<option value="' + escA(f.path) + '"' + (f.path === chosen ? ' selected' : '') + '>' + esc(f.path.split('/').slice(-2).join('/')) + '</option>'
      }).join('')
  }

  function vtNumField(name, id, value, label) {
    return '<label class="wb-muted">' + esc(label) + ' <input type="text" size="5" inputmode="decimal" id="wbVt-' + name + (id ? '-' + escA(id) : '') + '" value="' + escA(value === undefined || value === null ? '' : vtSecs(value)) + '"></label> '
  }

  function vtBtn(act, label, id, extra) {
    return '<button type="button" class="wb-btn" data-wb-act="' + act + '"' + (id ? ' data-wb-id="' + escA(id) + '"' : '')
      + (extra || '') + (WB.vtBusy || WB.vtRender || archived() ? ' disabled' : '') + '>' + esc(label) + '</button> '
  }

  function vtClipsHtml(doc) {
    var rows = doc.clips.map(function (c, i) {
      return '<li class="wb-vt-row"><strong>' + (i + 1) + '.</strong> <span>' + esc(c.src.split('/').pop()) + '</span> '
        + vtNumField('start', c.id, c.start, t('workbench.vt.from')) + vtNumField('end', c.id, c.end, t('workbench.vt.to'))
        + vtBtn('vt-clip-trim', t('workbench.vt.trim'), c.id)
        + vtBtn('vt-clip-up', t('workbench.vt.up'), c.id, i === 0 ? ' disabled' : '')
        + vtBtn('vt-clip-down', t('workbench.vt.down'), c.id, i === doc.clips.length - 1 ? ' disabled' : '')
        + vtBtn('vt-clip-split', t('workbench.vt.split'), c.id)
        + vtBtn('vt-clip-del', t('workbench.vt.remove'), c.id) + '</li>'
    }).join('')
    return '<h5>' + esc(t('workbench.vt.clips')) + '</h5>'
      + (rows ? '<ol class="wb-vt-list">' + rows + '</ol>' : '<p class="wb-muted">' + esc(t('workbench.vt.no_clips')) + '</p>')
      + '<p><select id="wbVt-clip-src">' + vtMediaOptions('video') + '</select> '
      + vtNumField('clip-start', '', undefined, t('workbench.vt.from')) + vtNumField('clip-end', '', undefined, t('workbench.vt.to'))
      + vtBtn('vt-clip-add', t('workbench.vt.add_clip')) + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.vt.clip_hint')) + '</p>'
  }

  function vtSubtitlesHtml(doc) {
    var rows = doc.subtitles.map(function (s) {
      return '<li class="wb-vt-row"><input type="text" size="34" id="wbVt-text-' + escA(s.id) + '" value="' + escA(s.text) + '"> '
        + vtNumField('start', s.id, s.start, t('workbench.vt.from')) + vtNumField('end', s.id, s.end, t('workbench.vt.to'))
        + vtBtn('vt-sub-save', t('workbench.vt.save'), s.id) + vtBtn('vt-sub-del', t('workbench.vt.remove'), s.id) + '</li>'
    }).join('')
    return '<h5>' + esc(t('workbench.vt.subtitles')) + '</h5>'
      + (rows ? '<ul class="wb-vt-list">' + rows + '</ul>' : '')
      + '<p><input type="text" size="34" id="wbVt-sub-text" placeholder="' + escA(t('workbench.vt.sub_text')) + '"> '
      + vtNumField('sub-start', '', undefined, t('workbench.vt.from')) + vtNumField('sub-end', '', undefined, t('workbench.vt.to'))
      + vtBtn('vt-sub-add', t('workbench.vt.add_sub')) + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.vt.sub_hint')) + '</p>'
      + (doc.clips.length ? '<p><select class="wb-input" id="wbVt-auto-lang" aria-label="' + escA(t('workbench.vt.auto_lang')) + '">'
        + ['hu', 'en', 'de'].map(function (l) { return '<option value="' + l + '"' + (l === (window._lang || 'hu') ? ' selected' : '') + '>' + esc(t('workbench.vt.auto_lang_' + l)) + '</option>' }).join('') + '</select> '
        + '<label class="wb-muted"><input type="checkbox" id="wbVt-auto-replace"> ' + esc(t('workbench.vt.auto_replace')) + '</label> '
        + '<button type="button" class="wb-btn" data-wb-act="vt-autosub"' + (WB.vtBusy || WB.vtRender || WB.vtAuto || archived() ? ' disabled' : '') + '>'
        + esc(WB.vtAuto ? t('workbench.vt.auto_busy') : t('workbench.vt.auto')) + '</button></p>'
        + '<p class="wb-hint">' + esc(t('workbench.vt.auto_hint')) + '</p>' : '')
  }

  function vtMusicHtml(doc) {
    var m = doc.music
    return '<h5>' + esc(t('workbench.vt.music')) + '</h5><p>'
      + '<select id="wbVt-music-src"' + (m ? ' disabled' : '') + '>' + vtMediaOptions('audio', m && m.src) + '</select> '
      + vtNumField('music-volume', '', Math.round((m ? m.volume : 0.5) * 100), t('workbench.vt.volume_pct'))
      + '<label class="wb-muted"><input type="checkbox" id="wbVt-music-duck"' + (!m || m.duck ? ' checked' : '') + '> ' + esc(t('workbench.vt.duck')) + '</label> '
      + (m ? vtBtn('vt-music-save', t('workbench.vt.save')) + vtBtn('vt-music-del', t('workbench.vt.remove')) : vtBtn('vt-music-set', t('workbench.vt.set_music')))
      + '</p>'
  }

  function vtOverlaysHtml(doc) {
    var pc = function (n) { return Math.round(n * 100) }
    var rows = doc.overlays.map(function (o) {
      return '<li class="wb-vt-row"><span>' + esc(o.src.split('/').pop()) + '</span> '
        + vtNumField('start', o.id, o.start, t('workbench.vt.from')) + vtNumField('end', o.id, o.end, t('workbench.vt.to'))
        + vtNumField('x', o.id, pc(o.x), 'x %') + vtNumField('y', o.id, pc(o.y), 'y %') + vtNumField('width', o.id, pc(o.width), t('workbench.vt.width_pct'))
        + vtBtn('vt-ov-save', t('workbench.vt.save'), o.id) + vtBtn('vt-ov-del', t('workbench.vt.remove'), o.id) + '</li>'
    }).join('')
    return '<h5>' + esc(t('workbench.vt.overlays')) + '</h5>'
      + (rows ? '<ul class="wb-vt-list">' + rows + '</ul>' : '')
      + '<p><select id="wbVt-ov-src">' + vtMediaOptions('image') + '</select> '
      + vtNumField('start', '', undefined, t('workbench.vt.from')) + vtNumField('end', '', undefined, t('workbench.vt.to'))
      + vtNumField('x', '', 70, 'x %') + vtNumField('y', '', 5, 'y %') + vtNumField('width', '', 25, t('workbench.vt.width_pct'))
      + vtBtn('vt-ov-add', t('workbench.vt.add_overlay')) + '</p>'
  }

  function videoTimelineHtml() {
    var it = WB.detail && WB.detail.item
    if (!it || it.type !== 'video') return ''
    var headOf = function (extra) {
      return '<div class="wb-can"><div class="wb-can-head"><h4>' + esc(t('workbench.vt.title')) + '</h4>' + (extra || '') + '</div>'
    }
    if (WB.vtError && !WB.vt) {
      return headOf()
        + '<p class="wb-preview-bad">' + esc(WB.vtError.message || '') + '</p>'
        + (WB.vtError.detail ? '<p class="wb-hint">' + esc(WB.vtError.detail) + '</p>' : '')
        + '<p>' + vtBtn('vt-refresh', t('workbench.canvas.refresh')) + '</p></div>'
    }
    if (!WB.vt || !WB.vt.timeline) return headOf() + '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    var doc = vtDoc()
    var h = WB.vt.history || {}
    var aspects = ((WB.vt.limits && WB.vt.limits.aspects) || ['16:9', '9:16', '1:1']).map(function (a) {
      return '<button type="button" class="wb-btn' + (doc.aspect === a ? ' wb-on' : '') + '" data-wb-act="vt-aspect" data-wb-v="' + escA(a) + '"'
        + (WB.vtBusy || archived() ? ' disabled' : '') + '>' + esc(a) + '</button>'
    }).join(' ')
    var last = WB.vt.last_render
    return headOf('<span class="wb-muted">' + esc(t('workbench.vt.length', { s: vtSecs(WB.vt.duration || 0) })) + '</span>')
      + '<p class="wb-hint">' + esc(t('workbench.vt.intro')) + '</p>'
      + (WB.vtError ? '<p class="wb-preview-bad">' + esc(WB.vtError.message || '') + '</p>' + (WB.vtError.detail ? '<p class="wb-hint">' + esc(WB.vtError.detail) + '</p>' : '') : '')
      + '<p>' + aspects + ' '
      + vtBtn('vt-undo', t('workbench.vt.undo'), '', h.can_undo ? '' : ' disabled')
      + vtBtn('vt-redo', t('workbench.vt.redo'), '', h.can_redo ? '' : ' disabled')
      + vtBtn('vt-version', t('workbench.vt.version')) + '</p>'
      + vtClipsHtml(doc) + vtSubtitlesHtml(doc) + vtMusicHtml(doc) + vtOverlaysHtml(doc)
      + '<p>' + vtNumField('clip-volume', '', Math.round(doc.clip_volume * 100), t('workbench.vt.clip_volume')) + vtBtn('vt-volume', t('workbench.vt.save')) + '</p>'
      + '<p><button type="button" class="btn-primary" data-wb-act="vt-render"' + (WB.vtBusy || WB.vtRender || archived() || !doc.clips.length ? ' disabled' : '') + '>'
      + esc(WB.vtRender ? t('workbench.vt.rendering') : t('workbench.vt.render')) + '</button></p>'
      + (last ? '<p class="wb-muted">' + esc(t(last.current ? 'workbench.vt.last_current' : 'workbench.vt.last_old')) + '</p>'
        + '<video controls preload="metadata" style="max-width:100%" src="' + escA(last.url) + '"></video>' : '')
      + '</div>'
  }

  // ---- presentation deck (v4 spec phase 5) ------------------------------------
  //
  // Every slide is a canvas, so the slide editor IS the canvas editor: the picked
  // slide's canvas is put into `WB.canvas`, and the canvas operations, undo, version
  // and drag handles are redirected to the deck routes (`deckMode()`). The deck
  // routes wrap the operations as {op:"slide", id, ops}.

  function isDeckItem() {
    return !!(WB.detail && WB.detail.item && WB.detail.item.type === 'presentation')
  }
  function deckMode() { return isDeckItem() && !!(WB.deck && WB.deck.deck) }

  function deckUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/deck' + (tail || '')
  }

  function deckSlides() { return (WB.deck && WB.deck.deck && WB.deck.deck.slides) || [] }
  function deckCurrentSlide() {
    var list = deckSlides()
    for (var i = 0; i < list.length; i += 1) if (list[i].id === WB.deckSlide) return list[i]
    return list[0] || null
  }

  function deckSlideUrl(slideId) {
    return deckUrl('/slide/' + encodeURIComponent(slideId) + '.svg')
      + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
  }

  /** Puts the picked slide's canvas where the canvas editor reads it. */
  function deckSyncCanvas() {
    var s = deckCurrentSlide()
    if (!s) { WB.canvas = null; return }
    WB.deckSlide = s.id
    var d = WB.deck
    WB.canvas = {
      canvas: s.canvas, exists: true, rel: d.rel, name: d.name, version_id: d.version_id, version_no: d.version_no,
      current: d.current !== false, draft: d.draft, history: d.history, orphans: [], platforms: null,
    }
    bumpCanvasStamp()
    WB.brandCheck = null
    ensureBrand()
  }

  function loadDeck(itemId) {
    WB.deckError = null
    return api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/deck').then(function (r) {
      if (WB.selectedId !== itemId) return
      if (!r.ok) {
        WB.deck = null
        WB.canvas = null
        WB.deckError = { message: r.message, detail: (r.data && r.data.detail) || '' }
      } else if (r.data && r.data.deck) {
        WB.deck = r.data
        deckSyncCanvas()
      }
      render()
    })
  }

  function deckTake(d) {
    var old = WB.deck || {}
    WB.deck = Object.assign({}, old, {
      deck: d.deck || old.deck, exists: true, rel: d.rel || old.rel, name: d.name || old.name,
      version_id: d.version ? d.version.id : old.version_id, version_no: d.version ? d.version.version_no : old.version_no,
      summary: d.summary || old.summary,
      draft: 'draft' in d ? d.draft : old.draft, history: 'history' in d ? d.history : old.history,
      orphans: 'orphans' in d ? d.orphans : old.orphans, current: true,
    })
    if (WB.detail && d.item) WB.detail.item = d.item
    if (WB.detail && d.versions) WB.detail.versions = d.versions
    deckSyncCanvas()
  }

  /** A batch of deck operations: the same route the agent uses. `WB.canvasBusy` is the one busy flag (the drag handles read it). */
  function deckOps(ops, then) {
    if (!WB.selectedId || WB.canvasBusy || archived()) return
    WB.canvasBusy = true
    render()
    api('POST', deckUrl('/ops'), { ops: ops }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { WB.deckError = { message: r.message, detail: (r.data && r.data.detail) || '' }; render(); return }
      WB.deckError = null
      WB.canvasEdit = null
      deckTake(r.data)
      if (r.data.created) window.showToast(r.data.message || t('workbench.deck.saved'))
      if (then) then(r.data)
      render()
    })
  }

  /** What the canvas editor sends for the picked slide. */
  function deckSlideOps(ops) {
    var s = deckCurrentSlide()
    if (s) deckOps([{ op: 'slide', id: s.id, ops: ops }])
  }

  function deckStep(dir) {
    var h = WB.deck && WB.deck.history
    if (!WB.selectedId || WB.canvasBusy || archived() || !h || !(dir === 'undo' ? h.can_undo : h.can_redo)) return
    WB.canvasBusy = true
    render()
    api('POST', deckUrl('/' + dir), {}).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        loadDeck(WB.selectedId)
        return
      }
      WB.canvasEdit = null
      deckTake(r.data)
      window.showToast(t(dir === 'undo' ? 'workbench.deck.undone' : 'workbench.deck.redone'))
      render()
    })
  }

  function deckSaveVersion() {
    if (!WB.selectedId || WB.canvasBusy || archived()) return
    var label = typeof window.prompt === 'function' ? window.prompt(t('workbench.canvas.version_prompt'), '') : ''
    if (label === null) return
    WB.canvasBusy = true
    render()
    api('POST', deckUrl('/version'), { label: label || '', reason: 'manual' }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      deckTake(r.data)
      window.showToast(r.data.message || t('workbench.deck.version_saved'))
      render()
    })
  }

  function deckExportNow(format) {
    if (!WB.selectedId || WB.canvasBusy || WB.deckExporting || archived()) return
    WB.deckExporting = format
    WB.deckError = null
    render()
    api('POST', deckUrl('/export'), { format: format }).then(function (r) {
      WB.deckExporting = null
      if (!r.ok) { WB.deckError = { message: r.message, detail: (r.data && r.data.detail) || '' }; render(); return }
      WB.deckExported = { name: r.data.file.name, rel: r.data.file.rel, url: r.data.url, format: r.data.format, warnings: r.data.warnings || [] }
      deckTake(r.data)
      window.showToast(r.data.message || t('workbench.deck.exported'))
      render()
    })
  }

  function deckSelectSlide(id) {
    WB.deckSlide = id
    WB.canvasEdit = null
    WB.canvasSel = null
    WB.canvasPick = {}
    deckSyncCanvas()
    render()
  }

  function deckAddSlide() {
    var sel = document.getElementById('wbDeckLayout')
    var layout = sel && sel.value ? sel.value : 'content'
    var cur = deckCurrentSlide()
    var at = cur ? deckSlides().indexOf(cur) + 2 : 1
    deckOps([{ op: 'addSlide', layout: layout, at: at, title: t('workbench.deck.new_title'), body: layout === 'title' ? t('workbench.deck.new_subtitle') : t('workbench.deck.new_body') }], function (d) {
      var ap = (d.applied || [])[0]
      if (ap && ap.id) { WB.deckSlide = ap.id; deckSyncCanvas() }
    })
  }

  function deckMoveSlide(id, delta) {
    var list = deckSlides()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) { deckOps([{ op: 'moveSlide', id: id, to: i + 1 + delta }]); return }
    }
  }

  function deckRemoveSlide(id) {
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.deck.remove_confirm'))) return
    deckOps([{ op: 'removeSlide', id: id }])
  }

  function deckSaveNotes() {
    var s = deckCurrentSlide()
    var el = document.getElementById('wbDeckNotes')
    if (!s || !el) return
    deckOps([{ op: 'setNotes', id: s.id, notes: String(el.value) }])
  }

  function deckBtn(act, label, id, extra) {
    return '<button type="button" class="wb-btn" data-wb-act="' + act + '"' + (id ? ' data-wb-id="' + escA(id) + '"' : '')
      + (extra || '') + (WB.canvasBusy || WB.deckExporting || archived() ? ' disabled' : '') + '>' + esc(label) + '</button> '
  }

  /** Egy nevjegykartya ket oldala: Elol / Hatul; minden mas dasorban a sorszam. */
  function deckIsCard() {
    var d = WB.deck && WB.deck.deck
    return !!(d && typeof d.size === 'string' && d.size.indexOf('card-') === 0)
  }
  function deckPageLabel(i) {
    if (deckIsCard() && i < 2) return t(i === 0 ? 'workbench.card.front' : 'workbench.card.back')
    return String(i + 1)
  }

  function deckSizeLabel(a) {
    return a.indexOf('card-') === 0 ? t('workbench.card.size.' + a) : a
  }

  function deckStripHtml() {
    var list = deckSlides()
    var cur = deckCurrentSlide()
    return '<div class="wb-deck-strip">' + list.map(function (s, i) {
      var on = cur && s.id === cur.id
      return '<div class="wb-deck-thumb' + (on ? ' wb-deck-thumb-on' : '') + '">'
        + '<button type="button" class="wb-deck-pick" data-wb-act="deck-pick" data-wb-id="' + escA(s.id) + '" aria-label="' + escA(t('workbench.deck.slide_n', { n: i + 1 })) + '"'
        + (on ? ' aria-current="true"' : '') + '>'
        + '<img loading="lazy" alt="' + escA(t('workbench.deck.slide_n', { n: i + 1 })) + '" src="' + escA(deckSlideUrl(s.id)) + '"></button>'
        + '<span class="wb-muted">' + esc(deckPageLabel(i)) + '</span>'
        + (on && !archived()
          ? '<span class="wb-deck-thumb-actions">'
            + deckBtn('deck-up', '↑', s.id, i === 0 ? ' disabled' : '') + deckBtn('deck-down', '↓', s.id, i === list.length - 1 ? ' disabled' : '')
            + deckBtn('deck-dup', t('workbench.deck.duplicate'), s.id) + deckBtn('deck-del', t('workbench.deck.remove'), s.id) + '</span>'
          : '')
        + '</div>'
    }).join('') + '</div>'
  }

  function deckHtml() {
    if (!isDeckItem()) return ''
    var headOf = function (extra) {
      return '<div class="wb-can"><div class="wb-can-head"><h4>' + esc(t('workbench.deck.title')) + '</h4>' + (extra || '') + '</div>'
    }
    if (WB.deckError && !WB.deck) {
      return headOf() + '<p class="wb-preview-bad">' + esc(WB.deckError.message || '') + '</p>'
        + (WB.deckError.detail ? '<p class="wb-hint">' + esc(WB.deckError.detail) + '</p>' : '')
        + '<p>' + deckBtn('deck-refresh', t('workbench.canvas.refresh')) + '</p></div>'
    }
    if (!WB.deck || !WB.deck.deck) return headOf() + '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    var doc = WB.deck.deck
    var sizes = ((WB.deck.limits && WB.deck.limits.sizes) || ['16:9', '4:3']).map(function (a) {
      return '<button type="button" class="wb-btn' + (doc.size === a ? ' wb-on' : '') + '" data-wb-act="deck-size" data-wb-v="' + escA(a) + '"'
        + (WB.canvasBusy || archived() ? ' disabled' : '') + '>' + esc(deckSizeLabel(a)) + '</button>'
    }).join(' ')
    var layouts = ['title', 'content', 'blank'].map(function (l) {
      return '<option value="' + l + '">' + esc(t('workbench.deck.layout_' + l)) + '</option>'
    }).join('')
    var err = WB.deckError
      ? '<p class="wb-preview-bad">' + esc(WB.deckError.message || '') + '</p>' + (WB.deckError.detail ? '<p class="wb-hint">' + esc(WB.deckError.detail) + '</p>' : '')
      : ''
    var out = headOf('<span class="wb-muted">' + esc(t('workbench.deck.count', { n: doc.slides.length })) + '</span>')
      + '<p class="wb-hint">' + esc(t('workbench.deck.intro')) + '</p>' + err
      + (doc.slides.length ? canvasToolsHtml() : '')
      + '<p>' + sizes + ' <select class="wb-input" id="wbDeckLayout" aria-label="' + escA(t('workbench.deck.layout')) + '">' + layouts + '</select> '
      + deckBtn('deck-add', t('workbench.deck.add')) + '</p>'
    if (!doc.slides.length) {
      return out + '<div class="wb-empty"><p class="wb-empty-title">' + esc(t('workbench.deck.none_title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.deck.none_hint')) + '</p></div></div>'
    }
    var cur = deckCurrentSlide()
    var objects = canvasObjects()
    out += deckStripHtml()
      + canvasStageHtml(t('workbench.deck.slide_n', { n: deckSlides().indexOf(cur) + 1 }), false, true)
      + '<p class="wb-hint">' + esc(t('workbench.canvas.intro')) + '</p>'
      + (archived() ? '' : canvasAddHtml())
      + (archived() || !objects.length ? '' : canvasPickBarHtml())
      + (objects.length ? '<ul class="wb-can-objs">' + objects.map(canvasObjectHtml).join('') + '</ul>' : '<p class="wb-muted">' + esc(t('workbench.canvas.empty')) + '</p>')
      + '<h5>' + esc(t('workbench.deck.notes')) + '</h5>'
      + '<p><textarea class="wb-input" id="wbDeckNotes" rows="3" style="width:100%" ' + (archived() ? 'disabled' : '') + ' placeholder="' + escA(t('workbench.deck.notes_placeholder')) + '">' + esc(cur.notes || '') + '</textarea></p>'
      + '<p>' + deckBtn('deck-notes', t('workbench.deck.notes_save')) + '</p>'
      + '<h5>' + esc(t('workbench.deck.export')) + '</h5>'
      + '<p>' + deckBtn('deck-export', WB.deckExporting === 'pptx' ? t('workbench.deck.exporting') : t('workbench.deck.export_pptx'), '', ' data-wb-v="pptx"')
      + deckBtn('deck-export', WB.deckExporting === 'pdf' ? t('workbench.deck.exporting') : t('workbench.deck.export_pdf'), '', ' data-wb-v="pdf"') + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.deck.export_hint')) + '</p>'
    var ex = WB.deckExported
    if (ex) {
      out += '<p class="wb-muted">' + esc(t('workbench.deck.exported_file', { name: ex.name })) + ' <a href="' + escA(ex.url) + '" target="_blank" rel="noopener">' + esc(t('workbench.preview.open_new_tab')) + '</a></p>'
        + (ex.warnings.length ? '<ul class="wb-hint">' + ex.warnings.map(function (w) { return '<li>' + esc(w) + '</li>' }).join('') + '</ul>' : '')
    }
    return out + '</div>'
  }

  function canvasHtml() {
    var it = WB.detail && WB.detail.item
    if (!it) return ''
    if (isDeckItem()) return ''
    var isCanvas = !!(WB.canvas && WB.canvas.exists) || (WB.preview && WB.preview.kind === 'canvas')
    // Nem rajz-fajta munkadarabnal es rajz nelkul nincs mit mutatni -- ne
    // alljon ott egy ures doboz.
    if (!canvasKind(it) && !isCanvas) return ''
    var head = '<div class="wb-can-head"><h4>' + esc(t('workbench.canvas.title')) + '</h4>'
      + (WB.canvas && WB.canvas.canvas
        ? '<span class="wb-muted">' + esc(t('workbench.canvas.size', { w: WB.canvas.canvas.width, h: WB.canvas.canvas.height })) + '</span>'
        : '')
      + '</div>'
    if (WB.canvasError) {
      return '<div class="wb-can">' + head
        + '<p class="wb-preview-bad">' + esc(WB.canvasError.message || '') + '</p>'
        + (WB.canvasError.detail ? '<p class="wb-hint">' + esc(WB.canvasError.detail) + '</p>' : '')
        + '<p><button type="button" class="wb-btn" data-wb-act="canvas-refresh">' + esc(t('workbench.canvas.refresh')) + '</button></p>'
        + '</div>'
    }
    if (WB.canvas === null) {
      return '<div class="wb-can">' + head + '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    }
    if (!WB.canvas.exists) {
      // MEG NINCS RAJZ. Ez kezdoallapot, nem hiba -- es van belole ut tovabb.
      return '<div class="wb-can">' + head
        + canvasOrphansHtml()
        + '<div class="wb-empty">'
        + '<p class="wb-empty-title">' + esc(t('workbench.canvas.none_title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.canvas.none_hint')) + '</p>'
        + '<p><button type="button" class="btn-primary" data-wb-act="canvas-start"' + (WB.canvasBusy || archived() ? ' disabled' : '') + '>'
        + esc(WB.canvasBusy ? t('workbench.canvas.starting') : t('workbench.canvas.start')) + '</button></p>'
        + '</div></div>'
    }
    var objects = canvasObjects()
    return '<div class="wb-can">' + head
      + canvasToolsHtml()
      + canvasOrphansHtml()
      + canvasPlatformHtml()
      + canvasAiNoticeHtml()
      + '<p class="wb-hint">' + esc(t('workbench.canvas.intro')) + '</p>'
      + (archived() ? '' : canvasAddHtml())
      + (archived() || !objects.length ? '' : canvasPickBarHtml())
      + (objects.length
        ? '<ul class="wb-can-objs">' + objects.map(canvasObjectHtml).join('') + '</ul>'
        : '<p class="wb-muted">' + esc(t('workbench.canvas.empty')) + '</p>')
      + '<p class="wb-hint"><a href="' + escA(canvasSvgUrl(it.id, true)) + '" target="_blank" rel="noopener">'
      + esc(t('workbench.canvas.download')) + '</a></p>'
      + '</div>'
  }

  /** Munkadarab-valto a szerkeszto tetejen (#359, Boss 1249): a munkadarabok
   *  kozott innen is valtani lehet, akkor is, ha a lista nem latszik (mobilon
   *  egyszerre egy panel van kint, es a kattintas ide, a kozepso panelre visz). */
  function switcherHtml() {
    var items = WB.items || []
    if (items.length < 2) return ''
    var idx = -1
    for (var i = 0; i < items.length; i++) if (items[i].id === WB.selectedId) idx = i
    var opts = (idx < 0 ? '<option value="" selected>' + esc(t('workbench.switch.choose')) + '</option>' : '')
      + items.map(function (it, j) {
        return '<option value="' + escA(it.id) + '"' + (j === idx ? ' selected' : '') + '>' + esc((workSeqText(it) ? workSeqText(it) + ' · ' : '') + it.title) + '</option>'
      }).join('')
    var prev = idx > 0 ? items[idx - 1].id : ''
    var next = idx >= 0 && idx < items.length - 1 ? items[idx + 1].id : (idx < 0 ? items[0].id : '')
    return '<div class="wb-switch">'
      + '<button type="button" class="btn-secondary btn-compact" data-wb-item="' + escA(prev) + '"' + (prev ? '' : ' disabled')
      + ' title="' + escA(t('workbench.switch.prev')) + '" aria-label="' + escA(t('workbench.switch.prev')) + '">‹</button>'
      + '<label class="wb-switch-label" for="wbSwitch">' + esc(t('workbench.switch.label')) + '</label>'
      + '<select class="wb-input wb-switch-select" id="wbSwitch">' + opts + '</select>'
      + '<button type="button" class="btn-secondary btn-compact" data-wb-item="' + escA(next) + '"' + (next ? '' : ' disabled')
      + ' title="' + escA(t('workbench.switch.next')) + '" aria-label="' + escA(t('workbench.switch.next')) + '">›</button>'
      + '</div>'
  }

  /** Osztott nezetben a jobb oldal akkor sem ures, ha meg nincs kivalasztva
   *  semmi: a munkadarabok egy kattintasra ott vannak, es uj is indithato. */
  function splitPickHtml() {
    var items = WB.items || []
    var list = items.length
      ? '<ul class="wb-split-pick">' + items.slice(0, 8).map(function (it) {
        return '<li><button type="button" class="wb-item" data-wb-item="' + escA(it.id) + '">'
          + '<span class="wb-item-title">' + workSeqHtml(it) + esc(it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
          + '</button></li>'
      }).join('') + '</ul>'
      : ''
    var more = items.length > 8 ? '<p class="wb-hint">' + esc(t('workbench.split.more', { n: items.length - 8 })) + '</p>' : ''
    var add = archived() ? '' : '<p><button type="button" class="btn-secondary" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button></p>'
    return list + more + add
  }

  // ---- verziok egymas mellett + egygombos visszavonas (#406, 5. pont) --------
  //
  // VISSZAVONAS: a mostani elotti verzio allapota lesz UJ verziokent (a
  // visszaallitas nem torol semmit, ezert nem kell megerositeni -- ez a szakmai
  // gyakorlat: a visszavonhato lepes nem kerdez). A "visszavonas visszavonasa"
  // ugyanez: a lista legfelso verzioja ott marad.
  //
  // OSSZEHASONLITAS: ket verzio egymas mellett. Kepnel/rajznal egy csuszka
  // huzza szet a ket kepet (elotte / utana); szovegnel a torolt es az uj szavak
  // kiemelve. Telefonon a ket oszlop egymas ala kerul, a csuszka ujjal is megy.

  function versionsSorted() {
    var list = ((WB.detail && WB.detail.versions) || []).slice()
    list.sort(function (a, b) { return b.version_no - a.version_no })
    return list
  }

  function currentVersion() {
    var it = WB.detail && WB.detail.item
    var found = null
    versionsSorted().forEach(function (v) { if (it && v.id === it.current_version_id) found = v })
    return found
  }

  /** A mostani ELOTTI verzio (sorszam szerint) -- a visszavonas celja. */
  function undoTarget() {
    var cur = currentVersion()
    if (!cur) return null
    var best = null
    versionsSorted().forEach(function (v) {
      if (v.version_no < cur.version_no && (!best || v.version_no > best.version_no)) best = v
    })
    return best
  }

  function versionBarHtml() {
    var versions = versionsSorted()
    if (versions.length < 2) return ''
    var target = undoTarget()
    var ro = archived() || WB.versionBusy
    return '<div class="wb-vbar">'
      + (ro || !target ? '' : '<button type="button" class="btn-secondary btn-compact" data-wb-act="version-undo"'
        + ' title="' + escA(t('workbench.cmp.undo_hint', { n: target.version_no })) + '">'
        + esc(t('workbench.cmp.undo', { n: target.version_no })) + '</button>')
      + (WB.compare && WB.compare.itemId === WB.selectedId
        ? '<button type="button" class="btn-secondary btn-compact" data-wb-act="compare-close">' + esc(t('workbench.cmp.close')) + '</button>'
        : '<button type="button" class="btn-secondary btn-compact" data-wb-act="compare-open">' + esc(t('workbench.cmp.open')) + '</button>')
      + '</div>'
  }

  // The export button sits at the END of the panel (owner, TG 1925): the
  // material comes first, exporting / sending is what you do once it is done.
  function exportBarHtml() {
    var exportBtn = '<button type="button" class="btn-secondary btn-compact" data-wb-act="' + (exportIsOpen() ? 'export-close' : 'export-open') + '"'
      + ' aria-expanded="' + exportIsOpen() + '">' + esc(t('workbench.exp.open')) + '</button>'
    return '<div class="wb-vbar">' + exportBtn + '</div>' + (exportIsOpen() ? exportPanelHtml() : '')
  }

  // ---- export PDF / kep + kuldes a jovahagyasi kapun at (#406, 6. pont) -----
  //
  // PDF: a munkadarab nyomtathato lapja uj lapon nyilik, es a bongeszo
  // "Mentes PDF-kent" utja keszit belole PDF-et -- kulso program nelkul,
  // telefonon is (Megosztas -> Nyomtatas). KEP: a bongeszo rajzolja PNG-be.
  // KULDES: a Munkapad SOHA nem kuld ki semmit maga; a gomb a meglevo
  // jovahagyasi kapun at jegyet nyit, es kifele csak a tulajdonos igen-je
  // utan megy barmi (a fo agens kuldi).

  function exportIsOpen() { return !!(WB.exportOpen && WB.exportOpen === WB.selectedId) }

  function itemUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + tail
  }

  function exportPageUrl(extra) {
    return itemUrl('/export.html') + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
      + (extra || '')
  }

  /** Mibol lehet kepet (PNG) csinalni: a kep maga, a rajz, vagy a reszek. */
  function pngSource() {
    var p = WB.preview
    if (!p) return null
    if (p.available && p.kind === 'image') return 'image'
    if (p.kind === 'canvas') return 'canvas'
    if (p.available && (p.kind === 'parts' || p.kind === 'text')) return 'blocks'
    if (!p.available && p.reason === 'no_source' && partsOf().length) return 'blocks'
    return null
  }

  function exportPanelHtml() {
    var p = WB.preview || {}
    var png = pngSource()
    var rows = []
    rows.push('<div class="wb-exp-row"><button type="button" class="btn-primary" data-wb-act="export-print">' + esc(t('workbench.exp.pdf')) + '</button>'
      + '<span class="wb-hint">' + esc(t('workbench.exp.pdf_hint')) + '</span></div>')
    if (p.kind === 'office' && p.url) {
      rows.push('<div class="wb-exp-row"><a class="btn-secondary" href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">' + esc(t('workbench.exp.office_pdf')) + '</a></div>')
    }
    rows.push('<div class="wb-exp-row wb-exp-docs"><span class="wb-hint">' + esc(t('workbench.exp.docs')) + '</span> '
      + ['docx', 'odt', 'doc', 'rtf', 'txt', 'epub'].map(function (f) {
        return '<button type="button" class="btn-secondary" data-wb-act="export-doc" data-wb-fmt="' + f + '"'
          + (WB.docBusy ? ' disabled' : '') + '>' + esc(WB.docBusy === f ? t('workbench.exp.doc_busy') : t('workbench.exp.doc_' + f)) + '</button>'
      }).join('') + '</div>')
    rows.push('<div class="wb-exp-row">'
      + (png ? '<button type="button" class="btn-secondary" data-wb-act="export-png"' + (WB.pngBusy ? ' disabled' : '') + '>'
        + esc(WB.pngBusy ? t('workbench.exp.png_busy') : t('workbench.exp.png')) + '</button>' : '')
      + '<a class="btn-secondary" href="' + escA(exportPageUrl('&download=1')) + '" download>' + esc(t('workbench.exp.html')) + '</a>'
      + (p.rel ? '<a class="btn-secondary" href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
        + esc(t('workbench.exp.source')) + '</a>' : '')
      + '</div>')
    if (!png) rows.push('<p class="wb-hint">' + esc(t('workbench.exp.png_none')) + '</p>')
    return '<div class="wb-exp" role="region" aria-label="' + escA(t('workbench.exp.open')) + '">'
      + '<h4 class="wb-exp-title">' + esc(t('workbench.exp.title')) + '</h4>'
      + rows.join('')
      + sendHtml()
      + shareBoxHtml('item')
      + '</div>'
  }

  function sendState() {
    var st = WB.send
    return st && st.itemId === WB.selectedId ? st : null
  }

  function sendHtml() {
    var st = sendState()
    var head = '<h4 class="wb-exp-title">' + esc(t('workbench.exp.send_title')) + '</h4>'
      + '<p class="wb-hint">' + esc(t('workbench.exp.send_gate')) + '</p>'
    if (st && st.result && st.result.status === 'sent') {
      // A tulajdonos kattintasa azonnal kiment: a Gmail-azonosito a bizonyitek.
      return head + '<div class="wb-exp-sent wb-exp-sent-sent">'
        + '<p>' + esc(t('workbench.exp.send_status.sent', { id: st.result.message_id || '' })) + '</p>'
        + '<p><button type="button" class="wb-linklike" data-wb-act="send-new">' + esc(t('workbench.exp.send_new')) + '</button></p>'
        + '</div>'
    }
    if (st && st.result) {
      var status = st.result.status || 'pending'
      return head + '<div class="wb-exp-sent wb-exp-sent-' + escA(status) + '">'
        + '<p>' + esc(t('workbench.exp.send_status.' + (['pending', 'approved', 'rejected', 'timeout', 'withdrawn'].indexOf(status) >= 0 ? status : 'other'), { status: status })) + '</p>'
        + (st.statusError ? '<p class="wb-preview-bad">' + esc(t('workbench.exp.send_status_unknown', { message: st.statusError })) + '</p>' : '')
        + '<p><button type="button" class="btn-secondary btn-compact" data-wb-act="send-refresh">' + esc(t('workbench.exp.send_refresh')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.ov.goto_approvals')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="send-new">' + esc(t('workbench.exp.send_new')) + '</button></p>'
        + '</div>'
    }
    if (archived()) return head + '<p class="wb-muted">' + esc(t('workbench.archived_hint')) + '</p>'
    var p = WB.preview || {}
    var d = (st && st.draft) || {}
    var busy = st && st.busy
    return head + '<form class="wb-form wb-exp-send" id="wbSendForm">'
      + '<label class="wb-label" for="wbSendTo">' + esc(t('workbench.exp.send_to')) + '</label>'
      + '<input class="wb-input" id="wbSendTo" type="email" inputmode="email" autocomplete="email" placeholder="' + escA(t('workbench.exp.send_to_ph')) + '" value="' + escA(d.to || '') + '">'
      + '<label class="wb-label" for="wbSendSubject">' + esc(t('workbench.exp.send_subject')) + '</label>'
      + '<input class="wb-input" id="wbSendSubject" type="text" maxlength="200" value="' + escA(d.subject != null ? d.subject : ((WB.detail && WB.detail.item && WB.detail.item.title) || '')) + '">'
      + '<label class="wb-label" for="wbSendMessage">' + esc(t('workbench.exp.send_message')) + '</label>'
      + '<textarea class="wb-input" id="wbSendMessage" rows="3" maxlength="5000">' + esc(d.message || '') + '</textarea>'
      + '<label class="wb-label" for="wbSendAttach">' + esc(t('workbench.exp.send_attach')) + '</label>'
      + '<select class="wb-input" id="wbSendAttach">'
      + '<option value="html"' + (d.attachment !== 'source' ? ' selected' : '') + '>' + esc(t('workbench.exp.attach_html')) + '</option>'
      + (p.rel ? '<option value="source"' + (d.attachment === 'source' ? ' selected' : '') + '>' + esc(t('workbench.exp.attach_source', { name: p.name || '' })) + '</option>' : '')
      + '</select>'
      + (st && st.error ? '<p class="wb-preview-bad">' + esc(st.error) + '</p>' : '')
      + '<div class="wb-form-actions"><button type="submit" class="btn-primary" data-wb-act="send-request"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.exp.send_busy') : t('workbench.exp.send_submit')) + '</button></div>'
      + '</form>'
  }

  function fieldVal(id) {
    var el = document.getElementById(id)
    return el && typeof el.value === 'string' ? el.value : ''
  }

  function readSendDraft() {
    return {
      to: fieldVal('wbSendTo').trim(),
      subject: fieldVal('wbSendSubject'),
      message: fieldVal('wbSendMessage'),
      attachment: fieldVal('wbSendAttach') || 'html',
    }
  }

  function sendRequest() {
    if (!WB.selectedId || archived()) return
    var cur = sendState()
    if (cur && cur.busy) return
    var itemId = WB.selectedId
    var draft = readSendDraft()
    if (!draft.to) {
      WB.send = { itemId: itemId, draft: draft, error: t('workbench.exp.send_to_missing') }
      render()
      return
    }
    WB.send = { itemId: itemId, draft: draft, busy: true }
    render()
    api('POST', itemUrl('/send-request'), {
      to: draft.to, subject: draft.subject, message: draft.message, attachment: draft.attachment,
      version: WB.previewVersion || null,
    }).then(function (r) {
      if (!WB.send || WB.send.itemId !== itemId) return
      if (!r.ok) {
        WB.send = { itemId: itemId, draft: draft, error: r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : '') }
        render()
        return
      }
      var sent = r.data && r.data.status === 'sent'
      WB.send = { itemId: itemId, draft: draft, result: sent
        ? { status: 'sent', message_id: r.data.message_id || '' }
        : { approval_id: r.data.approval_id, status: r.data.status || 'pending' } }
      render()
      window.showToast((r.data && r.data.message) || t(sent ? 'workbench.exp.send_status.sent' : 'workbench.exp.send_status.pending', { id: sent ? (r.data.message_id || '') : '' }))
      load(WB.projectId)
    })
  }

  /** A jegy allapota a Jovahagyasok forrasabol -- sosem emlekezetbol. */
  function refreshSendStatus() {
    var st = sendState()
    if (!st || !st.result || !st.result.approval_id) return
    api('GET', '/api/approvals/' + encodeURIComponent(st.result.approval_id)).then(function (r) {
      if (WB.send !== st) return
      if (!r.ok) { st.statusError = r.message; render(); return }
      st.statusError = null
      var a = r.data && (r.data.approval || r.data)
      if (a && a.status) st.result.status = a.status
      render()
    })
  }

  function openPrint() {
    if (!WB.selectedId) return
    // Uj lap: ott a bongeszo sajat nyomtatasa (Mentes PDF-kent) megy, telefonon
    // is. Ha a felugro ablakot a bongeszo letiltja, a lap LINKKENT ott marad.
    var w = typeof window.open === 'function' ? window.open(exportPageUrl('&print=1'), '_blank', 'noopener') : null
    if (!w) window.showToast(t('workbench.exp.popup_blocked'))
  }

  function downloadBlob(blob, name) {
    if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a) }, 1000)
    return true
  }

  function loadImg(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image()
      im.onload = function () { resolve(im) }
      im.onerror = function () { reject(new Error(src)) }
      im.src = src
    })
  }

  function wrapLines(ctx, text, maxW) {
    var out = []
    String(text || '').split('\n').forEach(function (para) {
      var words = para.split(/\s+/)
      var line = ''
      words.forEach(function (w) {
        var test = line ? line + ' ' + w : w
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w } else line = test
      })
      out.push(line)
    })
    return out
  }

  /** A munkadarab kepe PNG-ben. A kep-fajtanal az eredeti fajl jon (nincs
   *  minosegromlas); a rajzot es a vegyes tartalmat a bongeszo rajzolja ki. */
  /** Download the printable page as a Word / LibreOffice / RTF / text / EPUB file. */
  function exportDoc(fmt) {
    if (WB.docBusy || !WB.selectedId) return
    WB.docBusy = fmt
    render()
    var finish = function (msg) { WB.docBusy = null; render(); window.showToast(msg) }
    fetch(itemUrl('/export-doc') + '?fmt=' + encodeURIComponent(fmt) + '&lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null }).then(function (d) {
          finish(t('workbench.exp.doc_failed', { message: (d && d.message) || t('workbench.err.http', { status: res.status }) }))
        })
      }
      var cd = res.headers.get('Content-Disposition') || ''
      var m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
      var name = 'munkadarab.' + fmt
      try { if (m) name = decodeURIComponent(m[1]) } catch (_e) { /* keep the fallback name */ }
      return res.blob().then(function (blob) {
        var a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(function () { URL.revokeObjectURL(a.href) }, 10000)
        finish(t('workbench.exp.doc_done', { name: name }))
      })
    }).catch(function () { finish(t('workbench.exp.doc_failed', { message: t('workbench.err.network') })) })
  }

  function exportPng() {
    var src = pngSource()
    if (!src || WB.pngBusy || !WB.detail) return
    var title = (WB.detail.item && WB.detail.item.title) || 'munkadarab'
    var p = WB.preview
    if (src === 'image') {
      window.open('/api/life/file?rel=' + encodeURIComponent(p.rel) + '&download=1', '_blank', 'noopener')
      return
    }
    WB.pngBusy = true
    render()
    var done = function (ok, msg) {
      WB.pngBusy = false
      render()
      window.showToast(ok ? t('workbench.exp.png_done') : t('workbench.exp.png_failed', { message: msg || '' }))
    }
    var width = 1080
    var pad = 48
    var blocks
    if (src === 'canvas') {
      blocks = [{ img: canvasSvgUrl(WB.selectedId, false) }]
    } else if (p && p.available && p.kind === 'text') {
      blocks = [{ text: p.text || '' }]
    } else {
      blocks = partsOf().map(function (x) { return x.kind === 'image' ? { img: partImageSrc(x), caption: x.caption } : { text: x.text || '' } })
    }
    Promise.all(blocks.map(function (b) { return b.img ? loadImg(b.img).then(function (im) { b.el = im; return b }) : Promise.resolve(b) })).then(function () {
      var cv = document.createElement('canvas')
      var ctx = cv.getContext('2d')
      ctx.font = '32px sans-serif'
      var inner = width - pad * 2
      var h = pad
      blocks.forEach(function (b) {
        if (b.el) { b.h = Math.round(b.el.naturalHeight * Math.min(1, inner / (b.el.naturalWidth || inner))); b.w = Math.round(b.el.naturalWidth * (b.h / (b.el.naturalHeight || 1))); h += b.h + (b.caption ? 44 : 0) + 24 }
        else { b.lines = wrapLines(ctx, b.text, inner); h += b.lines.length * 44 + 24 }
      })
      cv.width = width
      cv.height = Math.max(h + pad - 24, 200)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.fillStyle = '#111111'
      ctx.font = '32px sans-serif'
      ctx.textBaseline = 'top'
      var y = pad
      blocks.forEach(function (b) {
        if (b.el) {
          ctx.drawImage(b.el, pad + Math.round((inner - b.w) / 2), y, b.w, b.h)
          y += b.h
          if (b.caption) { ctx.font = 'italic 28px sans-serif'; ctx.fillText(b.caption, pad, y + 8); ctx.font = '32px sans-serif'; y += 44 }
        } else {
          b.lines.forEach(function (ln) { ctx.fillText(ln, pad, y); y += 44 })
        }
        y += 24
      })
      cv.toBlob(function (blob) {
        done(downloadBlob(blob, title.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.png'))
      }, 'image/png')
    }).catch(function (e) { done(false, e && e.message) })
  }

  function undoVersion() {
    var target = undoTarget()
    if (!target || !WB.selectedId || WB.versionBusy || archived()) return
    var cur = currentVersion()
    WB.versionBusy = true
    render()
    api('POST', versionsUrl('/' + encodeURIComponent(target.id) + '/restore'), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (WB.compare) WB.compare = null
      applyVersions(r.data)
      window.showToast(t('workbench.cmp.undone', {
        from: cur ? cur.version_no : '', to: target.version_no,
        n: r.data && r.data.version ? r.data.version.version_no : '',
      }))
    })
  }

  function openCompare() {
    var versions = versionsSorted()
    if (versions.length < 2 || !WB.selectedId) return
    var right = currentVersion() || versions[0]
    var left = undoTarget() || versions[1]
    WB.compare = { itemId: WB.selectedId, left: left.id, right: right.id, pos: 50, sides: {} }
    render()
    loadCompareSide(left.id)
    loadCompareSide(right.id)
  }

  /** Egy verzio adata az osszehasonlitashoz: az elonezet (mit mutat) + a
   *  reszei. A ketto kulon keres: ha az egyik elbukik, azt KULON mondjuk. */
  function loadCompareSide(vid) {
    var cmp = WB.compare
    if (!cmp || !vid || cmp.sides[vid]) return
    var itemId = cmp.itemId
    var side = { preview: null, parts: null, error: null }
    cmp.sides[vid] = side
    var base = '/api/workbench/items/' + encodeURIComponent(itemId)
    var still = function () { return WB.compare === cmp && WB.selectedId === itemId }
    api('GET', base + '/preview?version=' + encodeURIComponent(vid)).then(function (r) {
      if (!still()) return
      if (r.ok) side.preview = r.data
      else side.error = r.message
      render()
    })
    api('GET', base + '/versions/' + encodeURIComponent(vid) + '/parts').then(function (r) {
      if (!still()) return
      if (r.ok) side.parts = (r.data && r.data.parts) || []
      else side.error = r.message
      render()
    })
  }

  function versionLabel(vid) {
    var found = null
    versionsSorted().forEach(function (v) { if (v.id === vid) found = v })
    return found ? t('workbench.versions.line', { n: found.version_no, when: when(found.created_at) }) : '-'
  }

  function compareSelectHtml(id, value) {
    return '<select class="wb-input wb-cmp-select" id="' + id + '">' + versionsSorted().map(function (v) {
      return '<option value="' + escA(v.id) + '"' + (v.id === value ? ' selected' : '') + '>'
        + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) })) + '</option>'
    }).join('') + '</select>'
  }

  /** Kep (vagy rajz) cime egy verziohoz; `null`, ha a verzio nem kep. */
  function compareImageUrl(side, vid) {
    var p = side && side.preview
    if (!p || !p.available) return null
    if (p.kind === 'image' && p.url) return p.url
    if (p.kind === 'canvas') {
      return '/api/workbench/items/' + encodeURIComponent(WB.compare.itemId) + '/canvas.svg?version='
        + encodeURIComponent(vid) + '&lang=' + encodeURIComponent(window._lang || 'hu')
    }
    return null
  }

  /** Szo-szintu kulonbseg (LCS). Tul hosszu szovegnel nem szamolunk (a
   *  bongeszo ne akadjon meg): akkor a ket szoveg kiemeles nelkul all. */
  function diffTokens(a, b) {
    var x = String(a || '').split(/(\s+)/)
    var y = String(b || '').split(/(\s+)/)
    if (x.length * y.length > 400000) return null
    var n = x.length
    var m = y.length
    var dp = []
    for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)) }
    for (var i2 = n - 1; i2 >= 0; i2--) {
      for (var j2 = m - 1; j2 >= 0; j2--) {
        dp[i2][j2] = x[i2] === y[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1])
      }
    }
    var left = []
    var right = []
    var p = 0
    var q = 0
    while (p < n && q < m) {
      if (x[p] === y[q]) { left.push(esc(x[p])); right.push(esc(y[q])); p++; q++ }
      else if (dp[p + 1][q] >= dp[p][q + 1]) { left.push(/^\s+$/.test(x[p]) ? esc(x[p]) : '<del class="wb-cmp-del">' + esc(x[p]) + '</del>'); p++ }
      else { right.push(/^\s+$/.test(y[q]) ? esc(y[q]) : '<ins class="wb-cmp-ins">' + esc(y[q]) + '</ins>'); q++ }
    }
    for (; p < n; p++) left.push(/^\s+$/.test(x[p]) ? esc(x[p]) : '<del class="wb-cmp-del">' + esc(x[p]) + '</del>')
    for (; q < m; q++) right.push(/^\s+$/.test(y[q]) ? esc(y[q]) : '<ins class="wb-cmp-ins">' + esc(y[q]) + '</ins>')
    return { left: left.join(''), right: right.join('') }
  }

  /** Egy verzio szoveges tartalma: a szoveg-reszek egymas utan, vagy a
   *  szovegfajl. `null` = nincs benne szoveg. */
  function compareText(side) {
    if (!side) return null
    var p = side.preview
    if (p && p.available && p.kind === 'text') return String(p.text || '')
    var texts = (side.parts || []).filter(function (x) { return x.kind === 'text' }).map(function (x) { return x.text || '' })
    return texts.length ? texts.join('\n\n') : null
  }

  function compareImagesOf(side) {
    return (side && side.parts ? side.parts : []).filter(function (x) { return x.kind === 'image' })
  }

  function compareBodyHtml() {
    var cmp = WB.compare
    var L = cmp.sides[cmp.left]
    var R = cmp.sides[cmp.right]
    var errors = [L, R].filter(function (sd) { return sd && sd.error }).map(function (sd) { return sd.error })
    if (errors.length) return '<p class="wb-preview-bad">' + esc(t('workbench.cmp.error', { message: errors[0] })) + '</p>'
    if (!L || !R || !L.preview || !R.preview || L.parts === null || R.parts === null) {
      return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    }
    if (cmp.left === cmp.right) return '<p class="wb-muted">' + esc(t('workbench.cmp.same')) + '</p>'
    var out = ''
    // KEP / RAJZ: csuszka. Alul az UJ (jobb), folotte a REGI (bal), a regi
    // annyira latszik, amennyire a csuszka all.
    var li = compareImageUrl(L, cmp.left)
    var ri = compareImageUrl(R, cmp.right)
    if (li && ri) {
      out += '<div class="wb-cmp-slide">'
        + '<img class="wb-cmp-img" src="' + escA(ri) + '" alt="' + escA(versionLabel(cmp.right)) + '">'
        + '<img class="wb-cmp-img wb-cmp-top" id="wbCmpTop" src="' + escA(li) + '" alt="' + escA(versionLabel(cmp.left)) + '"'
        + ' style="clip-path: inset(0 ' + (100 - cmp.pos) + '% 0 0)">'
        + '<div class="wb-cmp-line" id="wbCmpLine" style="left: ' + cmp.pos + '%"></div>'
        + '</div>'
        + '<label class="wb-label" for="wbCmpSlider">' + esc(t('workbench.cmp.slider')) + '</label>'
        + '<input type="range" class="wb-cmp-range" id="wbCmpSlider" min="0" max="100" step="1" value="' + cmp.pos + '">'
    }
    // SZOVEG: egymas mellett, a valtozas kiemelve.
    var lt = compareText(L)
    var rt = compareText(R)
    if (lt !== null || rt !== null) {
      var d = diffTokens(lt || '', rt || '')
      out += '<div class="wb-cmp-cols">'
        + '<div class="wb-cmp-col"><div class="wb-cmp-col-head">' + esc(t('workbench.cmp.before')) + ' — ' + esc(versionLabel(cmp.left)) + '</div>'
        + '<div class="wb-cmp-text">' + (d ? d.left : esc(lt || '')) + '</div></div>'
        + '<div class="wb-cmp-col"><div class="wb-cmp-col-head">' + esc(t('workbench.cmp.after')) + ' — ' + esc(versionLabel(cmp.right)) + '</div>'
        + '<div class="wb-cmp-text">' + (d ? d.right : esc(rt || '')) + '</div></div>'
        + '</div>'
        + (d ? '' : '<p class="wb-hint">' + esc(t('workbench.cmp.too_long')) + '</p>')
        + (lt === rt ? '<p class="wb-hint">' + esc(t('workbench.cmp.text_same')) + '</p>' : '')
    }
    // KEP-RESZEK egymas mellett (a vegyes munkadarab kepei).
    var lims = compareImagesOf(L)
    var rims = compareImagesOf(R)
    if (lims.length || rims.length) {
      var col = function (list) {
        return list.length ? list.map(function (x) {
          return '<img class="wb-cmp-thumb" src="' + escA(partImageSrc(x)) + '" alt="' + escA(x.caption || t('workbench.parts.image_alt')) + '">'
        }).join('') : '<p class="wb-muted">' + esc(t('workbench.cmp.no_images')) + '</p>'
      }
      out += '<div class="wb-cmp-cols">'
        + '<div class="wb-cmp-col">' + col(lims) + '</div>'
        + '<div class="wb-cmp-col">' + col(rims) + '</div></div>'
    }
    if (!out) {
      // Pl. PDF, video: itt nem tudjuk egymasra tenni, de mindkettot meg lehet nyitni.
      var link = function (sd) {
        var p = sd.preview
        var u = p && p.available && p.url ? p.url : (p && p.rel ? '/api/life/file?rel=' + encodeURIComponent(p.rel) : null)
        return u ? '<a href="' + escA(u) + '" target="_blank" rel="noopener">' + esc((p && p.name) || t('workbench.preview.open_new_tab')) + '</a>'
          : '<span class="wb-muted">' + esc((p && p.message) || t('workbench.preview.none')) + '</span>'
      }
      out = '<p class="wb-muted">' + esc(t('workbench.cmp.unsupported')) + '</p>'
        + '<div class="wb-cmp-cols"><div class="wb-cmp-col">' + link(L) + '</div><div class="wb-cmp-col">' + link(R) + '</div></div>'
    }
    return out
  }

  function compareHtml() {
    var cmp = WB.compare
    var ro = archived() || WB.versionBusy
    var cur = currentVersion()
    return '<div class="wb-cmp">'
      + '<div class="wb-cmp-head">'
      + '<div><label class="wb-label" for="wbCmpLeft">' + esc(t('workbench.cmp.before')) + '</label>' + compareSelectHtml('wbCmpLeft', cmp.left) + '</div>'
      + '<div><label class="wb-label" for="wbCmpRight">' + esc(t('workbench.cmp.after')) + '</label>' + compareSelectHtml('wbCmpRight', cmp.right) + '</div>'
      + '</div>'
      + compareBodyHtml()
      + (ro || (cur && cur.id === cmp.left) ? '' : '<p><button type="button" class="btn-secondary" data-wb-act="version-restore" data-wb-version="' + escA(cmp.left) + '">'
        + esc(t('workbench.cmp.restore_left')) + '</button></p>')
      + '</div>'
  }

  /** Melyik felulet a munkadarab fo felulete (K-3.3). */
  function surfaceOf(it) {
    if (!it) return 'parts'
    if (canvasKind(it) || (WB.canvas && WB.canvas.exists)) return 'canvas'
    if (it.type === 'document') return 'document'
    if (it.type === 'video') return 'player'
    if (it.type === 'composite') return 'post'
    return 'parts'
  }

  /** A belso tartalomreszek csak akkor technikai adat, ha a tartalmat mar egy
   *  masik felulet mutatja: a vaszon, egy fajl-elonezet vagy a vazlat. Egy
   *  jegyzetnel vagy egy meg ures munkadarabnal a reszlista MAGA a tartalom. */
  function partsAreTechnical(it) {
    if (!it || !partsOf().length) return false
    if (WB.canvas && WB.canvas.exists) return true
    var p = WB.preview
    if (p && p.available && p.kind !== 'parts') return true
    var o = WB.detail && WB.detail.outline
    return !!(o && (o.sections || []).length)
  }

  function partsTechHtml() {
    var open = !!WB.partsTechOpen
    var n = partsOf().length
    return '<div class="wb-parts-tech"><p class="wb-ctx-actions"><button type="button" class="wb-linklike" data-wb-act="parts-tech-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + '⋮ ' + esc(t('workbench.tech.parts', { n: n })) + '</button></p>'
      + (open ? '<p class="wb-hint">' + esc(t('workbench.tech.parts_hint')) + '</p>' + partsHtml() : '')
      + '</div>'
  }

  function editorPanelHtml() {
    var inner
    if (!WB.selectedId) {
      inner = '<p class="wb-muted wb-center">' + esc(t(WB.layout === 'split' ? 'workbench.split.none' : 'workbench.editor.none')) + '</p>'
        + (WB.layout === 'split' ? splitPickHtml() : '')
    } else if (!WB.detail) {
      inner = '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    } else {
      var it = WB.detail.item
      // A munkatipus szerinti felulet (K-3.3): rajznal a vaszon all elol,
      // dokumentumnal a vazlat es az elonezet, videonal a lejatszo. A belso
      // tartalomreszek (K-3.2) a "Technikai reszletek" ala kerulnek, ha mar
      // egy masik felulet mutatja a tartalmat -- torolve semmi nincs.
      var canvasFirst = surfaceOf(it) === 'canvas'
      inner = '<div class="wb-editor-head"><h3>' + workSeqHtml(it) + esc(it.title) + '</h3>'
        + '<span class="wb-pill">' + esc(typeLabel(it.type)) + '</span></div>'
        + versionBarHtml()
        + outlineHtml()
        + (WB.compare && WB.compare.itemId === WB.selectedId
          ? compareHtml()
          : (archived() ? '' : '<p class="wb-hint wb-drop-item-hint">' + esc(t(WB.upload
            ? 'workbench.upload.busy'
            : 'workbench.upload.drop_item')) + '</p>')
            + (canvasFirst ? canvasHtml() + previewHtml() : previewHtml() + canvasHtml())
            + videoTimelineHtml()
            + deckHtml()
            + (partsAreTechnical(it) ? partsTechHtml() : partsHtml())
            + postPreviewHtml())
        + deadlinesBoxHtml()
        + todosBoxHtml()
        + exportBarHtml()
        + approvalBoxHtml()
    }
    var dropAttr = WB.selectedId && WB.detail && !archived() ? ' data-wb-drop="item"' : ''
    return '<section class="wb-panel wb-panel-editor' + (WB.panel === 'editor' ? ' wb-panel-current' : '') + '" data-wb-panel-body="editor"' + dropAttr + '>'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.editor')) + '</h2>'
      + switcherHtml()
      + inner + '</section>'
  }

  // ---- dokumentummodell: vazlat, forrasok, hianyok (#441, 1/A) ------------

  var CLAIM_ICON = { verified: '📄✓', owner_confirmed: '🗣✓', owner_unconfirmed: '🗣', inference: '💭', unverified: '⚠' }

  function claimIcon(c) {
    if (c.strength === 'verified' && !(c.sources || []).some(function (s) { return s.kind === 'document' && s.verdict === 'verified' })) return '⚖✓'
    return CLAIM_ICON[c.strength] || '⚠'
  }

  function sourceLineHtml(s) {
    var what = s.kind === 'document' ? (s.path || '') + ':' + (s.page || '?') + (s.quote ? ' „' + s.quote + '”' : '')
      : s.kind === 'official' ? (s.citation || '') + (s.url ? ' (' + s.url + ')' : '')
      : s.kind === 'owner' ? '„' + (s.said || '') + '”' + (s.said_at ? ' (' + when(s.said_at) + ')' : '')
      : t('workbench.outline.src.inference_line')
    return '<li class="wb-outline-src wb-outline-src-' + escA(s.verdict) + '">'
      + '<span class="wb-pill">' + esc(t('workbench.outline.src.' + s.kind)) + '</span> '
      + esc(what) + (s.kind === 'inference' ? '' : ' <span class="wb-muted">' + esc(t('workbench.outline.verdict.' + s.verdict)) + '</span>')
      + (s.confirmed_at ? ' <span class="wb-muted">' + esc(t('workbench.outline.confirmed_at', { when: when(s.confirmed_at) })) + '</span>' : '')
      + '</li>'
  }

  function claimHtml(c, ro) {
    var needsConfirm = c.strength === 'owner_unconfirmed'
    return '<li class="wb-outline-claim wb-outline-claim-' + escA(c.strength) + '">'
      + '<span class="wb-outline-claim-icon" title="' + escA(t('workbench.outline.strength.' + c.strength)) + '">' + esc(claimIcon(c)) + '</span> '
      + '<span class="wb-outline-claim-text">' + esc(c.text) + '</span> '
      + '<span class="wb-muted">' + esc(t('workbench.outline.strength.' + c.strength)) + '</span>'
      + (needsConfirm && !ro ? ' <button type="button" class="wb-btn" data-wb-act="outline-claim-confirm" data-wb-claim="' + escA(c.id) + '">'
        + esc(t('workbench.outline.confirm')) + '</button>' : '')
      + '<ul class="wb-outline-srcs">' + (c.sources || []).map(sourceLineHtml).join('') + '</ul>'
      + '</li>'
  }

  /** A blokk szovege; a hiany-jelolesek kiemelve. */
  function blockTextHtml(text) {
    return esc(text).replace(/⚠\s*(Hiányzó adat|Forrás nem található|Missing data|Source not found)[^\n⚠]*/g, function (m) {
      return '<mark class="wb-outline-missing">' + m + '</mark>'
    }).replace(/\n/g, '<br>')
  }

  var SECTION_NEXT = { todo: 'in_progress', in_progress: 'done', done: 'todo' }

  /** ATIRASI JAVASLAT (#441, K-1.20): az agent javasol, a tulajdonos fogadja el vagy veti el. */
  var REWRITABLE = { paragraph: true, list: true, footnote: true }

  function rewriteHtml(b, ro) {
    var r = b.rewrite
    var drops = r.would_drop || []
    return '<div class="wb-outline-rewrite' + (r.stale ? ' wb-outline-rewrite-stale' : '') + '">'
      + '<p class="wb-outline-rewrite-head">' + esc(t('workbench.outline.rewrite_proposal.' + (r.style || 'other'))) + '</p>'
      + '<div class="wb-outline-text">' + blockTextHtml(r.text) + '</div>'
      + (r.stale ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.outline.rewrite_stale')) + '</p>' : '')
      + (drops.length ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.outline.rewrite_drops', { n: drops.length })) + '</p><ul class="wb-outline-claims">'
        + drops.map(function (d) { return '<li>' + esc(d) + '</li>' }).join('') + '</ul>' : '')
      + (ro ? '' : '<p class="wb-outline-tools">'
        + (r.stale ? '' : '<button type="button" class="wb-btn" data-wb-act="outline-rewrite-accept" data-wb-block="' + escA(b.id) + '">' + esc(t('workbench.outline.rewrite_accept')) + '</button> ')
        + '<button type="button" class="wb-linklike" data-wb-act="outline-rewrite-dismiss" data-wb-block="' + escA(b.id) + '">' + esc(t('workbench.outline.rewrite_dismiss')) + '</button></p>')
      + '</div>'
  }

  /** Egy kerest kuld az agentnek a chatben, mintha a tulajdonos irta volna (latszik a chatben). */
  function askAgent(text) {
    var st = chatState()
    if (WB.chatStreaming) {
      st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true, queued: true })
      renderChat()
      return
    }
    st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    startChatTurn(text)
  }

  /** KOVETKEZETESSEG (#441, K-1.19): a gepi jelzesek emberi mondattal; a
   *  tulajdonos egyenkent "szandekos"-nak jelolheti, ami visszavonhato. */
  function consistencyIssueHtml(i, ro) {
    var v = i.values || []
    var txt = t('workbench.consistency.kind.' + i.kind, { values: v.join(' / '), a: v[0] || '', b: v[1] || '' })
      + (i.where ? ' ' + t('workbench.consistency.where', { where: i.where }) : '')
    var tools = ro ? ''
      : i.acked
        ? ' <button type="button" class="wb-linklike" data-wb-act="outline-consistency-unack" data-wb-key="' + escA(i.key) + '">' + esc(t('workbench.consistency.unack')) + '</button>'
        : ' <button type="button" class="wb-btn" data-wb-act="outline-consistency-ack" data-wb-key="' + escA(i.key) + '" title="' + escA(t('workbench.consistency.ack_title')) + '">'
          + esc(t('workbench.consistency.ack')) + '</button>'
    return '<li class="wb-consistency ' + (i.acked ? 'wb-muted' : 'wb-doc-low') + '">' + esc(txt)
      + (i.acked ? ' <span class="wb-ok">✓ ' + esc(t('workbench.consistency.acked')) + '</span>' : '') + tools + '</li>'
  }

  function consistencyDetailHtml(o, ro) {
    var list = (o && o.consistency) || []
    if (!list.length) return ''
    var open = list.filter(function (i) { return !i.acked })
    var acked = list.filter(function (i) { return i.acked })
    return (open.length ? '<p class="wb-hint">' + esc(t('workbench.consistency.hint')) + '</p>' : '')
      + '<ul>' + open.concat(acked).map(function (i) { return consistencyIssueHtml(i, ro) }).join('') + '</ul>'
  }

  function outlineCheckHtml(check, o, ro) {
    if (!check) return ''
    return '<div class="wb-outline-check"><h4>' + esc(t('workbench.outline.check_title')) + '</h4><ul>'
      + check.items.map(function (i) {
        var info = i.key === 'inference_as_fact' || i.key === 'owner_written'
        if (info && !i.count) return ''
        var key = i.key === 'consistency' && i.ok ? (i.total ? 'consistency_acked' : 'consistency_ok') : i.key
        var txt = t('workbench.outline.check.' + key, { n: i.count, total: i.total === undefined ? '' : i.total })
        var detail = i.key === 'consistency' ? consistencyDetailHtml(o, ro)
          : !i.ok && i.detail && i.detail.length ? '<ul>' + i.detail.slice(0, 8).map(function (d) { return '<li class="wb-muted">' + esc(d) + '</li>' }).join('') + '</ul>' : ''
        return '<li class="' + (i.ok ? 'wb-ok' : 'wb-doc-low') + '">' + (i.ok ? (info ? 'ℹ ' : '✓ ') : '⚠ ') + esc(txt)
          + detail
          + '</li>'
      }).join('')
      + '</ul><p class="' + (check.ready ? 'wb-ok' : 'wb-muted') + '">' + esc(t(check.ready ? 'workbench.outline.ready' : 'workbench.outline.not_ready')) + '</p></div>'
  }

  /** VAZLAT (K-1.14): fejezetek allapottal, bekezdesek, allitasok a forrasaikkal,
   *  hianyok, es a veglegesites elotti ellenorzes (K-1.22). */
  function outlineHtml() {
    var d = WB.detail
    if (!d || !d.item) return ''
    var o = d.outline
    var ro = archived()
    if (!o) {
      if (d.item.type !== 'document' || ro) return ''
      return '<div class="wb-outline wb-outline-empty"><p class="wb-hint">' + esc(t('workbench.outline.empty_hint')) + '</p>'
        + '<p><button type="button" class="wb-btn" data-wb-act="outline-add-section">' + esc(t('workbench.outline.add_section')) + '</button></p></div>'
    }
    var secs = (o.sections || []).map(function (sec) {
      var blocks = (sec.blocks || []).map(function (b) {
        return '<div class="wb-outline-block wb-outline-kind-' + escA(b.kind) + '">'
          + '<div class="wb-outline-text">' + blockTextHtml(b.text) + '</div>'
          + (b.owner_edited_at ? '<p class="wb-muted wb-outline-owner">' + esc(t('workbench.outline.owner_written')) + '</p>' : '')
          + (b.claims && b.claims.length ? '<ul class="wb-outline-claims">' + b.claims.map(function (c) { return claimHtml(c, ro) }).join('') + '</ul>' : '')
          + (b.rewrite ? rewriteHtml(b, ro) : '')
          + (ro ? '' : '<p class="wb-outline-tools">'
            + '<button type="button" class="wb-linklike" data-wb-act="outline-block-edit" data-wb-block="' + escA(b.id) + '">' + esc(t('workbench.outline.edit')) + '</button> '
            + (REWRITABLE[b.kind] ? '<button type="button" class="wb-linklike" data-wb-act="outline-rewrite-ask" data-wb-style="simpler" data-wb-block="' + escA(b.id) + '" data-wb-sec="' + escA(sec.id) + '" title="' + escA(t('workbench.outline.rewrite_simpler_hint')) + '">' + esc(t('workbench.outline.rewrite_simpler')) + '</button> '
              + '<button type="button" class="wb-linklike" data-wb-act="outline-rewrite-ask" data-wb-style="formal" data-wb-block="' + escA(b.id) + '" data-wb-sec="' + escA(sec.id) + '" title="' + escA(t('workbench.outline.rewrite_formal_hint')) + '">' + esc(t('workbench.outline.rewrite_formal')) + '</button> ' : '')
            + '<button type="button" class="wb-linklike" data-wb-act="outline-block-del" data-wb-block="' + escA(b.id) + '">' + esc(t('workbench.outline.delete')) + '</button></p>')
          + '</div>'
      }).join('')
      return '<div class="wb-outline-sec">'
        + '<h4>' + esc(sec.title) + ' '
        + (ro ? '<span class="wb-pill">' + esc(t('workbench.outline.status.' + sec.status)) + '</span>'
          : '<button type="button" class="wb-pill wb-outline-status wb-outline-status-' + escA(sec.status) + '" data-wb-act="outline-sec-status" data-wb-sec="' + escA(sec.id) + '" data-wb-status="' + escA(SECTION_NEXT[sec.status] || 'todo') + '"'
            + ' title="' + escA(t('workbench.outline.status_title')) + '">' + esc(t('workbench.outline.status.' + sec.status)) + '</button>')
        + (sec.problems ? ' <span class="wb-doc-low">⚠ ' + esc(t('workbench.outline.problems', { n: sec.problems })) + '</span>' : '')
        + '</h4>'
        + langSectionHtml(o, sec, ro)
        + blocks
        + backcheckHtml(o, sec, ro)
        + (ro ? '' : '<p class="wb-outline-tools">'
          + '<button type="button" class="wb-linklike" data-wb-act="outline-add-block" data-wb-sec="' + escA(sec.id) + '">' + esc(t('workbench.outline.add_block')) + '</button> '
          + '<button type="button" class="wb-linklike" data-wb-act="outline-sec-rename" data-wb-sec="' + escA(sec.id) + '">' + esc(t('workbench.outline.rename')) + '</button> '
          + '<button type="button" class="wb-linklike" data-wb-act="outline-sec-del" data-wb-sec="' + escA(sec.id) + '">' + esc(t('workbench.outline.delete')) + '</button></p>')
        + '</div>'
    }).join('')
    return '<div class="wb-outline"><h3>' + esc(t('workbench.outline.title')) + '</h3>'
      + '<p class="wb-hint">' + esc(t('workbench.outline.legend')) + '</p>'
      + langHeadHtml(o, ro)
      + secs
      + (ro ? '' : '<p><button type="button" class="wb-btn" data-wb-act="outline-add-section">' + esc(t('workbench.outline.add_section')) + '</button></p>')
      + annexHtml(o, ro)
      + glossaryHtml(o, ro)
      + outlineCheckHtml(o.check, o, ro)
      + outlinePdfHtml(o, ro)
      + '</div>'
  }

  /** NYELVI VALTOZATOK (#441, K-1.27 ... K-1.31). A valtozat kulon munkadarab,
   *  fejezetenkent osszekotve az eredetivel. A forditas az agent munkaja: a
   *  gombok csak megkerik (ugyanugy, mint az atiras-javaslatnal); az allapotot
   *  (leforditatlan / friss / elavult) a szerver szamolja. */
  var DOC_LANGS = ['de', 'en', 'hu', 'fr', 'it', 'es', 'sk', 'ro', 'pl']
  function docLangName(code) {
    var k = 'workbench.doclang.lang.' + code
    var n = t(k)
    return n === k ? String(code || '').toUpperCase() : n
  }
  function variantPending(v) {
    return ((v && v.sections) || []).filter(function (s) { return s.state === 'untranslated' || s.state === 'stale' }).length
      + ((v && v.new_in_source) || []).length
  }
  function langHeadHtml(o, ro) {
    var v = o.variant
    if (v) {
      var pending = variantPending(v)
      var removed = (v.sections || []).filter(function (s) { return s.state === 'source_removed' }).length
      return '<div class="wb-doclang"><h4>' + esc(t('workbench.doclang.variant_title', { lang: docLangName(v.lang) })) + '</h4>'
        + '<p class="wb-hint">' + esc(t('workbench.doclang.variant_hint', { title: v.source_title || '?', lang: docLangName(v.lang) })) + '</p>'
        + (v.source_title ? '' : '<p class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.source_gone')) + '</p>')
        + ((v.new_in_source || []).length ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.new_in_source', { list: v.new_in_source.map(function (x) { return x.title }).join(', ') })) + '</p>' : '')
        + (removed ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.removed_in_source', { n: removed })) + '</p>' : '')
        + '<p class="wb-outline-tools">'
        + (v.source_title ? '<button type="button" class="btn-secondary btn-compact" data-wb-act="outline-lang-open" data-wb-item="' + escA(v.source_item_id) + '">' + esc(t('workbench.doclang.open_source')) + '</button> ' : '')
        + (!ro && pending && v.source_title ? '<button type="button" class="wb-btn" data-wb-act="outline-lang-translate-all" title="' + escA(t('workbench.doclang.translate_all_hint')) + '">' + esc(t('workbench.doclang.translate_all', { n: pending })) + '</button>' : '')
        + (!pending && !removed ? '<span class="wb-ok">✓ ' + esc(t('workbench.doclang.all_current')) + '</span>' : '')
        + '</p></div>'
    }
    var list = o.variants || []
    // Vazlat nelkul nincs mit forditani; csak ha mar van valtozat, akkor latszik.
    if (!list.length && (ro || !(o.sections || []).length)) return ''
    var rows = list.map(function (x) {
      return '<li><strong>' + esc(docLangName(x.lang)) + '</strong> – ' + esc(x.title)
        + (x.stale ? ' <span class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.stale_n', { n: x.stale })) + '</span>' : '')
        + (x.untranslated ? ' <span class="wb-muted">' + esc(t('workbench.doclang.untranslated_n', { n: x.untranslated })) + '</span>' : '')
        + (!x.stale && !x.untranslated ? ' <span class="wb-ok">✓ ' + esc(t('workbench.doclang.current')) + '</span>' : '')
        + ' <button type="button" class="wb-linklike" data-wb-act="outline-lang-open" data-wb-item="' + escA(x.item_id) + '">' + esc(t('workbench.doclang.open')) + '</button></li>'
    }).join('')
    var have = {}
    list.forEach(function (x) { have[x.lang] = true })
    var add = ro || !(o.sections || []).length ? '' : '<p class="wb-doclang-add"><select id="wbVariantLang" aria-label="' + escA(t('workbench.doclang.pick')) + '">'
      + DOC_LANGS.filter(function (c) { return !have[c] }).map(function (c) { return '<option value="' + escA(c) + '">' + esc(docLangName(c)) + '</option>' }).join('')
      + '<option value="other">' + esc(t('workbench.doclang.other')) + '</option></select> '
      + '<button type="button" class="wb-btn" data-wb-act="outline-lang-create" title="' + escA(t('workbench.doclang.create_hint')) + '"' + (WB.variantBusy ? ' disabled' : '') + '>' + esc(t('workbench.doclang.create')) + '</button></p>'
    return '<div class="wb-doclang"><h4>' + esc(t('workbench.doclang.title')) + (list.length ? ' (' + list.length + ')' : '') + '</h4>'
      + (list.length ? '<ul class="wb-doclang-list">' + rows + '</ul>' : '<p class="wb-hint">' + esc(t('workbench.doclang.hint')) + '</p>')
      + add + '</div>'
  }
  function variantSection(o, sid) {
    return ((o.variant && o.variant.sections) || []).filter(function (x) { return x.section_id === sid })[0] || null
  }
  /** Egy valtozat-fejezet allapota a fejezet cime alatt, a teendo gombjaval (K-1.28). */
  function langSectionHtml(o, sec, ro) {
    var vs = variantSection(o, sec.id)
    if (!vs) return ''
    var canAsk = !ro && o.variant && o.variant.source_title
    var line = ''
    if (vs.state === 'untranslated') {
      line = '<span class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.state.untranslated')) + '</span>'
        + (canAsk ? ' <button type="button" class="wb-linklike" data-wb-act="outline-lang-translate" data-wb-sec="' + escA(sec.id) + '">' + esc(t('workbench.doclang.translate')) + '</button>' : '')
    } else if (vs.state === 'stale') {
      line = '<span class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.state.stale')) + '</span>'
        + (canAsk ? ' <button type="button" class="wb-btn" data-wb-act="outline-lang-translate" data-wb-sec="' + escA(sec.id) + '" title="' + escA(t('workbench.doclang.refresh_hint')) + '">' + esc(t('workbench.doclang.refresh')) + '</button>' : '')
    } else if (vs.state === 'source_removed') {
      line = '<span class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.state.source_removed')) + '</span>'
    } else {
      line = '<span class="wb-muted">✓ ' + esc(t('workbench.doclang.state.current', { title: vs.source_title || '' })) + '</span>'
        + (canAsk ? ' <button type="button" class="wb-linklike" data-wb-act="outline-lang-back" data-wb-sec="' + escA(sec.id) + '" title="' + escA(t('workbench.doclang.back_hint')) + '">' + esc(t('workbench.doclang.back')) + '</button>' : '')
    }
    return '<p class="wb-doclang-state">' + line + '</p>'
  }
  /** VISSZAFORDITAS-ELLENORZES (K-1.30): az eredeti es a visszaforditott szoveg egymas mellett. */
  function backcheckHtml(o, sec, ro) {
    var b = ((o.backchecks) || []).filter(function (x) { return x.section_id === sec.id })[0]
    if (!b) return ''
    return '<div class="wb-doclang-back"><p class="wb-outline-rewrite-head">' + esc(t('workbench.doclang.back_title')) + '</p>'
      + (b.stale ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.doclang.back_stale')) + '</p>' : '')
      + '<div class="wb-doclang-cols"><div><p class="wb-muted">' + esc(t('workbench.doclang.back_original')) + '</p><div class="wb-outline-text">' + blockTextHtml(b.source_text || '') + '</div></div>'
      + '<div><p class="wb-muted">' + esc(t('workbench.doclang.back_text')) + '</p><div class="wb-outline-text">' + blockTextHtml(b.text) + '</div></div></div>'
      + (ro ? '' : '<p class="wb-outline-tools"><button type="button" class="wb-linklike" data-wb-act="outline-lang-back-del" data-wb-sec="' + escA(sec.id) + '">' + esc(t('workbench.doclang.back_dismiss')) + '</button></p>')
      + '</div>'
  }
  /** UGYENKENTI SZOSZEDET (K-1.29): a projekt (ugy) minden nyelvi valtozataban igy marad. */
  function glossaryHtml(o, ro) {
    var list = o.glossary || []
    var isVariant = !!o.variant
    if (!isVariant && !(o.variants || []).length && !list.length) return ''
    if (ro && !list.length) return ''
    var rows = list.map(function (g) {
      return '<li><strong>' + esc(g.term) + '</strong> → ' + esc(g.translation) + ' <span class="wb-muted">(' + esc(docLangName(g.lang)) + ')</span>'
        + (g.note ? ' <span class="wb-muted">– ' + esc(g.note) + '</span>' : '')
        + (ro ? '' : ' <button type="button" class="wb-linklike" data-wb-act="outline-lang-term-del" data-wb-term="' + escA(g.id) + '">' + esc(t('workbench.doclang.term_remove')) + '</button>')
        + '</li>'
    }).join('')
    var defLang = isVariant ? o.variant.lang : ((o.variants || [])[0] || {}).lang || 'de'
    var langs = DOC_LANGS.indexOf(defLang) >= 0 ? DOC_LANGS : [defLang].concat(DOC_LANGS)
    var add = ro ? '' : '<p class="wb-doclang-add">'
      + '<input type="text" id="wbGlossTerm" maxlength="200" placeholder="' + escA(t('workbench.doclang.term_placeholder')) + '" aria-label="' + escA(t('workbench.doclang.term_placeholder')) + '"> → '
      + '<input type="text" id="wbGlossTr" maxlength="200" placeholder="' + escA(t('workbench.doclang.tr_placeholder')) + '" aria-label="' + escA(t('workbench.doclang.tr_placeholder')) + '"> '
      + '<select id="wbGlossLang" aria-label="' + escA(t('workbench.doclang.term_lang')) + '">'
      + langs.map(function (c) { return '<option value="' + escA(c) + '"' + (c === defLang ? ' selected' : '') + '>' + esc(docLangName(c)) + '</option>' }).join('') + '</select> '
      + '<button type="button" class="wb-btn" data-wb-act="outline-lang-term-add">' + esc(t('workbench.doclang.term_add')) + '</button></p>'
    return '<details class="wb-doclang-gloss"' + (WB.glossOpen ? ' open' : '') + '><summary data-wb-act="outline-lang-gloss-toggle">' + esc(t('workbench.doclang.gloss_title', { n: list.length })) + '</summary>'
      + '<p class="wb-hint">' + esc(t('workbench.doclang.gloss_hint')) + '</p>'
      + (list.length ? '<ul class="wb-doclang-list">' + rows + '</ul>' : '<p class="wb-muted">' + esc(t('workbench.doclang.gloss_empty')) + '</p>')
      + add + '</details>'
  }

  /** A "+ Nyelvi valtozat": letrehozza, megnyitja, es a valtozat chatjeben megkeri az agentet a forditasra. */
  function createVariantNow() {
    var id = WB.selectedId
    var sel = document.getElementById('wbVariantLang')
    if (!id || !sel || WB.variantBusy || archived()) return
    var code = sel.value
    if (code === 'other') {
      var typed = window.prompt(t('workbench.doclang.other_prompt'), '')
      if (typed === null) return
      code = String(typed).trim().toLowerCase()
    }
    WB.variantBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/outline/variants', { lang: code }).then(function (r) {
      WB.variantBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      var vid = r.data.item.id
      window.showToast(t(r.data.existing ? 'workbench.doclang.exists' : 'workbench.doclang.created', { title: r.data.item.title }))
      load(WB.projectId)
      selectItem(vid)
      if (!r.data.existing) askAgent(t('workbench.doclang.ask_all', { lang: docLangName(code) }))
      else render()
    })
  }

  /** MELLEKLETJEGYZEK (#441, K-1.18): szamozott lista; a szovegbeli hivatkozasokat
   *  a szerver igazitja a listahoz, a felulet csak mutat es kuld. */
  function annexHtml(o, ro) {
    var list = o.annexes || []
    var st = o.settings || {}
    var rows = list.map(function (a, i) {
      var warn = (a.exists === false ? ' <span class="wb-doc-low">⚠ ' + esc(t('workbench.annex.missing_file')) + '</span>' : '')
        + (a.refs ? ' <span class="wb-muted">' + esc(t('workbench.annex.refs', { n: a.refs })) + '</span>'
          : ' <span class="wb-doc-low">⚠ ' + esc(t('workbench.annex.unreferenced')) + '</span>')
      var tools = ro ? '' : ' <span class="wb-outline-tools">'
        + (i > 0 ? '<button type="button" class="wb-linklike" data-wb-act="outline-annex-move" data-wb-annex="' + escA(a.id) + '" data-wb-pos="' + (i - 1) + '" title="' + escA(t('workbench.annex.up')) + '" aria-label="' + escA(t('workbench.annex.up')) + '">↑</button> ' : '')
        + (i < list.length - 1 ? '<button type="button" class="wb-linklike" data-wb-act="outline-annex-move" data-wb-annex="' + escA(a.id) + '" data-wb-pos="' + (i + 1) + '" title="' + escA(t('workbench.annex.down')) + '" aria-label="' + escA(t('workbench.annex.down')) + '">↓</button> ' : '')
        + '<button type="button" class="wb-linklike" data-wb-act="outline-annex-rename" data-wb-annex="' + escA(a.id) + '">' + esc(t('workbench.annex.rename')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="outline-annex-remove" data-wb-annex="' + escA(a.id) + '">' + esc(t('workbench.annex.remove')) + '</button></span>'
      return '<li class="wb-annex"><strong>' + esc(a.label) + '</strong> – ' + esc(a.title)
        + ' <span class="wb-muted">(' + esc(a.path) + ')</span>' + warn + tools + '</li>'
    }).join('')
    var add = ''
    var settings = ''
    if (!ro) {
      var taken = {}
      list.forEach(function (a) { taken[a.path] = true })
      var mats = ((WB.detail && WB.detail.assets) || []).filter(function (m) { return m.present !== false && m.project_path && !taken[m.project_path] })
      add = mats.length
        ? '<p class="wb-annex-add"><select id="wbAnnexPick" aria-label="' + escA(t('workbench.annex.pick')) + '"><option value="">' + esc(t('workbench.annex.pick')) + '</option>'
          + mats.map(function (m) { return '<option value="' + escA(m.project_path) + '">' + esc(m.name) + '</option>' }).join('') + '</select>'
          + '<input type="text" id="wbAnnexTitle" maxlength="300" placeholder="' + escA(t('workbench.annex.title_placeholder')) + '" aria-label="' + escA(t('workbench.annex.title_placeholder')) + '">'
          + '<button type="button" class="wb-btn" data-wb-act="outline-annex-add">' + esc(t('workbench.annex.add')) + '</button></p>'
        : '<p class="wb-hint">' + esc(t('workbench.annex.no_materials')) + '</p>'
      var scheme = st.annex_scheme || 'k'
      settings = '<p class="wb-annex-settings"><label>' + esc(t('workbench.annex.scheme')) + ' <select id="wbAnnexScheme">'
        + (st.schemes || ['k', 'anlage', 'exhibit']).map(function (k) { return '<option value="' + escA(k) + '"' + (k === scheme ? ' selected' : '') + '>' + esc(t('workbench.annex.scheme.' + k)) + '</option>' }).join('')
        + '</select></label>'
        + (scheme === 'exhibit' ? '' : ' <label title="' + escA(t('workbench.annex.prefix_hint')) + '">' + esc(t('workbench.annex.prefix')) + ' <input type="text" id="wbAnnexPrefix" size="2" maxlength="2" value="' + escA(st.annex_prefix || 'K') + '"></label>')
        + '</p>'
        + (list.length ? '<p class="wb-annex-settings"><label>' + esc(t('workbench.annex.mode')) + ' <select id="wbAnnexMode">'
          + (st.modes || ['separate', 'combined']).map(function (m) { return '<option value="' + escA(m) + '"' + (m === (st.annex_mode || 'separate') ? ' selected' : '') + '>' + esc(t('workbench.annex.mode.' + m)) + '</option>' }).join('')
          + '</select></label></p>' : '')
    }
    if (!list.length && ro) return ''
    return '<div class="wb-annexes"><h4>' + esc(t('workbench.annex.title')) + (list.length ? ' (' + list.length + ')' : '') + '</h4>'
      + '<p class="wb-hint">' + esc(t('workbench.annex.hint')) + '</p>'
      + (list.length ? '<ul class="wb-annex-list">' + rows + '</ul>' : '<p class="wb-muted">' + esc(t('workbench.annex.empty')) + '</p>')
      + add + settings + '</div>'
  }

  /** PISZKOZAT ES VEGLEGESITES (#441, K-1.21 ... K-1.23/b). A piszkozat barmikor
   *  (vizjellel); a vegleges csak ellenorzes + atnezes + felelossegvallalas utan,
   *  a tulajdonos sajat kattintasaval. A szerver ellenoriz, a felulet csak mutat. */
  function outlinePdfHtml(o, ro) {
    var base = '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/outline'
    var q = '?lang=' + encodeURIComponent(window._lang || 'hu')
    var f = o.final
    // A keszult fajlok: a beadvany (vagy az egyesitett PDF), es kulon mellekleteknel mindegyik.
    var files = !f ? [] : (f.files && f.files.length ? f.files : [{ path: f.pdf_path, name: f.pdf_name, role: 'main' }])
    var finalLine = !f ? '' : '<p class="' + (f.stale ? 'wb-doc-low' : 'wb-ok') + '">'
      + (f.stale ? '⚠ ' + esc(t('workbench.outline.final_stale', { label: f.label, n: f.version_no }))
        : '✓ ' + esc(t('workbench.outline.final_current', { label: f.label, n: f.version_no })))
      + ' ' + files.map(function (x) {
        return '<a href="/api/life/file?rel=' + escA(encodeURIComponent(x.path || '')) + '" target="_blank" rel="noopener" title="' + escA(x.name || '') + '">'
          + esc(x.role === 'annex' ? (x.label || x.name || '') : t('workbench.outline.final_open')) + '</a>'
      }).join(' · ') + '</p>'
    var tools = '<p class="wb-outline-pdf-tools">'
      + '<a class="btn-secondary btn-compact" href="' + escA(base + '/pdf' + q) + '" target="_blank" rel="noopener" title="' + escA(t('workbench.outline.draft_pdf_hint')) + '">' + esc(t('workbench.outline.draft_pdf')) + '</a> '
      + '<a class="btn-secondary btn-compact" href="' + escA(base + '/docx' + q) + '" download title="' + escA(t('workbench.outline.docx_hint')) + '">' + esc(t('workbench.outline.docx')) + '</a> '
      + '<a class="wb-linklike" href="' + escA(base + '/trail' + q) + '" title="' + escA(t('workbench.outline.trail_hint')) + '">' + esc(t('workbench.outline.trail')) + '</a></p>'
    var fin = ''
    if (!ro) {
      var hash = o.content_hash || ''
      var ready = !!(o.check && o.check.ready)
      var reviewed = !!o.reviewed
      var accepted = ready && reviewed && WB.docAccept === hash
      var reviewBtn = ready
        ? '<a class="btn-secondary btn-compact" data-wb-act="outline-review" href="' + escA(base + '/pdf' + q + '&review=' + encodeURIComponent(hash)) + '" target="_blank" rel="noopener">' + esc(t('workbench.outline.review_open')) + '</a>'
        : '<button type="button" class="btn-secondary btn-compact" disabled>' + esc(t('workbench.outline.review_open')) + '</button>'
      fin = '<div class="wb-outline-final"><h4>' + esc(t('workbench.outline.finalize_title')) + '</h4>'
        + '<p class="wb-hint">' + esc(t(ready ? 'workbench.outline.finalize_steps' : 'workbench.outline.finalize_blocked')) + '</p>'
        + '<p>' + reviewBtn + (reviewed ? ' <span class="wb-ok">✓ ' + esc(t('workbench.outline.reviewed')) + '</span>' : '') + '</p>'
        + '<p><label class="wb-outline-accept"><input type="checkbox" data-wb-act="outline-accept"' + (ready && reviewed ? '' : ' disabled') + (accepted ? ' checked' : '') + '> '
        + esc(t('workbench.outline.accept')) + '</label></p>'
        + '<p><button type="button" class="wb-btn" data-wb-act="outline-finalize"' + (accepted && !WB.docFinalizing ? '' : ' disabled') + '>'
        + esc(t(WB.docFinalizing ? 'workbench.outline.finalizing' : 'workbench.outline.finalize')) + '</button></p>'
        + '</div>'
    }
    return '<div class="wb-outline-pdf">' + tools + finalLine + courtBoxHtml(ro) + fin + '</div>'
  }

  /** CELBIROSAG-PROFIL (#441, 7.4, K-1.36, K-1.37): valasztas, a szabalyverzio a
   *  forrassal, es a kesz fajlok gepi ellenorzesenek eredmenye emberi mondatokkal. */
  function courtIssueText(i) {
    var d = i.detail || {}
    var who = i.label ? t('workbench.court.annex_file', { label: i.label }) : (i.file ? '„' + i.file + '”' : '')
    var p = { who: who, pages: (d.pages || []).join(', '), n: d.n, fonts: (d.fonts || []).join(', '), mb: d.mb, max: d.max, length: d.length, form: d.form, error: d.error }
    return t('workbench.court.issue.' + i.key, p)
  }

  function courtBoxHtml(ro) {
    var c = WB.detail && WB.detail.court
    if (!c) return ''
    var lang = window._lang === 'en' ? 'en' : 'hu'
    var nm = function (x) { return (x && x.name && (x.name[lang] || x.name.hu)) || '' }
    var p = c.profile
    var sel = ro ? (p ? '<p>' + esc(nm(p)) + '</p>' : '')
      : '<p><label>' + esc(t('workbench.court.choose')) + ' <select id="wbCourtProfile"><option value="">' + esc(t('workbench.court.none')) + '</option>'
        + (c.profiles || []).map(function (x) { return '<option value="' + escA(x.id) + '"' + (p && p.id === x.id ? ' selected' : '') + '>' + esc(nm(x)) + '</option>' }).join('')
        + '</select></label></p>'
    var srcLinks = function (list) {
      return (list || []).map(function (s) { return '<a href="' + escA(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title || s.url) + '</a>' }).join(' · ')
    }
    // A profilfajl hibaja nem nema: a beepitett profilok mennek, es megmondjuk, miert.
    var fileWarn = (c.file_error ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.court.file_error', { file: c.file || '', error: c.file_error })) + '</p>' : '')
      + (c.skipped || []).map(function (s) { return '<p class="wb-doc-low">⚠ ' + esc(t('workbench.court.skipped', { id: s.id, problem: s.problem })) + '</p>' }).join('')
    var info = ''
    if (p) {
      info = '<p class="wb-hint">' + esc(t(p.valid_from_unknown ? 'workbench.court.version_unknown' : 'workbench.court.version', { version: p.version, from: p.valid_from, checked: p.last_checked })) + ' '
        + srcLinks(p.sources) + '</p>'
        + (p.stale ? '<p class="wb-doc-low">⚠ ' + esc(t('workbench.court.stale', { name: nm(p), date: p.last_checked }))
          + (ro ? '' : ' <button type="button" class="wb-linklike" data-wb-act="court-checked" data-wb-id="' + escA(p.id) + '">' + esc(t('workbench.court.mark_checked')) + '</button>') + '</p>' : '')
        + (!ro && (p.sources || []).length ? '<p><button type="button" class="wb-linklike" data-wb-act="court-ask-check" data-wb-id="' + escA(p.id) + '">' + esc(t('workbench.court.ask_check')) + '</button></p>' : '')
        + (p.filename_rule ? '<p class="wb-hint">' + esc(t('workbench.court.filename', { rule: p.filename_rule[lang] || p.filename_rule.hu })) + '</p>' : '')
        + (p.notes || []).map(function (n) { return '<p class="wb-hint">ℹ ' + esc(n[lang] || n.hu) + '</p>' }).join('')
    }
    var props = (c.proposals || []).map(function (x) { return courtProposalHtml(x, ro, nm) }).join('')
    var res = ''
    var ck = c.check && c.check.result
    if (p && ck && c.check_current) {
      var list = ck.issues || []
      res = (c.rules_current ? '' : '<p class="wb-doc-low">⚠ ' + esc(t('workbench.court.rules_changed', { version: p.version, old: ck.version })) + '</p>')
        + '<p class="' + (ck.errors ? 'wb-doc-low' : 'wb-ok') + '">'
        + esc(t(ck.errors ? 'workbench.court.result_errors' : ck.warnings ? 'workbench.court.result_warnings' : 'workbench.court.result_clean', { version: ck.version, files: (ck.files || []).length, e: ck.errors, w: ck.warnings })) + '</p>'
        + (list.length ? '<ul class="wb-court-list">' + list.map(function (i) {
          return '<li class="wb-court-' + (i.level === 'error' ? 'err' : 'warn') + '">' + (i.level === 'error' ? '✗ ' : '⚠ ') + esc(courtIssueText(i))
            + (i.fix === 'searchable' && !ro ? ' <button type="button" class="wb-linklike" data-wb-act="court-fix" data-wb-id="' + escA(i.annex_id || '') + '"' + (WB.courtBusy ? ' disabled' : '') + '>' + esc(t('workbench.court.fix_searchable')) + '</button>' : '')
            + '</li>'
        }).join('') + '</ul>' : '')
        + '<p class="wb-hint">' + esc(t('workbench.court.disclaimer')) + '</p>'
    } else if (p) {
      res = '<p class="wb-muted">' + esc(t((WB.detail.outline && WB.detail.outline.final) ? 'workbench.court.not_checked_final' : 'workbench.court.not_checked')) + '</p>'
    }
    if (p && !c.available) res += '<p class="wb-doc-low">' + esc(t('workbench.court.not_installed')) + '</p>'
    var btn = p && !ro && c.available && WB.detail.outline && WB.detail.outline.final
      ? '<p><button type="button" class="btn-secondary btn-compact" data-wb-act="court-check"' + (WB.courtBusy ? ' disabled' : '') + '>' + esc(t(WB.courtBusy ? 'workbench.court.checking' : 'workbench.court.recheck')) + '</button></p>' : ''
    return '<div class="wb-court"><h4>' + esc(t('workbench.court.title')) + '</h4><p class="wb-hint">' + esc(t('workbench.court.hint')) + '</p>'
      + fileWarn + sel + info + props + res + btn + courtSettingsHtml(c, ro) + '</div>'
  }

  /** A szabalyfrissites javaslata: mi valtozna a mostani szabalyhoz kepest, es a tulajdonos dont. */
  function courtProposalHtml(x, ro, nm) {
    var lang = window._lang === 'en' ? 'en' : 'hu'
    var v = x.version || {}
    var head = t('workbench.court.proposal.' + x.kind, { name: nm(x), version: v.version || '' })
    var val = function (k, y) {
      if (y == null) return t(k === 'valid_from' ? 'workbench.court.val.unknown_date' : 'workbench.court.val.none')
      if (k === 'searchable' || k === 'fonts_embedded' || k === 'encryption' || k === 'javascript' || k === 'launch' || k === 'embedded_files' || k === 'media' || k === 'form_fields') return t('workbench.court.val.' + y)
      if (k === 'encryption_scope') return t('workbench.court.val.' + y)
      if (k === 'max_file_mb' || k === 'max_total_mb') return t('workbench.court.val.mb', { n: y })
      if (k === 'filename') return (y.rule && (y.rule[lang] || y.rule.hu)) || ''
      if (k === 'sources') return y.length ? y.map(function (s) { return s.title || s.url }).join(' · ') : t('workbench.court.val.none')
      if (k === 'notes') return y.length ? y.map(function (n) { return n[lang] || n.hu }).join(' / ') : t('workbench.court.val.none')
      return String(y)
    }
    var diff = (x.diff || []).map(function (d) {
      return '<li><b>' + esc(t('workbench.court.req.' + d.key)) + ':</b> ' + esc(val(d.key, d.from)) + ' → ' + esc(val(d.key, d.to)) + '</li>'
    }).join('')
    return '<div class="wb-court-prop"><p><b>' + esc(head) + '</b></p>'
      + '<p class="wb-hint">' + esc(t('workbench.court.proposal.reason')) + ' ' + esc(x.reason || '') + '</p>'
      + '<p class="wb-hint">' + esc(t('workbench.court.proposal.sources')) + ' '
      + (x.checked_sources || []).map(function (u) { return '<a href="' + escA(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>' }).join(' · ') + '</p>'
      + (diff ? '<p class="wb-hint">' + esc(t('workbench.court.proposal.changes')) + '</p><ul class="wb-court-list">' + diff + '</ul>' : '')
      + '<p class="wb-hint">' + esc(t('workbench.court.proposal.verify')) + '</p>'
      + (ro ? '' : '<p class="wb-outline-tools"><button type="button" class="wb-btn" data-wb-act="court-prop-accept" data-wb-id="' + escA(x.id) + '"' + (WB.courtBusy ? ' disabled' : '') + '>' + esc(t('workbench.court.proposal.accept')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="court-prop-reject" data-wb-id="' + escA(x.id) + '"' + (WB.courtBusy ? ' disabled' : '') + '>' + esc(t('workbench.court.proposal.reject')) + '</button></p>')
      + '</div>'
  }

  /** Mennyi ido utan kerdezzen ra a Marvin a valtozasra (honapban; a nem kerek erteket napban mutatjuk). */
  var COURT_AGE_MONTHS = [[3, 91], [6, 183], [12, 365], [24, 730]]
  function courtSettingsHtml(c, ro) {
    var cur = c.max_age_days
    var known = COURT_AGE_MONTHS.some(function (m) { return m[1] === cur })
    var opts = COURT_AGE_MONTHS.map(function (m) {
      return '<option value="' + m[1] + '"' + (m[1] === cur ? ' selected' : '') + '>' + esc(t('workbench.court.months', { n: m[0] })) + '</option>'
    }).join('') + (known || !cur ? '' : '<option value="' + escA(String(cur)) + '" selected>' + esc(t('workbench.court.days', { n: cur })) + '</option>')
    return '<p class="wb-hint">' + esc(t('workbench.court.new_hint')) + '</p>'
      + '<p class="wb-hint"><label>' + esc(t('workbench.court.stale_after')) + ' <select id="wbCourtMaxAge"' + (ro || c.file_error ? ' disabled' : '') + '>' + opts + '</select></label></p>'
  }

  function courtCall(method, sub, body, done) {
    var id = WB.selectedId
    if (!id || archived() || WB.courtBusy) return
    WB.courtBusy = true
    render()
    api(method, '/api/workbench/items/' + encodeURIComponent(id) + '/court' + sub, body).then(function (r) {
      WB.courtBusy = false
      if (WB.selectedId === id && WB.detail && r.data) {
        if (r.data.court) WB.detail.court = r.data.court
        if (r.data.outline) WB.detail.outline = r.data.outline
        if (r.data.assets) WB.detail.assets = r.data.assets
      }
      if (!r.ok) window.showToast(r.message)
      else if (done) done(r.data)
      render()
    })
  }

  /** A vazlat ujratoltese a szerverrol (pl. az atnezes rogzitese utan). */
  function refreshOutline() {
    var id = WB.selectedId
    if (!id) return
    api('GET', '/api/workbench/items/' + encodeURIComponent(id) + '/outline').then(function (r) {
      if (r.ok && WB.selectedId === id && WB.detail) { WB.detail.outline = r.data.outline; render() }
    })
  }

  function finalizeDocument() {
    var id = WB.selectedId
    var o = WB.detail && WB.detail.outline
    if (!id || !o || WB.docFinalizing || archived()) return
    WB.docFinalizing = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/outline/finalize', { accept: true, hash: o.content_hash }).then(function (r) {
      WB.docFinalizing = false
      if (WB.selectedId === id && WB.detail) {
        if (r.data && r.data.outline) WB.detail.outline = r.data.outline
        if (r.ok && r.data.assets) WB.detail.assets = r.data.assets
        if (r.ok && r.data.court) WB.detail.court = r.data.court
      }
      if (r.ok) { WB.docAccept = null; window.showToast(t('workbench.outline.finalized', { label: r.data.final.label })) }
      else window.showToast(r.message)
      render()
    })
  }

  function outlineCall(method, sub, body) {
    var id = WB.selectedId
    if (!id || archived()) return
    api(method, '/api/workbench/items/' + encodeURIComponent(id) + '/outline' + sub, body).then(function (r) {
      if (!r.ok) {
        window.showToast(r.message)
        // Ha a szerver a friss allapotot is kuldi (pl. a jelzett elteres kozben eltunt), azt mutatjuk.
        if (r.data && r.data.outline && WB.selectedId === id && WB.detail) { WB.detail.outline = r.data.outline; render() }
        return
      }
      if (WB.selectedId === id && WB.detail) { WB.detail.outline = r.data.outline; render() }
    })
  }

  function findBlock(bid) {
    var o = WB.detail && WB.detail.outline
    var out = null
    ;((o && o.sections) || []).forEach(function (s) { (s.blocks || []).forEach(function (b) { if (b.id === bid) out = b }) })
    return out
  }
  function findAnnex(id) {
    var o = WB.detail && WB.detail.outline
    return ((o && o.annexes) || []).filter(function (a) { return a.id === id })[0] || null
  }
  function findSection(sid) {
    var o = WB.detail && WB.detail.outline
    return ((o && o.sections) || []).filter(function (s) { return s.id === sid })[0] || null
  }

  function outlineAction(a, act) {
    var sid = act.getAttribute('data-wb-sec')
    var bid = act.getAttribute('data-wb-block')
    if (a === 'outline-add-section') {
      var title = window.prompt(t('workbench.outline.add_section_prompt'), '')
      if (title && title.trim()) outlineCall('POST', '/sections', { title: title.trim() })
    } else if (a === 'outline-sec-rename') {
      var sec = findSection(sid)
      var nt = window.prompt(t('workbench.outline.rename_prompt'), sec ? sec.title : '')
      if (nt && nt.trim()) outlineCall('PATCH', '/sections/' + encodeURIComponent(sid), { title: nt.trim() })
    } else if (a === 'outline-sec-status') {
      outlineCall('PATCH', '/sections/' + encodeURIComponent(sid), { status: act.getAttribute('data-wb-status') })
    } else if (a === 'outline-sec-del') {
      if (window.confirm(t('workbench.outline.delete_section_confirm'))) outlineCall('DELETE', '/sections/' + encodeURIComponent(sid))
    } else if (a === 'outline-add-block') {
      var text = window.prompt(t('workbench.outline.add_block_prompt'), '')
      if (text && text.trim()) outlineCall('POST', '/blocks', { section: sid, text: text.trim() })
    } else if (a === 'outline-block-edit') {
      var b = findBlock(bid)
      var nx = window.prompt(t('workbench.outline.edit_prompt'), b ? b.text : '')
      if (nx !== null && nx.trim() && (!b || nx.trim() !== b.text)) outlineCall('PATCH', '/blocks/' + encodeURIComponent(bid), { text: nx.trim() })
    } else if (a === 'outline-rewrite-ask') {
      var rb = findBlock(bid)
      var rs = findSection(sid)
      if (!rb) return
      var excerpt = rb.text.length > 400 ? rb.text.slice(0, 400) + '…' : rb.text
      askAgent(t('workbench.outline.rewrite_ask.' + act.getAttribute('data-wb-style'), { section: rs ? rs.title : '', block: rb.id, text: excerpt }))
      window.showToast(t('workbench.outline.rewrite_asked'))
    } else if (a === 'outline-lang-create') {
      createVariantNow()
    } else if (a === 'outline-lang-open') {
      var oid = act.getAttribute('data-wb-item')
      if (oid) selectItem(oid)
    } else if (a === 'outline-lang-translate-all') {
      var ov = WB.detail && WB.detail.outline && WB.detail.outline.variant
      if (!ov) return
      askAgent(t('workbench.doclang.ask_all', { lang: docLangName(ov.lang) }))
      window.showToast(t('workbench.doclang.asked'))
    } else if (a === 'outline-lang-translate') {
      var tv = WB.detail && WB.detail.outline && WB.detail.outline.variant
      var ts = findSection(sid)
      var tvs = tv ? variantSection(WB.detail.outline, sid) : null
      if (!tv || !tvs) return
      askAgent(t(tvs.state === 'stale' ? 'workbench.doclang.ask_refresh' : 'workbench.doclang.ask_one', { lang: docLangName(tv.lang), section: tvs.source_title || (ts ? ts.title : ''), source_section: tvs.source_section_id }))
      window.showToast(t('workbench.doclang.asked'))
    } else if (a === 'outline-lang-back') {
      var bv = WB.detail && WB.detail.outline && WB.detail.outline.variant
      var bs = findSection(sid)
      if (!bv || !bs) return
      askAgent(t('workbench.doclang.ask_back', { lang: docLangName(bv.lang), section: bs.title, id: sid }))
      window.showToast(t('workbench.doclang.asked'))
    } else if (a === 'outline-lang-back-del') {
      outlineCall('DELETE', '/backchecks/' + encodeURIComponent(sid))
    } else if (a === 'outline-lang-term-add') {
      var te = document.getElementById('wbGlossTerm')
      var tr = document.getElementById('wbGlossTr')
      var tl = document.getElementById('wbGlossLang')
      var term = te ? te.value.trim() : ''
      var trans = tr ? tr.value.trim() : ''
      if (!term || !trans) { window.showToast(t('workbench.doclang.term_required')); return }
      WB.glossOpen = true
      outlineCall('POST', '/glossary', { term: term, translation: trans, lang: tl ? tl.value : '' })
    } else if (a === 'outline-lang-term-del') {
      outlineCall('DELETE', '/glossary/' + encodeURIComponent(act.getAttribute('data-wb-term') || ''))
    } else if (a === 'outline-lang-gloss-toggle') {
      var det = act.parentNode
      WB.glossOpen = !(det && det.open)
    } else if (a === 'outline-rewrite-accept') {
      var ab = findBlock(bid)
      var drops = ab && ab.rewrite ? (ab.rewrite.would_drop || []).length : 0
      if (!drops || window.confirm(t('workbench.outline.rewrite_drops_confirm', { n: drops }))) outlineCall('POST', '/blocks/' + encodeURIComponent(bid) + '/rewrite/accept', {})
    } else if (a === 'outline-rewrite-dismiss') {
      outlineCall('DELETE', '/blocks/' + encodeURIComponent(bid) + '/rewrite')
    } else if (a === 'outline-block-del') {
      if (window.confirm(t('workbench.outline.delete_block_confirm'))) outlineCall('DELETE', '/blocks/' + encodeURIComponent(bid))
    } else if (a === 'outline-annex-add') {
      var pick = document.getElementById('wbAnnexPick')
      var ttl = document.getElementById('wbAnnexTitle')
      if (!pick || !pick.value) { window.showToast(t('workbench.annex.pick_first')); return }
      outlineCall('POST', '/annexes', { path: pick.value, title: ttl && ttl.value ? ttl.value.trim() : '' })
    } else if (a === 'outline-annex-move') {
      outlineCall('PATCH', '/annexes/' + encodeURIComponent(act.getAttribute('data-wb-annex')), { position: Number(act.getAttribute('data-wb-pos')) })
    } else if (a === 'outline-annex-rename') {
      var ax = findAnnex(act.getAttribute('data-wb-annex'))
      var nt2 = window.prompt(t('workbench.annex.rename_prompt'), ax ? ax.title : '')
      if (nt2 && nt2.trim()) outlineCall('PATCH', '/annexes/' + encodeURIComponent(act.getAttribute('data-wb-annex')), { title: nt2.trim() })
    } else if (a === 'outline-annex-remove') {
      if (window.confirm(t('workbench.annex.remove_confirm'))) outlineCall('DELETE', '/annexes/' + encodeURIComponent(act.getAttribute('data-wb-annex')))
    } else if (a === 'outline-review') {
      // A link maga nyitja meg a PDF-et uj lapon; a szerver akkor rogziti az
      // atnezest, ha elkeszult, es a tartalom ugyanaz. Utana onnan olvassuk vissza.
      setTimeout(refreshOutline, 1500)
      setTimeout(refreshOutline, 5000)
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('focus', function once() { window.removeEventListener('focus', once); refreshOutline() })
      }
    } else if (a === 'outline-accept') {
      var o = WB.detail && WB.detail.outline
      WB.docAccept = act.checked && o ? o.content_hash : null
      render()
    } else if (a === 'outline-finalize') {
      finalizeDocument()
    } else if (a === 'court-check') {
      courtCall('POST', '/check', {})
    } else if (a === 'court-checked') {
      courtCall('POST', '/checked', { profile_id: act.getAttribute('data-wb-id') })
    } else if (a === 'court-ask-check') {
      var cp = WB.detail && WB.detail.court && WB.detail.court.profile
      if (cp) {
        var cl = window._lang === 'en' ? 'en' : 'hu'
        askAgent(t('workbench.court.ask_check_text', { name: (cp.name && (cp.name[cl] || cp.name.hu)) || cp.id, id: cp.id, version: cp.version, checked: cp.last_checked, urls: (cp.sources || []).map(function (s) { return s.url }).join(' , ') }))
      }
    } else if (a === 'court-prop-accept') {
      courtCall('POST', '/proposals/' + encodeURIComponent(act.getAttribute('data-wb-id') || '') + '/accept', {}, function () { window.showToast(t('workbench.court.proposal.accepted')) })
    } else if (a === 'court-prop-reject') {
      courtCall('POST', '/proposals/' + encodeURIComponent(act.getAttribute('data-wb-id') || '') + '/reject', {}, function () { window.showToast(t('workbench.court.proposal.rejected')) })
    } else if (a === 'court-fix') {
      courtCall('POST', '/fix', { annex_id: act.getAttribute('data-wb-id') }, function () { window.showToast(t('workbench.court.fixed')) })
    } else if (a === 'outline-claim-confirm') {
      // K-1.9: allitasonkenti, kifejezett megerosites -- a teljes szoveg a kerdesben.
      if (window.confirm(t('workbench.outline.confirm_prompt'))) outlineCall('POST', '/claims/' + encodeURIComponent(act.getAttribute('data-wb-claim')) + '/confirm', {})
    } else if (a === 'outline-consistency-ack') {
      outlineCall('POST', '/consistency/' + encodeURIComponent(act.getAttribute('data-wb-key')) + '/ack', {})
    } else if (a === 'outline-consistency-unack') {
      outlineCall('DELETE', '/consistency/' + encodeURIComponent(act.getAttribute('data-wb-key')) + '/ack')
    }
  }

  /** A chat 📎 gombja (#441): a fajl a megnyitott munkadarab ANYAGAI koze
   *  kerul, nem lesz belole uj munkadarab. Munkadarab nelkul nincs gomb. */
  function chatAttachHtml() {
    if (!WB.selectedId || !WB.detail || archived()) return ''
    return '<label class="btn-secondary wb-chat-attach" for="wbChatAssetUpload" title="' + escA(t('workbench.assets.attach_title')) + '"'
      + ' aria-label="' + escA(t('workbench.assets.attach_title')) + '">\ud83d\udcce</label>'
      + '<input type="file" id="wbChatAssetUpload" class="wb-file-input" multiple>'
  }

  /** A munkadarabhoz most csatolt, meg el nem kuldott fajlok listaja. */
  function attachedList(itemId) {
    if (!WB.chatAttached[itemId]) WB.chatAttached[itemId] = []
    return WB.chatAttached[itemId]
  }

  /** A CSATOLT FAJLOK SORA a beiro mezo felett (#441): a feltoltes allapota,
   *  majd a fajlok nevei. Kulonben a csatolas utan a chatben semmi nem
   *  latszott, az Anyagok doboz pedig osztott nezetben a kepernyo aljan all. */
  function chatAttachedHtml() {
    var id = WB.selectedId
    if (!id || !WB.detail || archived()) return ''
    var list = WB.chatAttached[id] || []
    var up = WB.upload && WB.upload.item === id ? WB.upload : null
    if (!list.length && !up) return ''
    var chips = list.map(function (a, i) {
      return '<span class="wb-attached-chip">📎 ' + esc(a.name)
        + ' <button type="button" class="wb-linklike" data-wb-act="chat-attached-drop" data-wb-attached="' + i + '"'
        + ' title="' + escA(t('workbench.chat.attached_drop_title')) + '" aria-label="' + escA(t('workbench.chat.attached_drop_title')) + '">×</button></span>'
    }).join('')
    return '<div class="wb-attached" role="status">'
      + (up ? '<span class="wb-attached-chip wb-muted">' + esc(t('workbench.chat.attached_uploading', { done: up.done, total: up.total })) + '</span>' : '')
      + chips
      + (list.length
        ? '<p class="wb-hint">' + esc(t('workbench.chat.attached_hint')) + ' '
          + '<button type="button" class="wb-linklike" data-wb-act="assets-show">' + esc(t('workbench.chat.attached_show')) + '</button></p>'
        : '')
      + '</div>'
  }

  /** Az elkuldendo uzenet a csatolt fajlok soraval. Ha a nevekkel tul hosszu
   *  lenne, csak a darabszam megy (a nevek az agens kontextusaban amugy is ott vannak). */
  function withAttachedLine(text, list, max) {
    if (!list || !list.length) return text
    var sep = text ? '\n\n' : ''
    var line = t('workbench.chat.attached_line', { names: list.map(function (a) { return a.name }).join(', ') })
    if (max && (text + sep + line).length > max) line = t('workbench.chat.attached_line_count', { n: list.length })
    return text + sep + line
  }

  /** "Megmutatom": az Anyagok doboz a kepernyon (telefonon a Kontextus fulon). */
  function showAssetsBlock() {
    WB.panel = 'context'
    render()
    var box = root() && typeof root().querySelector === 'function' ? root().querySelector('.wb-assets-block') : null
    if (!box) return
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (box.classList) {
      box.classList.add('wb-flash')
      setTimeout(function () { if (box.classList) box.classList.remove('wb-flash') }, 2000)
    }
  }

  function assetSupportLabel(sup) {
    return t('workbench.assets.support.' + (sup || 'usable'))
  }

  /** Tamogatasi cimke CSAK a gondnal (Boss, 2026-09-29, 1888): az
   *  "olvashato"/"felhasznalhato" felesleges, a "feldolgozo kell hozza" es a
   *  "nem tamogatott" marad, mert az mond valamit. */
  function supportPillHtml(sup) {
    if (sup !== 'needs_processor' && sup !== 'unsupported') return ''
    return ' <span class="wb-pill wb-asset-sup wb-asset-sup-' + escA(sup) + '">' + esc(assetSupportLabel(sup)) + '</span>'
  }

  /** MAPPA MEGNYITASA (#443, Boss 2026-09-29, "C" + "2A"): ket gomb -- az
   *  Intezo (a dashboard fajlkezeloje) es a gep sajat fajlkezeloje (Windows
   *  Explorer / Finder). Ha a gepen nincs megnyithato fajlkezelo, csak az
   *  Intezo gomb latszik. `compact`: ikon-gombok egy anyag-sorban; 'short':
   *  side by side, icon + "Open", a few plain words as tooltip (TG 1817/1832/1839). */
  function folderBtnsHtml(place, assetId, compact) {
    if (WB.fm === undefined) loadFileManagerKind()
    var data = ' data-wb-place="' + escA(place) + '"' + (assetId ? ' data-wb-asset="' + escA(assetId) + '"' : '')
    var fm = WB.fm && WB.fm !== 'none' ? WB.fm : null
    var short = compact === 'short'
    // 'short': a few plain words as the tooltip, no long explanation (Boss, TG 1832).
    var sIn = t('workbench.folder.short.intezo')
    var sSys = fm ? t('workbench.folder.short.system.' + fm) : ''
    var tIn = short ? sIn : t(place === 'asset' ? 'workbench.folder.intezo_file_title' : 'workbench.folder.intezo_title')
    var tSys = short ? sSys : (fm ? t(place === 'asset' ? 'workbench.folder.system_file_title.' + fm : 'workbench.folder.system_title.' + fm) : '')
    var cls = compact === true ? 'wb-mini-btn wb-folder-btn' : 'wb-btn wb-folder-btn'
    // 'short': the button says just "Open"; the plain meaning is in the tooltip (Boss, TG 1839).
    function label(full) { return compact === true ? '' : ' ' + esc(short ? t('workbench.folder.open_short') : full) }
    var b = '<button type="button" class="' + cls + '" data-wb-act="folder-intezo"' + data
      + ' title="' + escA(tIn) + '" aria-label="' + escA(tIn) + '">\ud83d\udcc2' + label(t('workbench.folder.intezo')) + '</button>'
      + (fm ? '<button type="button" class="' + cls + '" data-wb-act="folder-system"' + data
        + ' title="' + escA(tSys) + '" aria-label="' + escA(tSys) + '">\ud83d\uddc2' + label(t('workbench.folder.system.' + fm)) + '</button>' : '')
    return compact === true ? b : '<p class="wb-ctx-actions wb-folder-acts' + (short ? ' wb-folder-row' : '') + '">' + b + '</p>'
  }

  function loadFileManagerKind() {
    WB.fm = null
    api('GET', '/api/workbench/file-manager').then(function (r) {
      WB.fm = r.ok && r.data && r.data.kind ? r.data.kind : 'none'
      if (WB.fm !== 'none') render()
    })
  }

  /** `tab` (optional): a new browser tab already opened inside the click
   *  (Ctrl+click, TG 1802); the Intezo then loads THERE and this tab stays on
   *  the Workbench. */
  function openFolder(place, assetId, app, tab) {
    var pid = WB.projectId
    if (!pid) { if (tab) tab.cancel(); return }
    var body = { project: pid, place: place, app: app }
    if (place !== 'shared' && WB.selectedId) body.item = WB.selectedId
    if (assetId) body.asset = assetId
    api('POST', '/api/workbench/open-folder', body).then(function (r) {
      if (!r.ok) { if (tab) tab.cancel(); window.showToast(r.message); return }
      if (app === 'system') { window.showToast(t('workbench.folder.system_done')); return }
      if (tab) { tab.go('intezo', { path: r.data.path }); return }
      var p = r.data.project || {}
      if (typeof window._prjOpenFiles === 'function') window._prjOpenFiles({ id: p.id || pid, name: p.name || '', folder_path: r.data.path })
    })
  }

  /** LEVETEL / TORLES kerdes (Boss, 2026-09-29, 1884): csak levetel (a fajl a
   *  mappaban marad), vagy vegleges torles a mappabol is -- "szemetet nem
   *  kellene hagyni a rendszerben". Piros keret, a sor alatt. */
  function assetRemoveBoxHtml(a) {
    return '<div class="wb-warn-box" role="alert"><p>' + esc(t('workbench.assets.remove_ask', { name: a.name })) + '</p><div class="wb-warn-acts">'
      + '<button type="button" class="wb-btn" data-wb-act="asset-unlink" data-wb-asset="' + escA(a.id) + '">' + esc(t('workbench.assets.remove_only')) + '</button>'
      + '<button type="button" class="wb-btn wb-btn-danger" data-wb-act="asset-delete-file" data-wb-asset="' + escA(a.id) + '">' + esc(t('workbench.assets.remove_delete')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="warn-cancel">' + esc(t('workbench.warn.cancel')) + '</button>'
      + '</div></div>'
  }

  /** ANYAGOK doboz (#441, v4 K-0.14 ... K-0.16): a munkadarab sajat mappaja es
   *  a hozza csatolt fajlok, tamogatasi allapottal. Ide is lehet fajlt huzni. */
  function assetsBlockHtml() {
    var d = WB.detail
    var it = d.item
    var assets = d.assets || []
    var ro = archived()
    var folder = it.folder || ''
    var src = it.source_path || ''
    // Ha a fo fajl meg nem a munkadarab mappajaban all (regi, omlesztett fajl), felajanljuk a rendrakast.
    var loose = src && (!folder || src.indexOf('/' + folder + '/') < 0)
    var list = assets.length
      ? '<ul class="wb-assets">' + assets.map(function (a) {
        // Sor = bal oldalt a nev es a cimkek, jobb oldalt a gomb: a gombok igy
        // egy oszlopban, egymas alatt allnak (Boss, #443).
        return '<li class="wb-asset wb-row"><div class="wb-row-main">'
          + '<span class="wb-asset-name" title="' + escA(a.project_path || a.path) + '">' + esc(a.name) + '</span> '
          + supportPillHtml(a.support)
          + docStateHtml(a)
          + (a.shared ? ' <span class="wb-pill wb-asset-shared" title="' + escA(t('workbench.shared.pill_title')) + '">' + esc(t('workbench.shared.pill')) + '</span>' : '')
          + (a.present ? '' : ' <span class="wb-muted">' + esc(t('workbench.assets.missing')) + '</span>')
          + '</div>'
          // Icons stacked ABOVE Remove/Delete, so the name keeps the width (Boss, TG 1811).
          + '<div class="wb-row-act wb-asset-act">' + (a.present ? '<span class="wb-folder-pair">' + folderBtnsHtml('asset', a.id, true) + '</span>' : '')
          + (ro ? '' : '<button type="button" class="wb-mini-btn" data-wb-act="asset-remove" data-wb-asset="' + escA(a.id) + '"'
            + ' title="' + escA(t('workbench.assets.remove_title')) + '">' + esc(t('workbench.assets.remove')) + '</button>')
          + '</div>'
          + (WB.warn && WB.warn.kind === 'asset-remove' && WB.warn.id === a.id ? assetRemoveBoxHtml(a) : '')
          + (WB.redact && WB.redact.itemId === WB.selectedId && WB.redact.path === a.project_path ? redactBoxHtml() : '')
          + '</li>'
      }).join('') + '</ul>'
      : '<p class="wb-muted">' + esc(t('workbench.assets.none')) + '</p>'
    return '<div class="wb-ctx-block wb-assets-block"' + (ro ? '' : ' data-wb-drop="assets"') + '>'
      + '<h3>' + esc(t('workbench.assets.title')) + (assets.length ? ' (' + assets.length + ')' : '') + '</h3>'
      + '<p class="wb-muted">' + esc(folder
        ? t('workbench.assets.folder', { folder: folder })
        : t('workbench.assets.no_folder')) + '</p>'
      + (folder ? folderBtnsHtml('assets', null, 'short') : '')
      + list
      + (ro ? '' : '<p class="wb-ctx-actions"><label class="wb-btn" for="wbAssetUpload">\ud83d\udcce ' + esc(WB.upload
        ? t('workbench.upload.busy')
        : t('workbench.assets.add')) + '</label>'
        + '<input type="file" id="wbAssetUpload" class="wb-file-input" multiple></p>'
        + '<p class="wb-hint">' + esc(t('workbench.assets.hint')) + '</p>')
      + (ro || !loose ? '' : '<p><button type="button" class="wb-btn" data-wb-act="asset-tidy"' + (WB.tidyBusy ? ' disabled' : '') + '>'
        + esc(t('workbench.assets.tidy')) + '</button></p>'
        + '<p class="wb-hint">' + esc(t('workbench.assets.tidy_hint')) + '</p>')
      + '</div>'
  }

  /** A PROJEKT KOZOS TARA (#441, K-0.19): logo, markaelemek egyszer a
   *  projektben; a munkadarabhoz hivatkozaskent kerulnek, masolat nem keszul. */
  function sharedBlockHtml(assets) {
    var sh = WB.shared && WB.shared.projectId === WB.projectId ? WB.shared : null
    var open = !!(sh && sh.open)
    var head = '<div class="wb-ctx-block wb-shared-ctx"><h3>' + esc(t('workbench.shared.title')) + '</h3>'
      + '<p class="wb-ctx-actions"><button type="button" class="wb-btn" data-wb-act="shared-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + '\u2b50 ' + esc(t(open ? 'workbench.shared.close' : 'workbench.shared.open')) + '</button></p>'
    if (!open) return head + '</div>'
    var linked = {}
    ;(assets || []).forEach(function (a) { linked[a.path] = true })
    var body
    if (sh.loading) body = '<p class="wb-muted">' + esc(t('workbench.shared.loading')) + '</p>'
    else if (!sh.files.length) body = '<p class="wb-muted">' + esc(t(sh.folder ? 'workbench.shared.empty' : 'workbench.shared.none')) + '</p>'
    else {
      body = '<ul class="wb-assets wb-shared-list">' + sh.files.map(function (f) {
        return '<li class="wb-asset wb-row"><div class="wb-row-main">'
          + '<span class="wb-asset-name" title="' + escA(f.project_path || f.path) + '">' + esc(f.name) + '</span> '
          + supportPillHtml(f.support)
          + '</div><div class="wb-row-act">'
          + (linked[f.path]
            ? '<span class="wb-muted">' + esc(t('workbench.shared.linked')) + '</span>'
            : '<button type="button" class="wb-mini-btn" data-wb-act="shared-link" data-wb-path="' + escA(f.path) + '"'
              + ' title="' + escA(t('workbench.shared.link_title')) + '">' + esc(t('workbench.shared.link')) + '</button>')
          + '</div></li>'
      }).join('') + '</ul>'
    }
    return head + '<div class="wb-shared-block">'
      + '<p class="wb-muted">' + esc(sh.folder ? t('workbench.shared.folder', { folder: sh.folder }) : t('workbench.shared.intro')) + '</p>'
      + (sh.folder ? folderBtnsHtml('shared', null, 'short') : '')
      + body
      + '<p class="wb-ctx-actions"><label class="wb-btn" for="wbSharedUpload">\ud83d\udcce ' + esc(sh.uploading ? t('workbench.upload.busy') : t('workbench.shared.upload')) + '</label>'
      + '<input type="file" id="wbSharedUpload" class="wb-file-input" multiple></p>'
      + '<p class="wb-hint">' + esc(t('workbench.shared.hint')) + '</p>'
      + '</div></div>'
  }

  function loadShared(projectId) {
    if (!WB.shared || WB.shared.projectId !== projectId) WB.shared = { projectId: projectId, open: true, folder: null, files: [] }
    WB.shared.loading = true
    render()
    return api('GET', '/api/workbench/shared?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (!WB.shared || WB.shared.projectId !== projectId) return
      WB.shared.loading = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      WB.shared.folder = r.data.folder || null
      WB.shared.files = r.data.files || []
      render()
    })
  }

  function toggleShared() {
    if (!WB.projectId) return
    if (WB.shared && WB.shared.projectId === WB.projectId && WB.shared.open) { WB.shared.open = false; render(); return }
    if (WB.shared && WB.shared.projectId === WB.projectId) WB.shared.open = true
    loadShared(WB.projectId)
  }

  function linkShared(path) {
    var id = WB.selectedId
    if (!id || !path || archived()) return
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/assets/link', { path: path }).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      window.showToast(t(r.data.already ? 'workbench.shared.link_already' : 'workbench.shared.link_done', { name: (r.data.asset && r.data.asset.name) || '' }))
      if (WB.selectedId === id && WB.detail) { WB.detail.assets = r.data.assets || []; render() }
      if (WB.projectId) loadShared(WB.projectId)
    })
  }

  /** Fajlok a projekt kozos taraba (egymas utan; ugyanaz a tartalom ujra csak kerdesre). */
  function uploadShared(fileList) {
    var projectId = WB.projectId
    if (!projectId || archived() || !fileList || !fileList.length || (WB.shared && WB.shared.uploading)) return Promise.resolve()
    var files = []
    for (var i = 0; i < fileList.length; i++) if (fileList[i]) files.push(fileList[i])
    if (!WB.shared || WB.shared.projectId !== projectId) WB.shared = { projectId: projectId, open: true, folder: null, files: [] }
    WB.shared.uploading = true
    render()
    var lang = encodeURIComponent(window._lang || 'hu')
    var errors = []
    var ok = 0
    var chain = Promise.resolve()
    files.forEach(function (f) {
      chain = chain.then(function () {
        var url = '/api/workbench/shared?project=' + encodeURIComponent(projectId) + '&name=' + encodeURIComponent(f.name || 'fajl') + '&lang=' + lang
        return postFile(url, f).then(function (r) {
          if (!r.ok && r.data && r.data.error === 'shared_duplicate') {
            var ex = r.data.existing && r.data.existing.name
            if (window.confirm(t('workbench.shared.duplicate_confirm', { name: f.name || '', existing: ex || f.name || '' }))) return postFile(url + '&force=1', f)
            return { ok: true, skipped: true }
          }
          return r
        }).then(function (r) {
          if (!r.ok) errors.push((f.name ? f.name + ': ' : '') + r.message)
          else if (!r.skipped) ok++
        })
      })
    })
    return chain.then(function () {
      if (WB.shared && WB.shared.projectId === projectId) WB.shared.uploading = false
      if (errors.length) window.showToast(errors.join(' \u2014 '))
      if (ok) window.showToast(t('workbench.shared.upload_done', { n: ok }))
      if (WB.projectId === projectId) loadShared(projectId)
    })
  }

  /** Iratolvasas (1/A): amig egy irat olvasasa tart, par masodpercenkent
   *  frissitjuk az anyagok listajat, hogy a "3/30 oldal" elorehaladjon. */
  function docBusy(a) {
    return !!(a && a.doc && a.present && (a.doc.status === 'pending' || a.doc.status === 'running' || a.doc.status === 'stale' || a.doc.status === 'none'))
  }
  function scheduleDocPoll(id, round) {
    if (WB.docPollTimer) { clearTimeout(WB.docPollTimer); WB.docPollTimer = null }
    var assets = (WB.detail && WB.detail.assets) || []
    // Legfeljebb ~30 percig kerdezunk; utana a kovetkezo megnyitas folytatja.
    round = round || 0
    if (WB.selectedId !== id || !assets.some(docBusy) || round > 600) return
    WB.docPollTimer = setTimeout(function () {
      WB.docPollTimer = null
      if (WB.selectedId !== id || !WB.detail) return
      api('GET', '/api/workbench/items/' + encodeURIComponent(id) + '/assets').then(function (r) {
        if (!r.ok || WB.selectedId !== id || !WB.detail) return
        WB.detail.assets = r.data.assets || []
        render()
        // Az irat elolvasva: a hataridok es idopontok is frissulnek (K-1.17).
        if (!WB.detail.assets.some(docBusy)) refreshDeadlines(id)
        scheduleDocPoll(id, round + 1)
      })
    }, 3000)
  }

  /** Az irat olvasasi allapota a fajl mellett (K-1.1 ... K-1.3). */
  function docStateHtml(a) {
    var d = a && a.doc
    if (!d || !a.present) return ''
    if (d.status === 'done') {
      var canSearchable = d.ocr_pages > 0 && /\.pdf$/i.test(a.name || '') && !/\((keres\u0151|searchable)\)\.pdf$/i.test(a.name || '') && !archived()
      var busy = WB.searchableBusy && WB.searchableBusy[a.project_path]
      var canRedact = /\.pdf$/i.test(a.name || '') && !/\((kitakart|redacted)\)(?: \(\d+\))?\.pdf$/i.test(a.name || '') && !archived()
      return ' <span class="wb-muted wb-doc-state">' + esc(t('workbench.doc.pages', { n: d.pages_total })) + '</span>'
        + (canRedact
          ? ' <button type="button" class="wb-linklike" data-wb-act="redact-open" data-wb-path="' + escA(a.project_path) + '"'
            + ' title="' + escA(t('workbench.redact.open_title')) + '">' + esc(t('workbench.redact.open')) + '</button>'
          : '')
        + (canSearchable
          ? ' <button type="button" class="wb-linklike" data-wb-act="doc-searchable" data-wb-path="' + escA(a.project_path) + '"' + (busy ? ' disabled' : '')
            + ' title="' + escA(t('workbench.doc.searchable_title')) + '">' + esc(t(busy ? 'workbench.doc.searchable_busy' : 'workbench.doc.searchable')) + '</button>'
          : '')
        + (d.low_pages && d.low_pages.length
          ? ' <span class="wb-doc-low" title="' + escA(t('workbench.doc.low_title')) + '">\u26a0 ' + esc(t('workbench.doc.low', { pages: d.low_pages.join(', ') })) + '</span>'
          : '')
    }
    if (d.status === 'failed') return ' <span class="wb-doc-low" title="' + escA(d.error || '') + '">' + esc(t('workbench.doc.failed')) + '</span>'
    return ' <span class="wb-muted wb-doc-state">\u23f3 ' + esc(d.pages_total
      ? t('workbench.doc.reading_n', { done: d.pages_done, total: d.pages_total })
      : t('workbench.doc.reading')) + '</span>'
  }

  /** Kereshető masolat egy szkennelt PDF-bol (K-1.4): az eredeti marad, a masolat melle kerul. */
  function makeSearchable(path) {
    var id = WB.selectedId
    if (!id || !path || archived()) return
    WB.searchableBusy = WB.searchableBusy || {}
    if (WB.searchableBusy[path]) return
    WB.searchableBusy[path] = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/document/searchable', { path: path }).then(function (r) {
      delete WB.searchableBusy[path]
      if (!r.ok) { window.showToast(r.message); render(); return }
      window.showToast(t('workbench.doc.searchable_done', { name: r.data.name || '' }))
      if (WB.selectedId === id && WB.detail) { WB.detail.assets = r.data.assets || WB.detail.assets; render(); scheduleDocPoll(id) }
    })
  }

  // ---- KITAKARAS (#441, K-1.35) ---------------------------------------------
  // Egy PDF-rol masolat, amelyben a szemelyes adatok ki vannak takarva. A Marvin
  // megkeresi oket, a tulajdonos kiveheti a pipat, es nevet adhat hozza; a
  // masolat kepkent keszul ujra, a kitakart szoveg a fajlbol is torlodik.
  var REDACT_CAT = { name: 'name', birth_date: 'birth_date', address: 'address', account: 'account', id_number: 'id_number', email: 'email', phone: 'phone', custom: 'custom' }

  function redactBoxHtml() {
    var r = WB.redact
    var found = (r.scan && r.scan.findings) || []
    var chosen = found.filter(function (f) { return !r.skip[f.id] }).length
    var list = ''
    if (r.scanning) list = '<p class="wb-muted">\u23f3 ' + esc(t('workbench.redact.scanning')) + '</p>'
    else if (r.scan && !found.length) list = '<p class="wb-muted">' + esc(t('workbench.redact.none')) + '</p>'
    else if (found.length) {
      list = '<ul class="wb-redact-list">' + found.map(function (f) {
        return '<li><label><input type="checkbox" data-wb-redact-id="' + escA(f.id) + '"' + (r.skip[f.id] ? '' : ' checked') + (r.busy ? ' disabled' : '') + '> '
          + '<span class="wb-muted">' + esc(t('workbench.redact.page', { n: f.page })) + ' \u00b7 ' + esc(t('workbench.redact.cat.' + (REDACT_CAT[f.category] || 'custom'))) + ':</span> '
          + '<span class="wb-redact-text">' + esc(f.text) + '</span></label></li>'
      }).join('') + '</ul>'
    }
    var unreadable = r.scan && r.scan.unreadable_pages && r.scan.unreadable_pages.length
      ? '<p class="wb-doc-low">\u26a0 ' + esc(t('workbench.redact.unreadable', { pages: r.scan.unreadable_pages.join(', ') })) + '</p>'
      : ''
    var noOcr = r.scan && !r.scan.ocr ? '<p class="wb-hint">' + esc(t('workbench.redact.no_ocr')) + '</p>' : ''
    return '<div class="wb-redact-box" role="group" aria-label="' + escA(t('workbench.redact.title')) + '">'
      + '<p><strong>' + esc(t('workbench.redact.title')) + '</strong></p>'
      + '<p class="wb-hint">' + esc(t('workbench.redact.intro')) + '</p>'
      + list + unreadable + noOcr
      + '<label class="wb-redact-terms-label" for="wbRedactTerms">' + esc(t('workbench.redact.terms')) + '</label>'
      + '<textarea id="wbRedactTerms" class="wb-redact-terms" rows="3" placeholder="' + escA(t('workbench.redact.terms_ph')) + '"' + (r.busy ? ' disabled' : '') + '>' + esc(r.terms || '') + '</textarea>'
      + '<p class="wb-hint">' + esc(t('workbench.redact.terms_hint')) + '</p>'
      + '<p class="wb-ctx-actions">'
      + '<button type="button" class="wb-btn" data-wb-act="redact-scan"' + (r.busy || r.scanning ? ' disabled' : '') + '>' + esc(t('workbench.redact.rescan')) + '</button> '
      + '<button type="button" class="wb-btn wb-btn-primary" data-wb-act="redact-apply"' + (r.busy || r.scanning || !chosen ? ' disabled' : '') + '>'
      + esc(r.busy ? t('workbench.redact.busy') : t('workbench.redact.apply', { n: chosen })) + '</button> '
      + '<button type="button" class="wb-btn" data-wb-act="redact-close"' + (r.busy ? ' disabled' : '') + '>' + esc(t('workbench.warn.cancel')) + '</button>'
      + '</p></div>'
  }

  function redactTerms() {
    return String((WB.redact && WB.redact.terms) || '').split(/\r?\n/).map(function (x) { return x.trim() }).filter(Boolean)
  }

  function redactOpen(path) {
    var id = WB.selectedId
    if (!id || !path || archived()) return
    if (WB.redact && WB.redact.itemId === id && WB.redact.path === path) { WB.redact = null; render(); return }
    WB.redact = { itemId: id, path: path, terms: '', skip: {}, scan: null }
    redactScan()
  }

  function redactScan() {
    var r = WB.redact
    if (!r || r.scanning || r.busy) return
    r.scanning = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(r.itemId) + '/document/redact/scan', { path: r.path, terms: redactTerms() }).then(function (res) {
      if (WB.redact !== r) return
      r.scanning = false
      if (!res.ok) { window.showToast(res.message); render(); return }
      r.scan = res.data
      render()
    })
  }

  function redactApply() {
    var r = WB.redact
    if (!r || r.busy || r.scanning || !r.scan) return
    var skip = Object.keys(r.skip).filter(function (k) { return r.skip[k] })
    r.busy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(r.itemId) + '/document/redact', { path: r.path, terms: redactTerms(), skip: skip }).then(function (res) {
      if (WB.redact === r) r.busy = false
      if (!res.ok) { window.showToast(res.message); render(); return }
      if (WB.redact === r) WB.redact = null
      window.showToast(t(res.data.searchable ? 'workbench.redact.done' : 'workbench.redact.done_image', { name: res.data.name || '', n: res.data.redacted }))
      if (WB.selectedId === r.itemId && WB.detail) { WB.detail.assets = res.data.assets || WB.detail.assets; render(); scheduleDocPoll(r.itemId) }
    })
  }

  /** `withFile`: a fajl a mappabol is torlodik; anelkul csak levetel. Ha a
   *  fajlt mas is hasznalja, a szerver nem torli, es megmondja, ki. */
  function removeAsset(assetId, withFile) {
    var id = WB.selectedId
    if (!id || !assetId || archived()) return
    WB.warn = null
    render()
    api('DELETE', '/api/workbench/items/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(assetId) + (withFile ? '?file=1' : '')).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      if (WB.selectedId === id && WB.detail) { WB.detail.assets = r.data.assets || []; render() }
      window.showToast(t(withFile ? 'workbench.assets.deleted' : 'workbench.assets.removed'))
      if (withFile && WB.shared && WB.shared.open && WB.shared.projectId === WB.projectId) loadShared(WB.projectId)
    })
  }

  /** ATNEVEZES (#441, #478): csak a munkadarab neve valtozik, a mappaja nem (a nevek fuggetlenek). */
  function renameItem(rowId) {
    var id = rowId || WB.selectedId
    if (!id || archived()) return
    var row = rowId ? (WB.items || []).filter(function (x) { return x.id === rowId })[0] : (WB.detail && WB.detail.item)
    if (!row) return
    var cur = row.title
    var title = window.prompt(t('workbench.rename.prompt'), cur)
    if (title === null) return
    title = String(title).trim()
    if (!title || title === cur) return
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/rename', { title: title }).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      window.showToast(t('workbench.rename.done'))
      if (WB.selectedId === id) loadDetail(id)
      if (WB.projectId) load(WB.projectId)
    })
  }

  function tidyItemFolder() {
    var id = WB.selectedId
    if (!id || archived() || WB.tidyBusy) return
    if (!window.confirm(t('workbench.assets.tidy_confirm'))) return
    WB.tidyBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/tidy', {}).then(function (r) {
      WB.tidyBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      var moved = (r.data.moved || []).length
      var shared = (r.data.skipped || []).filter(function (x) { return x.reason === 'shared' }).length
      window.showToast(moved
        ? t('workbench.assets.tidy_done', { n: moved, folder: r.data.folder })
        : (shared ? t('workbench.assets.tidy_shared') : t('workbench.assets.tidy_nothing')))
      if (WB.selectedId === id) loadDetail(id)
      if (WB.projectId) load(WB.projectId)
    })
  }

  // ---- adatvedelem (#441, 7.3, K-1.32 ... K-1.34) ------------------------------
  //
  // "Erzekeny" jeloles a projekten vagy a munkadarabon (a projekte mindenre all).
  // Bekapcsolni barki tudja, KIKAPCSOLNI csak a tulajdonos (a szerver nezi).
  // A "Technikai reszletek" a kimeno adatok naploja: mi, melyik szolgaltatashoz,
  // mikor (K-1.33). A Munkapad Agentje maga is kulso szolgaltatas (Claude): a
  // jeloles nem ot kapcsolja ki, hanem a TOVABBI kulso szolgaltatasokat (K-1.34).

  function itemSensitive(id) {
    if (WB.project && WB.project.sensitive) return true
    return (WB.sensitiveIds || []).indexOf(id) >= 0
  }
  function projectPrivacyHtml() {
    var on = !!WB.project.sensitive
    return '<p class="wb-privacy-row"><span class="' + (on ? 'wb-doc-low' : 'wb-muted') + '">' + esc(t(on ? 'workbench.privacy.project_on' : 'workbench.privacy.project_off')) + '</span>'
      + (archived() ? '' : ' <button type="button" class="wb-linklike" data-wb-act="privacy-project" data-wb-on="' + (on ? '0' : '1') + '" title="' + escA(t('workbench.privacy.hint')) + '"' + (WB.privacyBusy ? ' disabled' : '') + '>'
        + esc(t(on ? 'workbench.privacy.turn_off' : 'workbench.privacy.turn_on_project')) + '</button>')
      + '</p>'
  }
  function itemPrivacyHtml() {
    var p = (WB.detail && WB.detail.privacy) || { sensitive: false, item: false, project: false }
    var line = p.project ? t('workbench.privacy.item_from_project') : t(p.item ? 'workbench.privacy.item_on' : 'workbench.privacy.item_off')
    var btn = archived() || p.project ? ''
      : ' <button type="button" class="wb-linklike" data-wb-act="privacy-item" data-wb-on="' + (p.item ? '0' : '1') + '" title="' + escA(t('workbench.privacy.hint')) + '"' + (WB.privacyBusy ? ' disabled' : '') + '>'
        + esc(t(p.item ? 'workbench.privacy.turn_off' : 'workbench.privacy.turn_on_item')) + '</button>'
    return '<p class="wb-privacy-row"><span class="' + (p.sensitive ? 'wb-doc-low' : 'wb-muted') + '">' + (p.sensitive ? '🔒 ' : '') + esc(line) + '</span>' + btn + '</p>'
      + (p.sensitive ? '<p class="wb-hint">' + esc(t('workbench.privacy.hint')) + '</p>' : '')
  }
  function setPrivacy(scope, on) {
    if (WB.privacyBusy || archived()) return
    if (!on && !window.confirm(t('workbench.privacy.off_confirm'))) return
    var id = WB.selectedId
    var url = scope === 'project'
      ? '/api/workbench/privacy?project=' + encodeURIComponent(WB.projectId)
      : '/api/workbench/items/' + encodeURIComponent(id) + '/privacy'
    WB.privacyBusy = true
    render()
    api('PUT', url, { sensitive: !!on }).then(function (r) {
      WB.privacyBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      window.showToast(t(on ? 'workbench.privacy.saved_on' : 'workbench.privacy.saved_off'))
      if (scope === 'project' && WB.project) {
        WB.project.sensitive = !!r.data.privacy.project
        WB.sensitiveIds = r.data.sensitive_items || WB.sensitiveIds
        if (WB.detail && WB.detail.privacy) {
          WB.detail.privacy.project = WB.project.sensitive
          WB.detail.privacy.sensitive = WB.detail.privacy.project || WB.detail.privacy.item
        }
      } else if (WB.detail && WB.selectedId === id) {
        WB.detail.privacy = r.data.privacy
        var ids = (WB.sensitiveIds || []).filter(function (x) { return x !== id })
        if (r.data.privacy.item) ids.push(id)
        WB.sensitiveIds = ids
      }
      WB.egress = null
      render()
      if (WB.techOpen) loadEgress()
    })
  }

  function loadEgress() {
    var id = WB.selectedId
    if (!id) return
    WB.egress = { itemId: id, loading: true, rows: [], error: null }
    render()
    api('GET', '/api/workbench/items/' + encodeURIComponent(id) + '/privacy').then(function (r) {
      if (WB.selectedId !== id) return
      WB.egress = r.ok ? { itemId: id, loading: false, rows: r.data.egress || [], cost: r.data.ai_cost || null, error: null } : { itemId: id, loading: false, rows: [], error: r.message }
      render()
    })
  }
  function egressRowHtml(e) {
    var who = e.account === 'api_key' ? t('workbench.egress.api_key') : e.account ? t('workbench.egress.account', { account: e.account }) : ''
    var what
    if (e.service === 'web_search') what = t('workbench.egress.what_search', { query: e.query || '' })
    else if (e.service === 'image_ai') what = t('workbench.egress.what_image', { file: e.file || '-', cost: e.cost_usd == null ? t('workbench.egress.cost_unknown') : '$' + Number(e.cost_usd).toFixed(3) })
    else if (e.service === 'google_calendar') what = t('workbench.egress.what_todo', { todo: e.todo || '', due: e.due || '-' })
    else what = t('workbench.egress.what_message', { n: e.message_chars || 0 })
      + ((e.files || []).length ? ' ' + t('workbench.egress.what_files', { files: e.files.join(', ') }) : '')
      + (e.service === 'claude_code' ? ' ' + t('workbench.egress.full_note') : '')
    var st = e.status === 'blocked' ? ' <span class="wb-ok">' + esc(t('workbench.egress.blocked')) + '</span>'
      : e.status === 'failed' ? ' <span class="wb-muted">' + esc(t('workbench.egress.failed')) + '</span>' : ''
    return '<li><span class="wb-muted">' + esc(when(e.at)) + '</span> · <strong>' + esc(t('workbench.egress.service.' + e.service)) + '</strong>'
      + (who ? ' <span class="wb-muted">(' + esc(who) + ')</span>' : '') + '<br>' + esc(what) + st + '</li>'
  }
  /** A munkadarab technikai adatai (K-3.2): ami a fo feluletrol lekerult. */
  function techMetaHtml() {
    var it = WB.detail && WB.detail.item
    if (!it) return ''
    var cur = currentVersion()
    var row = function (k, v) { return v == null || v === '' ? '' : '<li><span class="wb-muted">' + esc(t('workbench.tech.' + k)) + ':</span> ' + esc(String(v)) + '</li>' }
    return '<ul class="wb-tech-meta">'
      + row('status', statusLabel(it.status))
      + row('type', it.type + (it.editor_type ? ' / ' + it.editor_type : ''))
      + row('version', cur ? cur.version_no : null)
      + row('file', it.source_path)
      + row('folder', it.folder)
      + row('created_by', it.created_by)
      + row('id', it.id)
      + '</ul>'
  }

  /** "⋮ Technikai reszletek" (K-1.33, K-3.2): a munkadarab technikai adatai,
   *  es mi ment ki, hova, mikor. */
  function techDetailsHtml() {
    var open = !!WB.techOpen
    var e = WB.egress && WB.egress.itemId === WB.selectedId ? WB.egress : null
    var body = ''
    if (open) {
      body = techMetaHtml()
        + '<p class="wb-hint">' + esc(t('workbench.egress.hint')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.egress.ocr_local')) + '</p>'
      if (e && e.cost && e.cost.calls) {
        body += '<p class="wb-hint">' + esc(t('workbench.egress.cost_total', { usd: '$' + Number(e.cost.usd).toFixed(3), n: e.cost.calls })
          + (e.cost.unknown ? ' ' + t('workbench.egress.cost_total_unknown', { n: e.cost.unknown }) : '')) + '</p>'
      }
      if (!e || e.loading) body += '<p class="wb-muted">' + esc(t('workbench.egress.loading')) + '</p>'
      else if (e.error) body += '<p class="wb-doc-low">' + esc(t('workbench.egress.load_failed')) + ' ' + esc(e.error) + '</p>'
      else if (!e.rows.length) body += '<p class="wb-muted">' + esc(t('workbench.egress.empty')) + '</p>'
      else body += '<ul class="wb-egress">' + e.rows.map(egressRowHtml).join('') + '</ul>'
    }
    return '<div class="wb-ctx-block wb-tech"><p class="wb-ctx-actions"><button type="button" class="wb-linklike" data-wb-act="tech-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + '⋮ ' + esc(t('workbench.egress.title')) + '</button></p>' + body + '</div>'
  }

  /** Egy verzio "apro"-e (K-2.4): nev, ok es visszaallitas nelkul keszult --
   *  a regi, minden mozdulatra keszult verziok ilyenek. A jelenlegi sosem apro. */
  function versionIsSmall(v, currentId) {
    return v.id !== currentId && !v.label && !v.restored_from_no && !v.reason
  }

  /** A nap, amikor a verzio keszult ("szept. 27."), a felulet nyelven. */
  function versionDay(sec) {
    try {
      return new Date(sec * 1000).toLocaleDateString(window._lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric' })
    } catch (_e) { return '-' }
  }

  /** Legalabb ennyi egymas utani apro verzio csukodik ossze egy sorba. */
  var VERSION_GROUP_MIN = 3

  /** A verziolista sorai (K-2.4): az ugyanazon a napon keszult, egymas utani
   *  apro verziok egy osszecsukhato sorba kerulnek ("12 apro modositas, szept.
   *  27."). Semmi nem torlodik: kinyitva ugyanazok a sorok latszanak. A nevvel
   *  vagy okkal mentett, a visszaallitott es a jelenlegi verzio mindig kulon sor. */
  function versionGroups(versions, currentId) {
    var out = []
    var run = []
    var flush = function () {
      if (run.length >= VERSION_GROUP_MIN) {
        out.push({ many: true, list: run, key: run[run.length - 1].id, day: versionDay(run[0].created_at) })
      } else {
        run.forEach(function (v) { out.push({ many: false, v: v }) })
      }
      run = []
    }
    versions.forEach(function (v) {
      if (!versionIsSmall(v, currentId)) { flush(); out.push({ many: false, v: v }); return }
      if (run.length && versionDay(run[0].created_at) !== versionDay(v.created_at)) flush()
      run.push(v)
    })
    flush()
    return out
  }

  function contextPanelHtml() {
    var rows = []
    rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.project')) + '</h3>'
      + '<p>' + esc(WB.project ? WB.project.name : '-') + (WB.project && WB.project.sensitive ? ' <span class="wb-lock">🔒</span>' : '') + '</p>'
      + (WB.project ? projectPrivacyHtml() : '') + '</div>')
    if (WB.detail) {
      var it = WB.detail.item
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p>' + workSeqHtml(it) + esc(it.title) + (archived() ? '' : ' <button type="button" class="wb-linklike" data-wb-act="item-rename">'
          + esc(t('workbench.rename.button')) + '</button>') + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.created', { when: when(it.created_at) })) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.updated', { when: when(it.updated_at) })) + '</p>'
        + itemPrivacyHtml() + '</div>')
      rows.push(assetsBlockHtml())
      if (!archived()) rows.push(sharedBlockHtml(WB.detail.assets || []))
      var versions = WB.detail.versions || []
      var ro = archived() || WB.versionBusy
      var versionRowHtml = function (v) {
        var current = v.id === it.current_version_id
        // A JELENLEGIT nincs mire visszaallitani, de torolheto: akkor az
        // alatta levo toltodik be (Boss, 2026-09-29). Az EGYETLEN verzio
        // torlese az egesz munkadarabot a Lomtarba teszi ("1A"), piros
        // figyelmezteto keret utan. A Torles vegleges (#443).
        var canDelete = !ro
        var only = versions.length === 1
        var acts = ((current || ro) ? '' : ('<button type="button" class="wb-mini-btn" data-wb-act="version-restore"'
          + ' data-wb-version="' + escA(v.id) + '">' + esc(t('workbench.versions.restore')) + '</button>'))
          + (canDelete ? ('<button type="button" class="wb-mini-btn wb-mini-danger" data-wb-act="version-delete"'
          + ' data-wb-version="' + escA(v.id) + '" title="'
          + escA(t(only ? 'workbench.versions.delete_last_title' : current ? 'workbench.versions.delete_current_title' : 'workbench.versions.delete_title')) + '">'
          + esc(t('workbench.versions.delete')) + '</button>') : '')
        return '<li class="wb-row"><div class="wb-row-main">' + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) }))
          + (current ? ' <span class="wb-pill">' + esc(t('workbench.versions.current')) + '</span>' : '')
          + (v.label ? ' <strong class="wb-ver-label">' + esc(v.label) + '</strong>' : '')
          + (v.restored_from_no ? ' <span class="wb-muted">'
            + esc(t('workbench.versions.restored_from', { n: v.restored_from_no })) + '</span>' : '')
          + (v.reason && v.reason !== 'manual' && t('workbench.versions.reason_' + v.reason) !== 'workbench.versions.reason_' + v.reason
            ? ' <span class="wb-muted">' + esc(t('workbench.versions.reason_' + v.reason)) + '</span>' : '')
          + '</div>' + (acts ? '<div class="wb-row-act">' + acts + '</div>' : '') + '</li>'
      }
      // Order by importance (Boss, TG 1817): what a version IS, then Save as new
      // version, then the two Open buttons side by side, the list last.
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.versions')) + (versions.length ? ' (' + versions.length + ')' : '') + '</h3>'
        + '<p class="wb-hint">' + esc(t('workbench.versions.hint')) + '</p>'
        + (ro ? '' : '<p class="wb-ctx-actions"><button type="button" class="wb-btn" data-wb-act="version-new">'
          + esc(t('workbench.versions.save_new')) + '</button></p>')
        + (versions.length ? folderBtnsHtml('versions', null, 'short') : '')
        + (versions.length
          ? '<ul class="wb-versions">' + versionGroups(versions, it.current_version_id).map(function (g) {
            if (!g.many) return versionRowHtml(g.v)
            var open = !!WB.verOpen[g.key]
            return '<li class="wb-row wb-ver-group"><div class="wb-row-main">'
              + '<button type="button" class="wb-linklike" data-wb-act="version-group" data-wb-key="' + escA(g.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
              + (open ? '▾ ' : '▸ ') + esc(t('workbench.versions.group', { n: g.list.length, day: g.day })) + '</button>'
              + ' <span class="wb-muted">' + esc(t('workbench.versions.group_range', { from: g.list[g.list.length - 1].version_no, to: g.list[0].version_no })) + '</span>'
              + '</div></li>'
              + (open ? g.list.map(versionRowHtml).join('') : '')
          }).join('') + '</ul>'
            + (WB.warn && WB.warn.kind === 'last-version' && versions.length === 1
              ? warnBoxHtml(t('workbench.versions.last_warn'), 'last-version-trash', t('workbench.versions.last_warn_ok'), it.id)
              : '')
          : '<p class="wb-muted">' + esc(t('workbench.context.no_versions')) + '</p>')
        + '</div>')
      // A KOR BEZARASA (spec 8): letoltod, megszerkeszted a sajat gepeden,
      // visszatoltod -- es UJ VERZIO lesz belole. A regi megmarad. Kulon blokk,
      // hogy ne folyjon ossze a verziolistaval.
      if (!ro) {
        rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.versions.upload_document')) + '</h3>'
          + '<p class="wb-hint">' + esc(t('workbench.versions.upload_document_hint')) + '</p>'
          + '<p class="wb-ctx-actions"><label class="wb-btn wb-part-upload" for="wbDocUpload">\ud83d\udcc4 '
          + esc(WB.docBusy ? t('workbench.versions.uploading') : t('workbench.versions.upload_document_btn')) + '</label>'
          + '<input type="file" id="wbDocUpload" class="wb-file-input"></p>'
          + '</div>')
      }
      rows.push(techDetailsHtml())
    } else {
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p class="wb-muted">' + esc(t('workbench.context.no_selection')) + '</p></div>')
    }
    return '<section class="wb-panel wb-panel-context' + (WB.panel === 'context' ? ' wb-panel-current' : '') + '" data-wb-panel-body="context">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.context')) + '</h2>'
      + rows.join('') + '</section>'
  }

  // ---- agent-chat (3. fazis) -------------------------------------------------
  //
  // A chat SOSE szurke. Boss, 2026-09-21: "Agent-chat NE legyen szurke/letiltva,
  // meg akkor sem, ha nincs munkadarab kivalasztva." Ezert a bevitel MINDIG
  // eleheto: ha nincs szolgaltato beallitva, nem a mezot tiltjuk le, hanem a
  // valaszban mondjuk meg emberi mondattal, hogy mi hianyzik es hol lehet
  // megadni -- ugyanabbol a feluletbol, terminal nelkul.

  /** Melyik beszelgetes: a kivalasztott munkadarabe, vagy a projekte. */
  function chatKey() { return WB.selectedId || ('project:' + WB.projectId) }

  function chatState() {
    if (!WB.chat[chatKey()]) {
      WB.chat[chatKey()] = { turns: [], loaded: false, loading: false, error: null, sessionId: null }
    }
    return WB.chat[chatKey()]
  }

  /** A szolgaltato + keret allapota. Nem talalgat: amit a szerver mond, az megy ki. */
  function loadChatStatus() {
    if (!WB.projectId) return
    WB.chatStatus = null
    WB.chatSide = null
    WB.chatStatusError = null
    api('GET', '/api/workbench/agent/status?project=' + encodeURIComponent(WB.projectId)).then(function (r) {
      if (!WB.open) return
      if (r.ok) { WB.chatStatus = r.data; WB.chatStatusError = null }
      else { WB.chatStatus = null; WB.chatStatusError = r.message }
      renderChat()
    })
  }

  /** A mar lezajlott beszelgetes visszaolvasasa. URES LISTA NEM UGYANAZ, mint a
   *  "nem latok oda": a hibat kulon mondjuk ki. */
  function loadChatHistory() {
    var st = chatState()
    if (st.loaded || st.loading || !WB.projectId) return
    st.loading = true
    var url = WB.selectedId
      ? '/api/workbench/agent/session?workItem=' + encodeURIComponent(WB.selectedId)
      : '/api/workbench/agent/session?project=' + encodeURIComponent(WB.projectId)
    api('GET', url).then(function (r) {
      st.loading = false
      if (!r.ok) { st.error = r.message; renderChat(); return }
      st.loaded = true
      st.error = null
      st.sessionId = r.data.session ? r.data.session.id : null
      var regi = (r.data.messages || []).filter(function (m) { return m.role !== 'tool' }).map(function (m) {
        // Regi (a #401 elotti) sor, ami csak nyers eszkozhivas-JSON volt: a
        // gepi szoveg helyett emberi eszkoz-sor (#406). Az eredmenyt nem
        // tudjuk, ezert nem is allitunk rola semmit.
        var raw = m.role !== 'user' ? splitRawToolText(m.content) : null
        return {
          role: m.role === 'user' ? 'user' : 'agent',
          text: raw ? '' : (m.content || ''),
          tools: raw ? raw.map(function (n) { return { name: n, status: 'history', detail: '', approvalId: '' } }) : [],
          notices: [], error: null, done: true,
          model: m.model || null,
          via: m.via_kind === 'api_key' ? { kind: 'api_key' }
            : m.via_kind === 'account' && m.via_account ? { kind: 'account', account: m.via_account } : null,
        }
      })
      // ELE fuzzuk, nem felulirjuk. A betoltes kozben a felhasznalo mar
      // irhatott (eppen azert nem szurke a mezo); a kesve beerkezo elozmeny
      // nem torolheti le a kepernyorol a sajat mondatat es a valaszt.
      attachHistoryTools(regi, r.data.messages || [], r.data.toolCalls || [])
      st.turns = regi.concat(st.turns)
      // The freshly loaded history opens at its latest message.
      WB.chatForceBottom = true
      renderChat()
      // Elnavigalas / ujratoltes utan (Boss, 2026-09-28): ha a valasz a
      // szerveren meg KESZUL, azt mutatjuk es megvarjuk -- nem "semmi nem
      // fut"-ot. Ha nem fut semmi, a kozben sorba allitott uzenet most megy el.
      if (r.data.running && !WB.chatStreaming) enterChatWatch()
      else flushChatQueue()
    })
  }

  // ---- a szerveren meg futo valasz figyelese -------------------------------
  //
  // A valasz a szerveren akkor is vegigfut, ha a felhasznalo kozben
  // elkattintott (a bongeszo kapcsolata ilyenkor megszakad). Visszaterve a
  // session-lekeres `running` mezoje mondja meg, hogy meg keszul; addig
  // idonkent ujrakerdezzuk, es amint kesz, a kesz valaszt a szerverrol toltjuk be.
  var CHAT_WATCH_MS = 3000

  function chatSessionUrl() {
    return WB.selectedId
      ? '/api/workbench/agent/session?workItem=' + encodeURIComponent(WB.selectedId)
      : '/api/workbench/agent/session?project=' + encodeURIComponent(WB.projectId)
  }

  function enterChatWatch() {
    var st = chatState()
    var placeholder = { role: 'agent', text: '', tools: [], notices: [t('workbench.chat.resumed_running')], error: null, done: false, watching: true }
    // A keszulo valasz a sorba allitott uzenetek ELE kerul: az a korabbi kerdesre felel.
    var at = st.turns.length
    for (var i = 0; i < st.turns.length; i++) { if (st.turns[i].queued) { at = i; break } }
    st.turns.splice(at, 0, placeholder)
    WB.chatStreaming = true
    WB.chatActivityClock = { startedAt: Date.now(), lastEventAt: Date.now() }
    startChatActivityTicker()
    renderChat()
    scheduleChatWatch(chatKey())
  }

  function scheduleChatWatch(key) {
    if (WB.chatWatch) clearTimeout(WB.chatWatch.timer)
    WB.chatWatch = { key: key, timer: setTimeout(function () { pollChatWatch(key) }, CHAT_WATCH_MS) }
  }

  function endChatWatch() {
    if (WB.chatWatch) clearTimeout(WB.chatWatch.timer)
    WB.chatWatch = null
    stopChatActivityTicker()
    WB.chatStreaming = false
  }

  function pollChatWatch(key) {
    if (!WB.open) { endChatWatch(); return }
    if (chatKey() !== key) {
      // Mas beszelgetesre valtott: ezt a figyelest elengedjuk, es a regi
      // beszelgetes visszaterve ujratoltodik (a szerver mondja meg, mi lett).
      var old = WB.chat[key]
      if (old) { old.loaded = false; old.turns = old.turns.filter(function (x) { return x.queued }) }
      endChatWatch()
      renderChat()
      return
    }
    api('GET', chatSessionUrl()).then(function (r) {
      if (!WB.open || chatKey() !== key || !WB.chatWatch) return
      if (!r.ok) { scheduleChatWatch(key); return } // atmeneti hiba: tovabb figyelunk
      if (r.data && r.data.running) {
        if (WB.chatActivityClock) WB.chatActivityClock.lastEventAt = Date.now()
        scheduleChatWatch(key)
        return
      }
      endChatWatch()
      // The answer that finished meanwhile may have changed the open work item (#462).
      scheduleLiveRefresh()
      reloadChatHistory()
    })
  }

  /** A naplo ujratoltese a szerverrol; a meg el nem kuldott (sorban allo)
   *  uzenetek megmaradnak, es a betoltes utan elmennek. */
  function reloadChatHistory() {
    refreshSelectedAfterTurn()
    var st = chatState()
    st.turns = st.turns.filter(function (x) { return x.queued })
    st.loaded = false
    st.loading = false
    loadChatHistory()
  }

  /** A valasz kozben irt uzenet(ek) elkuldese, amint a futo valasz kesz. */
  function flushChatQueue() {
    if (WB.chatStreaming) return
    var st = chatState()
    var q = st.turns.filter(function (x) { return x.role === 'user' && x.queued })
    if (!q.length) return
    for (var i = 0; i < q.length; i++) q[i].queued = false
    startChatTurn(q.map(function (x) { return x.text }).join('\n\n'))
  }

  function chatStatusHtml() {
    if (WB.chatStatusError) {
      return '<span class="wb-chat-state wb-chat-state-bad">' + esc(WB.chatStatusError) + '</span>'
    }
    if (!WB.chatStatus) {
      return '<span class="wb-chat-state wb-muted">' + esc(t('workbench.chat.status_loading')) + '</span>'
    }
    var s = WB.chatStatus
    var bits = []
    if (s.provider && s.provider.available) {
      bits.push(esc(s.provider.account
        ? t('workbench.chat.provider_on_account', { model: s.provider.model || '-', account: s.provider.account })
        : t('workbench.chat.provider_on', { model: s.provider.model || '-' })))
    } else {
      bits.push('<span class="wb-chat-state-bad">' + esc((s.provider && s.provider.message) || t('workbench.chat.provider_off')) + '</span>')
    }
    if (s.usage) {
      // A MERETLEN keret NEM nulla szazalek.
      bits.push(s.usage.measured
        ? esc(t('workbench.chat.usage', { pct: s.usage.usedPct }))
        : esc(s.usage.message || t('workbench.chat.usage_unknown')))
    }
    if (s.allowed === false && s.blockedReason) {
      bits.push('<span class="wb-chat-state-bad">' + esc(s.blockedReason) + '</span>')
    }
    return '<span class="wb-chat-state">' + bits.join(' · ') + '</span>'
  }

  /** A modell-lenyilo (#454, Boss TG 2125): NEM csak Claude -- minden, amit a
   *  Marvin ezen a gepen tud (a lista a /api/models/available-bol jon, ugyanaz a
   *  forras, mint az agens-beallitasoknal). Ami kulcs nelkul nem hasznalhato, azt
   *  KI KELL MONDANI (letiltott sor + hova menjen a felhasznalo), nem eltuntetni. */
  function chatModelSelectHtml(current) {
    var m = WB.chatModels
    var known = {}
    function opts(list) {
      return (list || []).map(function (x) {
        known[x.id] = true
        return '<option value="' + escA(x.id) + '"' + (x.id === current ? ' selected' : '') + '>' + esc(x.label) + '</option>'
      }).join('')
    }
    // A group whose key is missing still shows up (disabled, with the reason): an empty list
    // means "no key yet", not "no such models".
    function keyedGroup(configured, labelKey, list, nokeyKey) {
      if (configured) return '<optgroup label="' + escA(t(labelKey)) + '">' + opts(list) + '</optgroup>'
      return '<optgroup label="' + escA(t(labelKey)) + '"><option disabled>' + esc(t(nokeyKey)) + '</option></optgroup>'
    }
    var html = '<select class="wb-input" id="wbChatModel">'
      + '<option value=""' + (current ? '' : ' selected') + '>' + esc(t('workbench.chat.setup_model_default')) + '</option>'
    if (m) {
      var claude = (m.claude || []).concat(m.claudeUj || [])
      html += '<optgroup label="' + escA(t('workbench.chat.model_group_claude')) + '">' + opts(claude) + '</optgroup>'
      html += keyedGroup(m.glmConfigured, 'workbench.chat.model_group_glm', m.glm, 'workbench.chat.model_glm_nokey')
      html += keyedGroup(m.deepseekConfigured, 'workbench.chat.model_group_deepseek', m.deepseek, 'workbench.chat.model_deepseek_nokey')
      // OpenRouter (ChatGPT, Gemini, ... via one key): auto-per-tier first, then the curated manual list.
      if (m.openrouterConfigured && m.openrouter) {
        var auto = (m.openrouter.tiers || []).map(function (tr) { return { id: tr.autoId, label: tr.label } })
        html += '<optgroup label="' + escA(t('workbench.chat.model_group_openrouter_auto')) + '">' + opts(auto) + '</optgroup>'
        var manual = (m.openrouterManual || []).map(function (x) { return { id: x.id, label: x.name || x.id } })
        if (manual.length) html += '<optgroup label="' + escA(t('workbench.chat.model_group_openrouter_manual')) + '">' + opts(manual) + '</optgroup>'
      } else {
        html += '<optgroup label="' + escA(t('workbench.chat.model_group_openrouter')) + '"><option disabled>' + esc(t('workbench.chat.model_openrouter_nokey')) + '</option></optgroup>'
      }
    }
    // #455: local models (Ollama), the same source as the agent settings. When it
    // does not run or holds no chat model, the group says so instead of vanishing.
    var ol = WB.chatOllama
    if (ol) {
      var local = (ol.models || []).map(function (x) { return { id: x.name, label: x.size ? x.name + ' (' + x.size + ')' : x.name } })
      var why = ol.verdict === 'unreachable' ? t('workbench.chat.model_ollama_unreachable', { url: ol.url || '' })
        : ol.verdict === 'check_failed' ? t('workbench.chat.model_ollama_check_failed', { error: ol.error || '' })
          : ol.verdict === 'embed_only' ? t('workbench.chat.model_ollama_embed_only')
            : t('workbench.chat.model_ollama_no_models')
      html += '<optgroup label="' + escA(t('workbench.chat.model_group_ollama')) + '">'
        + (local.length ? opts(local) : '<option disabled>' + esc(why) + '</option>') + '</optgroup>'
    }
    // A mar elmentett, de a listaban nem szereplo ertek sose tunjon el csendben.
    if (current && !known[current]) html += '<option value="' + escA(current) + '" selected>' + esc(current) + '</option>'
    return html + '</select>'
  }

  /** A modell beallitasa UGYANEBBOL a feluletbol -- terminal nelkul. Sajat
   *  API-kulcs mezo nincs (#404): egyetlen ut a bejelentkezett elofizetes. */
  function chatSetupHtml() {
    var cfg = WB.chatConfig || { WORKBENCH_MODEL: '' }
    return '<form class="wb-chat-setup" id="wbChatSetup">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_intro')) + '</p>'
      + '<label class="wb-label" for="wbChatModel">' + esc(t('workbench.chat.setup_model_label')) + '</label>'
      + chatModelSelectHtml(cfg.WORKBENCH_MODEL || '')
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_model_hint')) + '</p>'
      + '<div class="wb-fullmode-note">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.fullmode_hint')) + '</p>'
      + '<button type="button" class="wb-linklike" data-wb-act="goto-fullmode">' + esc(t('workbench.chat.fullmode_open')) + '</button>'
      + '</div>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="chat-setup-save"' + (WB.chatSetupBusy ? ' disabled' : '') + '>'
      + esc(WB.chatSetupBusy ? t('workbench.chat.setup_saving') : t('workbench.chat.setup_save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="chat-setup-close">' + esc(t('common.cancel')) + '</button>'
      + '</div></form>'
  }

  /** Az eszkoz EMBERI neve (#406). Ismeretlen (uj) eszkoznel a gepi nev marad
   *  -- inkabb latszodjon valami, mint semmi. */
  function toolLabel(name) {
    var key = 'workbench.tool.' + String(name || '')
    var s = t(key)
    return s && s !== key ? s : String(name || '')
  }

  /** A mentett eszkozfutasok visszaolvasasa a Parancsfutasok savba (#434,
   *  Boss 2026-09-29: "Hol van ketteosztva? Meg mindig nem latom."). Eddig az
   *  elozmeny csak a szoveget hozta vissza, igy F5 / elnavigalas utan a sav
   *  eltunt. Minden futas ahhoz a valaszhoz kerul, amelyik UTANA mentodott;
   *  ami a legutolso valasz utan futott, az a legutolso ugynok-fordulohoz. */
  function attachHistoryTools(turns, messages, calls) {
    if (!calls.length) return
    var shown = messages.filter(function (m) { return m.role !== 'tool' })
    var lastAgent = -1
    for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'agent') { lastAgent = i; break } }
    calls.forEach(function (c) {
      var at = -1
      for (var j = 0; j < shown.length; j++) {
        if (shown[j].role !== 'user' && shown[j].created_at >= c.started_at) { at = j; break }
      }
      if (at < 0) at = lastAgent
      if (at < 0 || !turns[at]) return
      var detail = ''
      try { detail = (JSON.parse(c.input_json || 'null') || {}).detail || '' } catch (_e) { detail = '' }
      if (typeof detail !== 'string') detail = ''
      turns[at].tools.push({
        name: c.tool_name,
        // A mar nem futo, de "running"-kent maradt sor (ujrainditas) nem allit semmit.
        status: c.status === 'running' ? 'history' : c.status,
        detail: detail,
        approvalId: c.approval_id || '',
      })
    })
  }

  /** Csak-eszkozhivas elozmeny-sor (a #401 elotti, nyers `{"tool":...}` szoveg)
   *  -> eszkoz-sorok. A nyers JSON soha nem kerul a kepernyore (#406, msg #15). */
  var RAW_TOOL_RX = /^\s*(\{"tool"\s*:[\s\S]*\})\s*$/
  function splitRawToolText(text) {
    var s = String(text || '')
    if (!RAW_TOOL_RX.test(s)) return null
    var names = []
    var rx = /"tool"\s*:\s*"([^"]+)"/g
    var m
    while ((m = rx.exec(s))) { if (names.indexOf(m[1]) < 0) names.push(m[1]) }
    return names.length ? names : null
  }

  /** Mit csinal MOST az agens (#406): Gondolkodik / Dolgozik (melyik eszkoz) /
   *  Valaszol / Jovahagyasra var / Kesz / Hiba / Nem jott valasz / Tetlen.
   *  A forras a stream TENYLEGES esemenyei -- nem becsles. */
  // Az "elakadhatott" figyelmeztetes csak HOSSZU csend utan (#434, Boss:
  // "addig ne irjon ki feleslegesen ilyet"): a villogo potty mutatja, hogy dolgozik,
  // a korai figyelmeztetes pedig indokolatlan leallitasra csabit.
  var CHAT_STALL_MS = 5 * 60 * 1000
  function chatActivity(now) {
    var st = chatState()
    var last = null
    for (var i = st.turns.length - 1; i >= 0; i--) { if (st.turns[i].role === 'agent') { last = st.turns[i]; break } }
    if (WB.chatStreaming && last) {
      var a = WB.chatActivityClock || {}
      var n = typeof now === 'number' ? now : Date.now()
      var sec = a.startedAt ? Math.max(0, Math.round((n - a.startedAt) / 1000)) : 0
      var silent = a.lastEventAt ? n - a.lastEventAt : 0
      var run = null
      var wait = null
      for (var j = last.tools.length - 1; j >= 0; j--) {
        if (!run && last.tools[j].status === 'running') run = last.tools[j]
        if (!wait && last.tools[j].status === 'needs_approval') wait = last.tools[j]
      }
      var label = run ? t('workbench.chat.act_tool', { tool: toolLabel(run.name) })
        : last.text ? t('workbench.chat.act_writing')
        : t('workbench.chat.act_thinking')
      var kind = 'busy'
      if (!run && wait) { label = t('workbench.chat.act_waiting_approval', { tool: toolLabel(wait.name) }); kind = 'wait' }
      var extra = t('workbench.chat.act_elapsed', { s: sec })
      if (silent >= CHAT_STALL_MS) {
        extra = t('workbench.chat.act_stalled', { s: Math.round(silent / 1000) })
        kind = 'stalled'
      }
      // K-0.7: "Sorban: N" -- hany uzenet var a futo valasz mogott.
      var waiting = st.turns.filter(function (x) { return x.role === 'user' && x.queued }).length
      if (waiting) extra += ' · ' + t('workbench.chat.act_queued', { n: waiting })
      return { kind: kind, label: label, extra: extra }
    }
    if (!last) return { kind: 'idle', label: t('workbench.chat.act_idle'), extra: '' }
    if (last.error) return { kind: 'bad', label: t('workbench.chat.act_error'), extra: '' }
    if (last.aborted) return { kind: 'idle', label: t('workbench.chat.act_stopped'), extra: '' }
    if (turnIsEmpty(last)) return { kind: 'bad', label: t('workbench.chat.act_no_answer'), extra: '' }
    return { kind: 'done', label: t('workbench.chat.act_done'), extra: '' }
  }

  function turnIsEmpty(turn) {
    return !turn.text && !(turn.tools && turn.tools.length) && !(turn.notices && turn.notices.length) && !turn.error
  }

  function chatActivityHtml() {
    var a = chatActivity()
    return '<div class="wb-chat-activity wb-chat-activity-' + a.kind + '" id="wbChatActivity" role="status" aria-live="polite">'
      + '<span class="wb-chat-activity-dot" aria-hidden="true"></span>'
      + '<span class="wb-chat-activity-label">' + esc(a.label) + '</span>'
      + (a.extra ? ' <span class="wb-muted wb-chat-activity-extra">' + esc(a.extra) + '</span>' : '')
      + '</div>'
  }

  /** Masodpercenkenti frissites streameles kozben -- CSAK a jelzo sort irja
   *  at, a naplot es a beviteli mezot nem (fokusz, gorgetes marad). */
  function startChatActivityTicker() {
    stopChatActivityTicker()
    if (typeof setInterval !== 'function') return
    WB.chatActivityTimer = setInterval(function () {
      if (!WB.chatStreaming) { stopChatActivityTicker(); return }
      var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatActivity') : null
      if (el && typeof el.outerHTML === 'string') el.outerHTML = chatActivityHtml()
    }, 1000)
  }
  function stopChatActivityTicker() {
    if (WB.chatActivityTimer && typeof clearInterval === 'function') clearInterval(WB.chatActivityTimer)
    WB.chatActivityTimer = null
  }

  function toolLineHtml(tool) {
    var cls = tool.status === 'error' || tool.status === 'blocked' ? ' wb-tool-bad'
      : tool.status === 'needs_approval' ? ' wb-tool-wait' : ''
    return '<div class="wb-tool' + cls + '">'
      + '<span class="wb-tool-name" title="' + escA(tool.name) + '">' + esc(toolLabel(tool.name)) + '</span> '
      + esc(t('workbench.chat.tool_' + tool.status))
      + (tool.detail ? ' <span class="wb-muted">' + esc(tool.detail) + '</span>' : '')
      + (tool.approvalId ? ' <span class="wb-muted">' + esc(t('workbench.chat.approval_id', { id: tool.approvalId })) + '</span>' : '')
      + '</div>'
  }

  /** Melyik fiokkal / modellel ment a valasz (#402). Ha nem tudjuk (regi sor),
   *  nem irunk semmit -- nem talalgatunk. */
  function turnViaHtml(turn) {
    if (turn.role === 'user' || !turn.via) return ''
    var model = turn.model || '-'
    var line = turn.via.kind === 'api_key'
      ? t('workbench.chat.via_api_key', { model: model })
      : t('workbench.chat.via_account', { account: turn.via.account || '-', model: model })
    return '<div class="wb-turn-via">' + esc(line) + '</div>'
  }

  function turnHtml(turn, index) {
    var who = turn.role === 'user' ? t('workbench.chat.you') : t('workbench.chat.agent')
    var body = ''
    if (turn.text) body += '<div class="wb-turn-text">' + esc(turn.text) + '</div>'
    if (turn.text && turn.role !== 'user' && typeof index === 'number') body += '<div class="wb-turn-tts">' + ttsButtonHtml('turn:' + index) + '</div>'
    // Az eszkozfutasok NEM itt latszanak, hanem a kulon also savban (Boss,
    // 2026-09-29: "ezt az egesz chat ablakot ketté kene osztani"): a sok
    // "Parancs futtatasa kesz" sor felfele tolta a valaszt, fel kellett tekerni.
    if (turn.tools && turn.tools.length && !turn.text) {
      body += '<div class="wb-turn-notice wb-turn-tools-below">' + esc(t('workbench.chat.tools_below', { n: turn.tools.length })) + '</div>'
    }
    if (turn.notices && turn.notices.length) {
      body += turn.notices.map(function (n) { return '<div class="wb-turn-notice">' + esc(n) + '</div>' }).join('')
    }
    if (turn.error) body += '<div class="info-box depo-bad">' + esc(turn.error) + '</div>'
    if (turn.aborted) {
      // K-0.8: a megallitott (felbehagyott) valaszt egy gombbal lehet folytattatni.
      var st0 = chatState(), last = st0.turns.length - 1
      var canContinue = typeof index === 'number' && index === last && turn.role === 'agent' && !st0.turns.some(function (x) { return x.queued })
      body += '<div class="wb-turn-notice">' + esc(t('workbench.chat.stopped'))
        + (canContinue ? ' <button type="button" class="btn-secondary wb-chat-unqueue" data-wb-act="chat-continue">' + esc(t('workbench.chat.continue')) + '</button>' : '')
        + '</div>'
    }
    if (turn.queued) {
      // Sorban allo uzenet: visszavonhato, amig el nem ment (#434).
      body += '<div class="wb-turn-notice wb-turn-queued">' + esc(t('workbench.chat.queued'))
        + (typeof index === 'number'
          ? ' <button type="button" class="btn-secondary wb-chat-unqueue" data-wb-act="chat-edit-queued" data-wb-turn="' + index + '">'
            + esc(t('workbench.chat.edit_queued')) + '</button>'
            + ' <button type="button" class="btn-secondary wb-chat-unqueue" data-wb-act="chat-unqueue" data-wb-turn="' + index + '">'
            + esc(t('workbench.chat.unqueue')) + '</button>'
          : '')
        + '</div>'
    }
    if (!body && turn.role === 'agent') {
      body = turn.done
        ? '<div class="wb-turn-notice">' + esc(t('workbench.chat.no_answer')) + '</div>'
        : '<div class="wb-turn-text wb-muted">' + esc(t('workbench.chat.thinking')) + '</div>'
    }
    body += turnViaHtml(turn)
    return '<div class="wb-turn wb-turn-' + (turn.role === 'user' ? 'user' : 'agent') + '">'
      + '<div class="wb-turn-who">' + esc(who) + '</div>' + body + '</div>'
  }

  function chatLogHtml() {
    var st = chatState()
    if (st.error) return '<div class="info-box depo-bad">' + esc(st.error) + '</div>'
    if (!st.loaded && st.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    if (!st.turns.length) {
      return '<p class="wb-muted wb-chat-hello">' + esc(WB.selectedId
        ? t('workbench.chat.hello_item')
        : t('workbench.chat.hello_project')) + '</p>'
    }
    return st.turns.map(turnHtml).join('')
  }

  /** Az also sav: az osszes fordulo eszkozfutasa, fordulonkent elvalasztva.
   *  Ures, ha meg nem futott eszkoz -- akkor a sav nem is latszik. */
  function chatToolsHtml() {
    var st = chatState()
    var groups = []
    var total = 0
    for (var i = 0; i < st.turns.length; i++) {
      var tools = st.turns[i].tools
      if (!tools || !tools.length) continue
      total += tools.length
      groups.push('<div class="wb-chat-tools-group">' + tools.map(toolLineHtml).join('') + '</div>')
    }
    if (!total) return ''
    return '<div class="wb-chat-tools-head">' + esc(t('workbench.chat.tools_title', { n: total })) + '</div>'
      + '<div class="wb-chat-tools" id="wbChatTools">' + groups.join('') + '</div>'
  }

  /** A fiokvalaszto (kanban #426): MINDEN bejelentkezett fiok, elo zold/piros
   *  jelzessel; a felhasznalo elore valaszthat, mielott ir es kuld. Az elso
   *  'Automatikus' -> a rendes auto-valasztas fut (fallbackkal). Egy konkret
   *  fiok valasztasakor CSAK azzal megy (nincs fallback), ezert latszik, hogy
   *  melyik elo. */
  function chatAccountHtml() {
    var accs = (WB.chatStatus && WB.chatStatus.accounts) || []
    if (!accs.length) return ''
    var cur = WB.chatAccount || 'auto'
    var dot = function (s) { return s === 'online' ? '🟢' : s === 'limited' ? '🔴' : '⚪' }
    var opts = ['<option value="auto"' + (cur === 'auto' ? ' selected' : '') + '>' + esc(t('workbench.chat.account_auto')) + '</option>']
    for (var i = 0; i < accs.length; i++) {
      var a = accs[i]
      var suffix = a.status === 'limited' ? ' ' + t('workbench.chat.account_limited_suffix')
        : a.status === 'unknown' ? ' ' + t('workbench.chat.account_unknown_suffix') : ''
      var label = dot(a.status) + ' ' + a.agent + (a.model ? ' · ' + a.model : '') + suffix
      opts.push('<option value="' + escA(a.agent) + '"' + (cur === a.agent ? ' selected' : '') + '>' + esc(label) + '</option>')
    }
    return '<div class="wb-chat-account-row">'
      + '<label class="wb-chat-account-label" for="wbChatAccount">' + esc(t('workbench.chat.account_label')) + '</label>'
      + '<select class="wb-input wb-chat-account" id="wbChatAccount" data-wb-act="chat-account">' + opts.join('') + '</select>'
      + '</div>'
  }

  /** The side switch (Boss, 2026-10-02): which side's Claude does this chat's work.
   *  Off = the baked-in rule (the folder's location decides); Windows / WSL force it. */
  function chatSideHtml() {
    var cur = (WB.chatSide !== undefined && WB.chatSide !== null) ? WB.chatSide : ((WB.chatStatus && WB.chatStatus.side) || '')
    var opts = [['', t('workbench.chat.side_off')], ['windows', t('workbench.chat.side_windows')], ['wsl', t('workbench.chat.side_wsl')]]
    return '<div class="wb-chat-account-row">'
      + '<label class="wb-chat-account-label" for="wbChatSide">' + esc(t('workbench.chat.side_label')) + '</label>'
      + '<select class="wb-input wb-chat-account" id="wbChatSide" data-wb-act="chat-side" title="' + escA(t('workbench.chat.side_hint')) + '">'
      + opts.map(function (o) { return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>' }).join('')
      + '</select></div>'
  }

  function chatSideValue() {
    return (WB.chatSide !== undefined && WB.chatSide !== null) ? WB.chatSide : ((WB.chatStatus && WB.chatStatus.side) || '')
  }

  function chatInnerHtml() {
    var streaming = WB.chatStreaming
    var max = (WB.chatStatus && WB.chatStatus.maxMessageChars) || 8000
    return '<div class="wb-chat-head">'
      // Settings sits right next to the title as a small button, the status
      // gets its own line below -- no extra rows (Boss, TG 1841).
      + '<label class="wb-chat-label" for="wbChatInput">' + esc(t('workbench.chat.title')) + '</label>'
      + '<button type="button" class="wb-mini-btn wb-chat-setup-btn" data-wb-act="chat-setup" aria-pressed="' + !!WB.chatSetupOpen + '">' + esc(t('workbench.chat.setup')) + '</button>'
      + '<div class="wb-chat-statusline">' + chatStatusHtml() + '</div>'
      + '</div>'
      + chatSideHtml()
      + chatAccountHtml()
      + (WB.chatSetupOpen ? chatSetupHtml() : '')
      + '<div class="wb-chat-log" id="wbChatLog">' + chatLogHtml() + '</div>'
      + chatToolsHtml()
      + chatActivityHtml()
      + chatAttachedHtml()
      + '<div class="wb-chat-row">'
      + '<textarea class="wb-input wb-chat-input" id="wbChatInput" rows="2" maxlength="' + max + '" placeholder="'
      + escA(t('workbench.chat.placeholder')) + '">' + esc(WB.chatDraft) + '</textarea>'
      + '<div class="wb-chat-btns">'
      + chatAttachHtml()
      + micButtonHtml('wbChatInput')
      + (streaming
        ? '<button type="button" class="btn-secondary" data-wb-act="chat-stop">' + esc(t('workbench.chat.stop')) + '</button>'
        : '')
      // A Kuldes gomb valasz kozben SEM tunik el (#434, Boss: "ugyanugy kell
      // viselkedni, mint a Telegramnak"): ilyenkor sorba allit.
      + '<button type="button" class="btn-primary" data-wb-act="chat-send">'
      + esc(streaming ? t('workbench.chat.send_queue') : t('workbench.chat.send')) + '</button>'
      + '</div></div>'
      + '<p class="wb-hint">' + esc(WB.selectedId && WB.detail
        ? t('workbench.chat.target_item', { title: WB.detail.item.title })
        : t('workbench.chat.target_project')) + '</p>'
  }

  function chatBarHtml() {
    return '<div class="wb-chat" id="wbChat"' + (WB.selectedId && WB.detail && !archived() ? ' data-wb-drop="assets"' : '') + '>' + chatInnerHtml() + '</div>'
  }

  /** A chat-naplo alapbol a legaljan all: mindig a legutolso uzenet latszik
   *  (Boss, 2026-09-28: "alapesetben lent legyen a csuszka"). */
  function scrollChatToBottom() {
    var log = typeof document.getElementById === 'function' ? document.getElementById('wbChatLog') : null
    if (log && typeof log.scrollHeight === 'number') log.scrollTop = log.scrollHeight
    var tools = typeof document.getElementById === 'function' ? document.getElementById('wbChatTools') : null
    if (tools && typeof tools.scrollHeight === 'number') tools.scrollTop = tools.scrollHeight
  }

  // Kanban #444 (Boss, TG 1864): while the agent works, every redraw jumped the
  // chat back to the bottom, so the owner could not scroll up and read. A pane
  // follows new output only while it was already at the bottom; once the owner
  // scrolls up, the redraw keeps the position they scrolled to. Sending a message,
  // opening the chat or switching items still goes to the bottom.
  var CHAT_PANES = ['wbChatLog', 'wbChatTools']
  var CHAT_BOTTOM_SLACK = 40

  function chatScrollSnapshot() {
    var snap = { target: WB.selectedId || '', panes: {} }
    if (typeof document.getElementById !== 'function') return snap
    for (var i = 0; i < CHAT_PANES.length; i++) {
      var el = document.getElementById(CHAT_PANES[i])
      if (!el || typeof el.scrollTop !== 'number' || typeof el.scrollHeight !== 'number') continue
      var client = typeof el.clientHeight === 'number' ? el.clientHeight : 0
      snap.panes[CHAT_PANES[i]] = { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - client <= CHAT_BOTTOM_SLACK }
    }
    return snap
  }

  function restoreChatScroll(snap) {
    if (WB.chatForceBottom || !snap || snap.target !== (WB.selectedId || '')) {
      WB.chatForceBottom = false
      scrollChatToBottom()
      return
    }
    if (typeof document.getElementById !== 'function') return
    for (var i = 0; i < CHAT_PANES.length; i++) {
      var el = document.getElementById(CHAT_PANES[i])
      if (!el || typeof el.scrollHeight !== 'number') continue
      var was = snap.panes[CHAT_PANES[i]]
      el.scrollTop = was && !was.atBottom ? was.top : el.scrollHeight
    }
  }

  /** CSAK a chat-sav ujrarajzolasa: streameles kozben a teljes oldal ujraepitese
   *  elvenne a fokuszt es a gorgetest. Ha a sav nincs a DOM-ban (meg nem
   *  rajzoltunk), a teljes rajzolas lep a helyebe. */
  function renderChat() {
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChat') : null
    if (!el || typeof el.innerHTML !== 'string') { render(); return }
    var focused = false
    try { focused = !!(document.activeElement && document.activeElement.id === 'wbChatInput') } catch (_e) { focused = false }
    var scrollSnap = chatScrollSnapshot()
    el.innerHTML = chatInnerHtml()
    restoreChatScroll(scrollSnap)
    if (focused) {
      var input = document.getElementById('wbChatInput')
      if (input && typeof input.focus === 'function') {
        input.focus()
        try { input.selectionStart = input.selectionEnd = input.value.length } catch (_e2) { /* nem baj */ }
      }
    }
  }

  /** Egy SSE-keret (`event: x\ndata: {...}`) feldolgozasa. */
  function applyChatEvent(turn, ev) {
    if (!ev || !ev.type) return
    if (WB.chatActivityClock) WB.chatActivityClock.lastEventAt = Date.now()
    if (ev.type === 'session') { chatState().sessionId = ev.sessionId; return }
    if (ev.type === 'text') { turn.text += ev.text || ''; return }
    if (ev.type === 'tool') {
      // A new run always gets its own row (two parallel Bash runs are two rows);
      // a result closes the OLDEST open run of that name -- results come in call order.
      var found = null
      if (ev.status !== 'running') {
        for (var i = 0; i < turn.tools.length; i++) {
          if (turn.tools[i].name === ev.name && turn.tools[i].status === 'running') { found = turn.tools[i]; break }
        }
      }
      if (found) { found.status = ev.status; found.detail = ev.detail || found.detail; found.approvalId = ev.approvalId || found.approvalId }
      else turn.tools.push({ name: ev.name, status: ev.status, detail: ev.detail || '', approvalId: ev.approvalId || '' })
      if (toolChangedWork(ev)) scheduleLiveRefresh()
      return
    }
    if (ev.type === 'notice') {
      turn.notices.push(ev.message || ev.code)
      // A kod-hid feladat a hatterben dolgozik tovabb: a folyam `done` nelkul
      // zarul, de ez nem megszakadt kapcsolat -- lasd `endChatStream`.
      if (ev.code === 'code_bridge_timeout') turn.background = true
      return
    }
    if (ev.type === 'error') {
      // "Mar fut egy valasz": nem hiba a felhasznalonak -- az uzenet sorba all.
      if (ev.code === 'busy') { turn.busy = true; return }
      turn.error = ev.message || ev.code
      return
    }
    if (ev.type === 'done') { turn.done = true; turn.model = ev.model || null; turn.via = ev.via || null }
  }

  /** true, ha a keret esemenyt hozott (a `: ping` megjegyzes nem hoz). */
  function parseSseChunk(turn, chunk) {
    var lines = String(chunk).split('\n')
    var data = ''
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).trim()
    }
    if (!data) return false
    try { applyChatEvent(turn, JSON.parse(data)); return true } catch (_e) { return false /* fel-keret: eldobjuk */ }
  }

  /** A folyam vege. Ha a szerver kimondta, hogy kesz (vagy hibat mondott), a
   *  fordulo lezarul. Ha NEM, a kapcsolat a valasz ELOTT zarult le (#433,
   *  2026-09-28: a teljes erteku ugynok valasza a szerveren elkeszult es a
   *  beszelgetesbe mentodott, a chat megis "Kesz"-t mutatott szoveg nelkul) --
   *  ilyenkor nem mondjuk kesznek, hanem megkerdezzuk a szervert, mi lett a
   *  valasszal, ugyanazon az uton, mint egy megszakadt kapcsolatnal. */
  function endChatStream(turn) {
    if (turn.done || turn.error || turn.busy) { finishChatTurn(turn); return }
    // A valasz a hatterben keszul tovabb (#434): nem "megszakadt a kapcsolat",
    // csak a szervert kerdezzuk -- az "fut"-ot mond, es a chat figyel tovabb.
    recoverChatTurn(turn, turn.background ? null : t('workbench.chat.stream_ended'), 0, 'workbench.chat.stream_lost')
  }

  /** A megszakadt fordulo sorsat a szerver donti el (meg fut / elkeszult es
   *  mentve / elveszett) -- lasd `reconnectChat`. */
  function recoverChatTurn(turn, notice, delay, lostKey) {
    WB.chatAbort = null
    if (notice) turn.notices.push(notice)
    renderChat()
    // `lostKey`: mit mondjunk, ha a szerveren sincs meg a valasz. Az okot nem
    // talalgatjuk -- a sima lezarulasnal nem allitjuk, hogy ujraindult volna.
    WB.chatReconnect = { turn: turn, key: chatKey(), tries: 0, lostKey: lostKey || 'workbench.chat.interrupted' }
    setTimeout(function () { reconnectChat(turn) }, delay)
  }

  /** Az ugynok irhatott a kijelolt munkadarab fajljaba (vagy uj fajlt csatolt
   *  hozza): a jobb oldali elonezet es a verziok a szerver mostani allapotat
   *  mutassak, ne a fordulo elottit. Nem talalgatunk, ujra lekerdezzuk. */
  function refreshSelectedAfterTurn() {
    var id = WB.selectedId
    if (!id) return
    var hadFile = !!(WB.detail && WB.detail.item && WB.detail.item.source_path)
    if (!hadFile) loadDetail(id)
    else loadPreview(id, null, true)
  }

  function finishChatTurn(turn) {
    stopChatActivityTicker()
    WB.chatStreaming = false
    WB.chatAbort = null
    if (turn.busy) {
      // A szerveren meg fut egy korabbi valasz (pl. elkattintas utan): az
      // uzenet NEM vesz el es NEM hibazik -- sorba all, es megvarjuk.
      var st = chatState()
      var at = st.turns.indexOf(turn)
      if (at >= 0) st.turns.splice(at, 1)
      for (var j = st.turns.length - 1; j >= 0; j--) {
        if (st.turns[j].role === 'user') { st.turns[j].queued = true; break }
      }
      enterChatWatch()
      return
    }
    if (!turn.done) turn.done = true
    renderChat()
    // Ha az agens MUNKADARABOT hozott letre vagy valtoztatott (Boss 2. keres:
    // "az agent-chatbol lehessen uj munkadarabot letrehozni"), a lista ne
    // maradjon a regi allapoton. Ujratoltjuk -- nem talalgatunk, a szerver
    // mondja meg, mi lett belole.
    var valtozott = (turn.tools || []).some(function (x) {
      return x.status === 'ok' && String(x.name || '').indexOf('workItem.') === 0
    })
    if (valtozott && WB.projectId) {
      load(WB.projectId)
      if (WB.selectedId) loadDetail(WB.selectedId)
    }
    refreshSelectedAfterTurn()
    // A keret allapota a fordulo utan mar mas: ujramerjuk, nem emlekezetbol irjuk.
    loadChatStatus()
    // A valasz kozben irt uzenet most megy el.
    flushChatQueue()
  }

  function sendChat() {
    // A mezo TENYLEGES tartalma a forras -- az `input` esemenyre epiteni
    // onmagaban keves (beillesztes, IME, automatikus kitoltes utan elmaradhat).
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatInput') : null
    if (el && typeof el.value === 'string') WB.chatDraft = el.value
    var text = String(WB.chatDraft || '').trim()
    // A csatolt fajlok a kovetkezo uzenettel mennek (#441); szoveg nelkul is
    // elkuldhetok, ahogy a szokasos chatekben.
    var attached = WB.selectedId ? (WB.chatAttached[WB.selectedId] || []) : []
    if (!text && !attached.length) return
    // The owner's own new message must be visible, wherever he had scrolled.
    WB.chatForceBottom = true
    if (attached.length) {
      text = withAttachedLine(text, attached, (WB.chatStatus && WB.chatStatus.maxMessageChars) || 8000)
      WB.chatAttached[WB.selectedId] = []
    }
    var st = chatState()
    if (WB.chatStreaming) {
      // Valasz kozben irt uzenet (Boss, 2026-09-28: "amig fut a valasz, addig
      // masik uzenetet nem tudok beirni?"): nem dobjuk el es nem hibazunk --
      // sorba all, es a futo valasz utan magatol elmegy.
      st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true, queued: true })
      WB.chatDraft = ''
      if (el && typeof el.value === 'string') el.value = ''
      renderChat()
      return
    }
    st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    WB.chatDraft = ''
    if (el && typeof el.value === 'string') el.value = ''
    startChatTurn(text)
  }

  /** A megallitott valasz folytatasa (K-0.8): sajat uzenet, a beiro mezo tartalmat nem erinti. */
  function continueChat() {
    if (WB.chatStreaming) return
    var text = t('workbench.chat.continue_text')
    WB.chatForceBottom = true
    chatState().turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    startChatTurn(text)
  }

  /** Egy fordulo inditasa: a user-sor mar a naploban van. */
  function startChatTurn(text) {
    var st = chatState()
    var turn = { role: 'agent', text: '', tools: [], notices: [], error: null, done: false }
    st.turns.push(turn)
    // A mezot NEM uritjuk itt: sorbol inditva a felhasznalo kozben mar ujat irhat.
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatInput') : null
    if (el && typeof el.value === 'string') WB.chatDraft = el.value
    WB.chatStreaming = true
    WB.chatActivityClock = { startedAt: Date.now(), lastEventAt: Date.now() }
    startChatActivityTicker()
    renderChat()

    var body = { project_id: WB.projectId, work_item_id: WB.selectedId || null, message: text, account: WB.chatAccount || 'auto', side: chatSideValue() }
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }
    if (typeof AbortController === 'function') {
      WB.chatAbort = new AbortController()
      opts.signal = WB.chatAbort.signal
    }
    var url = '/api/workbench/agent/message?lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, opts).then(function (res) {
      if (!res.ok) {
        // A streameles MEGKEZDESE ELOTTI hiba rendes JSON -- azt a mondatot irjuk ki.
        return (res.json ? res.json() : Promise.resolve(null)).catch(function () { return null }).then(function (d) {
          turn.error = (d && d.message) || t('workbench.err.http', { status: res.status })
          finishChatTurn(turn)
        })
      }
      if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
        var reader = res.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) { if (buf.trim()) parseSseChunk(turn, buf); endChatStream(turn); return null }
            buf += dec.decode(r.value, { stream: true })
            var parts = buf.split('\n\n')
            buf = parts.pop()
            var changed = false
            for (var i = 0; i < parts.length; i++) { if (parseSseChunk(turn, parts[i])) changed = true }
            // A `: ping` nem ujrarajzolas: az a gorgetest is a vegere rantana.
            if (changed) renderChat()
            return pump()
          })
        }
        return pump()
      }
      // Nincs streamelheto test (regi bongeszo): egyben olvassuk be. A valasz
      // ugyanaz, csak nem gepelve jelenik meg.
      if (typeof res.text === 'function') {
        return res.text().then(function (txt) {
          var parts = String(txt).split('\n\n')
          for (var i = 0; i < parts.length; i++) parseSseChunk(turn, parts[i])
          endChatStream(turn)
        })
      }
      turn.error = t('workbench.chat.no_stream')
      finishChatTurn(turn)
      return null
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { turn.aborted = true; finishChatTurn(turn); return }
      // Megszakadt a kapcsolat -- tipikusan a Marveen frissites miatti
      // ujraindulasa (#434, merve: deploy 12:12:05 -> "Nem erem el"). Nem
      // irunk rogton hibat: megvarjuk, hogy a szerver visszajojjon, es
      // megkerdezzuk, mi lett a valasszal.
      recoverChatTurn(turn, t('workbench.chat.reconnecting'), CHAT_RECONNECT_MS)
    })
  }

  var CHAT_RECONNECT_MS = 3000
  var CHAT_RECONNECT_TRIES = 60 // ~3 perc: egy build+ujrainditas belefer

  /** A megszakadt fordulo utan: ha a szerver visszajott, a TENYLEGES allapot
   *  dont (meg fut / elkeszult es mentve / elveszett), nem talalgatunk. */
  function reconnectChat(turn) {
    var rc = WB.chatReconnect
    if (!rc || rc.turn !== turn) return // kozben leallitottak
    if (!WB.open || chatKey() !== rc.key) {
      WB.chatReconnect = null
      turn.error = t('workbench.err.network')
      finishChatTurn(turn)
      return
    }
    api('GET', chatSessionUrl()).then(function (r) {
      if (WB.chatReconnect !== rc) return
      if (!r.ok && r.status === 0 && ++rc.tries < CHAT_RECONNECT_TRIES) {
        setTimeout(function () { reconnectChat(turn) }, CHAT_RECONNECT_MS)
        return
      }
      WB.chatReconnect = null
      if (!r.ok) { turn.error = r.message; finishChatTurn(turn); return }
      var st = chatState()
      var at = st.turns.indexOf(turn)
      if (r.data && r.data.running) {
        // A szerver el, a valasz meg keszul: a meglevo figyelo veszi at.
        if (at >= 0) st.turns.splice(at, 1)
        stopChatActivityTicker()
        WB.chatStreaming = false
        enterChatWatch()
        return
      }
      var msgs = ((r.data && r.data.messages) || []).filter(function (m) { return m.role !== 'tool' })
      var last = msgs.length ? msgs[msgs.length - 1] : null
      if (last && last.role !== 'user') {
        // A valasz elkeszult es mentodott: a szerverrol toltjuk be.
        stopChatActivityTicker()
        WB.chatStreaming = false
        WB.chatAbort = null
        // ...and with it whatever it changed on the open work item (#462).
        scheduleLiveRefresh()
        reloadChatHistory()
        return
      }
      // A valasz elveszett (a szerver ujraindult, mielott befejezte volna).
      turn.error = t(rc.lostKey || 'workbench.chat.interrupted')
      finishChatTurn(turn)
    })
  }

  /** Egy sorban allo uzenet visszavonasa, mielott elment. */
  function unqueueChat(index) {
    var st = chatState()
    var turn = st.turns[index]
    if (turn && turn.role === 'user' && turn.queued) st.turns.splice(index, 1)
    renderChat()
  }

  /** Egy sorban allo uzenet szerkesztese (K-0.4): visszakerul a beiro mezobe, a sorbol kikerul. */
  function editQueuedChat(index) {
    var st = chatState()
    var turn = st.turns[index]
    if (!turn || turn.role !== 'user' || !turn.queued) return
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatInput') : null
    if (el && typeof el.value === 'string') WB.chatDraft = el.value
    var cur = WB.chatDraft || ''
    WB.chatDraft = cur ? turn.text + '\n' + cur : turn.text
    st.turns.splice(index, 1)
    renderChat()
  }

  function stopChat() {
    if (WB.chatReconnect) {
      // Ujrakapcsolodas kozben: a varakozast allitjuk le.
      var rt = WB.chatReconnect.turn
      WB.chatReconnect = null
      rt.aborted = true
      finishChatTurn(rt)
      return
    }
    // A SZERVEREN is leallitjuk. Eddig csak a bongeszo olvasasa allt le, a
    // valasz tovabb futott, es amig vegzett, minden uj uzenet "mar fut" hibat kapott.
    if (WB.projectId) {
      var key = chatKey()
      api('POST', '/api/workbench/agent/stop', { project_id: WB.projectId, work_item_id: WB.selectedId || null }).then(function () {
        // Figyelesnel azonnal ujrakerdezzuk, ne varjon a kovetkezo korig.
        if (WB.chatWatch && WB.chatWatch.key === key) { clearTimeout(WB.chatWatch.timer); pollChatWatch(key) }
      })
    }
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    else if (!WB.chatWatch) { WB.chatStreaming = false; renderChat() }
  }

  function openChatSetup() {
    WB.chatSetupOpen = true
    renderChat()
    api('GET', '/api/workbench/agent/config').then(function (r) {
      if (r.ok) WB.chatConfig = r.data
      renderChat()
    })
    api('GET', '/api/models/available').then(function (r) {
      if (r.ok && r.data) { WB.chatModels = r.data; renderChat() }
    })
    api('GET', '/api/ollama/models').then(function (r) {
      // A failed request is "could not look" (with the actual error) -- never an empty "no models".
      WB.chatOllama = r.ok && r.data ? r.data : { verdict: 'check_failed', error: r.message || '', models: [] }
      renderChat()
    })
  }

  function saveChatSetup() {
    if (WB.chatSetupBusy) return
    var modelEl = document.getElementById('wbChatModel')
    var body = {}
    if (modelEl) body.WORKBENCH_MODEL = String(modelEl.value || '').trim()
    if (!Object.keys(body).length) { WB.chatSetupOpen = false; renderChat(); return }
    WB.chatSetupBusy = true
    renderChat()
    api('POST', '/api/workbench/agent/config', body).then(function (r) {
      WB.chatSetupBusy = false
      if (!r.ok) { renderChat(); window.showToast(r.message); return }
      WB.chatSetupOpen = false
      window.showToast(t('workbench.chat.setup_saved'))
      loadChatStatus()
      renderChat()
    })
  }

  // ---- kepessegek: mi mukodik ezen a gepen? (8. fazis, spec 1-2) ------------
  //
  // Harom dolgot kell egyszerre tudnia: (a) MI hianyzik, (b) MIRE hat, es (c)
  // MIT tegyen a felhasznalo. Aki nem programozo, annak a "not_installed" szo
  // semmit nem mond -- ezert allapot-cimke + emberi mondat + szamozott lepesek
  // + LINK jar minden sorhoz, es ahol ut vagy cim kell, ott egy mezo is,
  // amibe be tudja irni. Terminal nelkul, friss telepitesen is.
  //
  // Az EXTRA hianya SOHA nem piros (CLAUDE.md, 2026-08-11): a felhasznalo
  // nyugodjon meg attol, amit lat, ne ijedjen meg tole.
  function capStateClass(cap) {
    if (cap.state === 'ok') return 'wb-cap-ok'
    if (cap.state === 'check_failed') return 'wb-cap-warn'
    if (cap.tier === 'core') return 'wb-cap-warn'
    return 'wb-cap-neutral'
  }

  function capSettingHtml(cap) {
    var st = cap.setting
    if (!st) return ''
    var id = 'wbCapSet-' + st.key
    var hint = ''
    if (st.secret) hint = st.configured ? t('workbench.caps.secret_set') : t('workbench.caps.secret_empty')
    return '<div class="wb-cap-setting">'
      + '<label class="wb-label" for="' + escA(id) + '">' + esc(st.label) + '</label>'
      + '<input class="wb-input" id="' + escA(id) + '" type="' + (st.secret ? 'password' : 'text') + '" autocomplete="off"'
      + ' value="' + escA(st.secret ? '' : (st.value || '')) + '" placeholder="' + escA(st.placeholder || '') + '">'
      + (hint ? '<p class="wb-hint">' + esc(hint) + '</p>' : '')
      + '<button type="button" class="btn-secondary" data-wb-act="cap-save" data-wb-cap="' + escA(cap.key) + '"'
      + (WB.capsBusy === cap.key ? ' disabled' : '') + '>'
      + esc(WB.capsBusy === cap.key ? t('workbench.caps.saving') : t('workbench.caps.save')) + '</button>'
      + '</div>'
  }

  function capHtml(cap) {
    var steps = (cap.how_to || []).map(function (line) { return '<li>' + esc(line) + '</li>' }).join('')
    return '<li class="wb-cap ' + capStateClass(cap) + '">'
      + '<div class="wb-cap-head">'
      + '<strong>' + esc(cap.title) + '</strong>'
      + '<span class="wb-cap-badge">' + esc(t('workbench.caps.state.' + cap.state)) + '</span>'
      + '<span class="wb-cap-tier">' + esc(t('workbench.caps.tier.' + cap.tier)) + '</span>'
      + '</div>'
      + '<p class="wb-cap-what">' + esc(cap.what_for) + '</p>'
      + '<p class="wb-cap-msg">' + esc(cap.message) + '</p>'
      // A VALODI hibauzenet: kiirjuk, de nem helyette, hanem az emberi mondat
      // MELLE -- igy a felhasznalo tudja, mi a teendo, a hibakereso meg azt,
      // mi tortent pontosan. CSAK hibas allapotnal: egy mukodo kepesseg
      // reszlete nem hibauzenet (Boss, 2026-09-26: "Mukodik" mellett "A pontos
      // hibauzenet: signed-in Claude account" allt).
      + (cap.detail && cap.state !== 'ok' ? '<p class="wb-cap-detail"><span>' + esc(t('workbench.caps.detail')) + '</span> <code>' + esc(cap.detail) + '</code></p>' : '')
      + (steps ? '<p class="wb-cap-howto">' + esc(t('workbench.caps.howto')) + '</p><ol class="wb-cap-steps">' + steps + '</ol>' : '')
      + (cap.obtain_url ? '<p><a href="' + escA(cap.obtain_url) + '" target="_blank" rel="noopener">' + esc(t('workbench.caps.obtain')) + '</a></p>' : '')
      + capSettingHtml(cap)
      + '<div class="wb-cap-actions">'
      + (cap.testable
        ? '<button type="button" class="btn-secondary" data-wb-act="cap-test" data-wb-cap="' + escA(cap.key) + '"'
          + (WB.capsBusy === cap.key ? ' disabled' : '') + '>'
          + esc(WB.capsBusy === cap.key ? t('workbench.caps.testing') : t('workbench.caps.test')) + '</button>'
        : '')
      + '<span class="wb-cap-when">' + esc(t('workbench.caps.checked_at', { when: when(Math.floor((cap.checked_at || 0) / 1000)) })) + '</span>'
      + '</div>'
      + '</li>'
  }

  function capsPanelHtml() {
    if (!WB.capsOpen) return ''
    var body
    if (WB.capsError) body = '<p class="wb-error">' + esc(WB.capsError) + '</p>'
    // A NULLA KET DOLGOT JELENTHET: a `null` = "meg nem mertuk" (toltes), az
    // ures tomb = "tenyleg nincs egy sor sem". Nem ugyanaz, nem is igy latszik.
    else if (WB.caps === null) body = '<p class="wb-hint">' + esc(t('workbench.caps.loading')) + '</p>'
    else body = '<ul class="wb-caps">' + WB.caps.map(capHtml).join('') + '</ul>'
    return '<section class="wb-caps-panel" id="wbCapsPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.caps.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-refresh">' + esc(t('workbench.caps.refresh')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.caps.intro')) + '</p>'
      + body
      + '</section>'
  }

  function loadCaps(force) {
    WB.capsError = null
    if (force) WB.caps = null
    render()
    api('GET', '/api/workbench/capabilities' + (force ? '?force=1' : '')).then(function (r) {
      if (!r.ok) {
        // Nem allitjuk, hogy "nincs egy kepesseg sem" -- azt mondjuk, hogy
        // NEM LATTUNK ODA. A ketto nem ugyanaz.
        WB.capsError = r.message || t('workbench.caps.error')
        WB.caps = null
      } else {
        WB.caps = (r.data && r.data.capabilities) || []
      }
      render()
    })
  }

  function testCap(key) {
    WB.capsBusy = key
    render()
    api('POST', '/api/workbench/capabilities/' + encodeURIComponent(key) + '/test', {}).then(function (r) {
      WB.capsBusy = null
      if (!r.ok) { WB.capsError = r.message; render(); return }
      applyCap(r.data && r.data.capability)
      render()
    })
  }

  function saveCapSetting(key) {
    var cap = (WB.caps || []).filter(function (c) { return c.key === key })[0]
    if (!cap || !cap.setting) return
    var el = document.getElementById('wbCapSet-' + cap.setting.key)
    var value = el ? el.value : ''
    WB.capsBusy = key
    render()
    api('POST', '/api/workbench/capabilities/' + encodeURIComponent(key) + '/setting', { value: value }).then(function (r) {
      WB.capsBusy = null
      if (!r.ok) { WB.capsError = r.message; render(); return }
      applyCap(r.data && r.data.capability)
      render()
      if (r.data && r.data.message) window.showToast(r.data.message)
    })
  }

  function applyCap(cap) {
    if (!cap || !WB.caps) return
    WB.caps = WB.caps.map(function (c) { return c.key === cap.key ? cap : c })
  }

  function panelTabsHtml() {
    var tabs = [['items', 'workbench.panel.items'], ['editor', 'workbench.panel.editor'], ['context', 'workbench.panel.context']]
    return '<div class="wb-panel-tabs" role="tablist">' + tabs.map(function (p) {
      return '<button type="button" class="tab-btn' + (WB.panel === p[0] ? ' active' : '') + '" role="tab"'
        + ' aria-selected="' + (WB.panel === p[0]) + '" data-wb-panel="' + escA(p[0]) + '">' + esc(t(p[1])) + '</button>'
    }).join('') + '</div>'
  }

  // ---- jovahagyas munkadarabra (#406, 9. pont) ------------------------------
  //
  // Ugyanaz, mint a kartyaknal: "kesz, jovahagyasra var", es a tulajdonos egy
  // gombbal elfogadja vagy visszadobja. A jegy a Jovahagyasok oldalon is ott van.

  function approvalBoxHtml() {
    if (!WB.detail || archived()) return ''
    var it = WB.detail.item
    var a = WB.detail.approval || null
    var busy = WB.approvalBusy ? ' disabled' : ''
    var out = '<div class="wb-approval wb-approval-' + esc(it.status) + '">'
    if (it.status === 'review' && a && a.status === 'pending') {
      out += '<p><strong>' + esc(t('workbench.approval.pending')) + '</strong> '
        + '<span class="wb-muted">' + esc(t('workbench.approval.since', { when: when(a.requested_at) })) + '</span></p>'
        + '<textarea id="wbApprovalReason" class="wb-approval-reason" rows="2" maxlength="1000"'
        + ' placeholder="' + escA(t('workbench.approval.reason_placeholder')) + '"'
        + ' aria-label="' + escA(t('workbench.approval.reason_placeholder')) + '"></textarea>'
        + '<div class="wb-approval-btns">'
        + '<button type="button" class="btn-primary" data-wb-act="approval-approve"' + busy + '>' + esc(t('workbench.approval.approve')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="approval-reject"' + busy + '>' + esc(t('workbench.approval.reject')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="approval-withdraw"' + busy + '>' + esc(t('workbench.approval.withdraw')) + '</button>'
        + '</div>'
    } else if (it.status === 'done') {
      out += '<p>' + esc(t('workbench.approval.done')) + '</p>'
    } else {
      if (it.status === 'review') out += '<p class="wb-muted">' + esc(t('workbench.approval.closed_without_decision')) + '</p>'
      else if (a && a.status === 'rejected') {
        out += '<p class="wb-approval-rejected-note"><strong>' + esc(t('workbench.approval.rejected')) + '</strong>'
          + (a.reason ? ' ' + esc(a.reason) : '') + '</p>'
      }
      out += '<p class="wb-hint">' + esc(t('workbench.approval.intro')) + '</p>'
        + '<button type="button" class="btn-primary" data-wb-act="approval-submit"' + busy + '>' + esc(t('workbench.approval.submit')) + '</button>'
    }
    return out + '</div>'
  }

  function approvalAction(action) {
    if (!WB.detail || WB.approvalBusy) return
    var id = WB.detail.item.id
    var body = { action: action }
    if (action === 'approve' || action === 'reject') {
      var el = document.getElementById('wbApprovalReason')
      var reason = el && typeof el.value === 'string' ? el.value.trim() : ''
      if (reason) body.reason = reason
      if (action === 'reject' && !reason && !window.confirm(t('workbench.approval.reject_no_reason'))) return
    }
    WB.approvalBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/approval', body).then(function (r) {
      WB.approvalBusy = false
      if (!WB.detail || WB.detail.item.id !== id) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && r.data.item) WB.detail.item = r.data.item
      WB.detail.approval = (r.data && r.data.approval) || null
      window.showToast(t('workbench.approval.toast.' + action))
      render()
      load(WB.projectId)
    })
  }

  // ---- kereses a projekt egeszeben (#406, 8. pont) ---------------------------
  //
  // Egy mezo, a talalatok forrasonkent csoportositva. A forras, amibe a szerver
  // NEM tudott belenezni, kulon mondatot kap -- a "nincs talalat" csak akkor
  // hangzik el, ha minden forrast tenyleg megnezett.

  function markHtml(h) {
    var s = String(h.snippet || '')
    var a = Math.max(0, Math.min(s.length, h.mark_start | 0))
    var b = Math.max(a, Math.min(s.length, h.mark_end | 0))
    return esc(s.slice(0, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>' + esc(s.slice(b))
  }

  function searchHitHtml(h) {
    var label = ''
    if (h.source === 'cards' && h.card_seq != null) label = '#' + h.card_seq + ' ' + (h.title || '')
    else if (h.source === 'files') label = h.path || h.title || ''
    else if (h.source === 'messages') label = t(h.role === 'user' ? 'workbench.search.role.user' : 'workbench.search.role.assistant')
      + (h.item_title ? ' · ' + h.item_title : '')
    else label = h.title || ''
    var head = h.item_id
      ? '<button type="button" class="wb-tl-link" data-wb-item="' + escA(h.item_id) + '">' + esc(label) + '</button>'
      : '<strong>' + esc(label) + '</strong>'
    return '<li class="wb-search-hit">' + head
      + (h.at ? ' <span class="wb-tl-when">' + esc(when(h.at)) + '</span>' : '')
      + '<div class="wb-search-snip">' + markHtml(h) + '</div></li>'
  }

  function searchResultHtml() {
    var r = WB.search
    if (!r) return ''
    var out = ''
    var unseen = (r.sources || []).filter(function (s) { return s.state === 'error' })
    if (unseen.length) {
      out += '<p class="wb-error">' + esc(t('workbench.search.partial', {
        sources: unseen.map(function (s) { return t('workbench.search.source.' + s.source) }).join(', '),
      })) + '</p>'
    }
    var any = false
    ;(r.sources || []).forEach(function (s) {
      if (s.state !== 'ok' || !s.total) return
      any = true
      var hits = (r.hits || []).filter(function (h) { return h.source === s.source })
      out += '<h3 class="wb-search-group">' + esc(t('workbench.search.source.' + s.source)) + ' (' + s.total + ')</h3>'
      if (s.total > hits.length) out += '<p class="wb-hint">' + esc(t('workbench.search.first_n', { n: hits.length, total: s.total })) + '</p>'
      out += '<ul class="wb-search-hits">' + hits.map(searchHitHtml).join('') + '</ul>'
    })
    var files = (r.sources || []).filter(function (s) { return s.source === 'files' })[0]
    if (files && files.state === 'ok' && files.partial) out += '<p class="wb-hint">' + esc(t('workbench.search.files_partial')) + '</p>'
    if (files && files.state === 'none') out += '<p class="wb-hint">' + esc(t('workbench.search.no_folder')) + '</p>'
    if (!any && !unseen.length) out += '<p class="wb-hint">' + esc(t('workbench.search.none', { q: r.q })) + '</p>'
    return out
  }

  function searchPanelHtml() {
    if (!WB.searchOpen) return ''
    var body = ''
    if (WB.searchError) body = '<p class="wb-error">' + esc(WB.searchError) + '</p>'
    else if (WB.searchBusy) body = '<p class="wb-hint">' + esc(t('workbench.search.busy')) + '</p>'
    else body = searchResultHtml()
    return '<section class="wb-caps-panel wb-search-panel" id="wbSearchPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.search.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="search-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.search.intro')) + '</p>'
      + '<form class="wb-search-form" id="wbSearchForm">'
      + '<input type="search" id="wbSearchInput" value="' + escA(WB.searchQ) + '"'
      + ' placeholder="' + escA(t('workbench.search.placeholder')) + '" aria-label="' + escA(t('workbench.search.title')) + '">'
      + '<button type="submit" class="btn-primary"' + (WB.searchBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.search.go')) + '</button>'
      + '</form>'
      + body
      + '</section>'
  }

  function runSearch() {
    var el = document.getElementById('wbSearchInput')
    var q = el && typeof el.value === 'string' ? el.value.trim() : WB.searchQ
    WB.searchQ = q
    if (q.length < 2) { WB.searchError = t('workbench.search.too_short'); WB.search = null; render(); return }
    if (!WB.projectId || WB.searchBusy) return
    var pid = WB.projectId
    WB.searchBusy = true
    WB.searchError = null
    WB.search = null
    render()
    api('GET', '/api/workbench/search?project=' + encodeURIComponent(pid) + '&q=' + encodeURIComponent(q)).then(function (r) {
      WB.searchBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.searchError = r.message || t('workbench.search.error'); render(); return }
      WB.search = (r.data && r.data.search) || null
      render()
    })
  }

  // ---- dontesnaplo (#406, 10. pont) -----------------------------------------
  //
  // Amiben a projektben megallapodtak ("a logo kek marad"). A tulajdonos itt
  // irja be; a Munkapad-agens a beszelgetesbol rogzit, es minden forduloban
  // megkapja. Torles nincs: a visszavont dontes athuzva latszik, visszaallithato.

  // HETI OSSZEFOGLALO (#406, 13. pont). A szerver keszit minden lezart hetrol
  // egyet magatol (es megorzi); a folyo het "eddig" allapota elo. A szoveget itt
  // rakjuk ossze ket nyelven, a szerver csak szamot es nevet ad.

  function loadWeekly() {
    var pid = WB.projectId
    if (!pid) return
    WB.wkError = null
    return api('GET', '/api/workbench/weekly?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.wkError = r.message; WB.weekly = null; render(); return }
      WB.weekly = r.data || { current: null, weeks: [] }
      if (WB.wkShown == null) WB.wkShown = 'current'
      render()
    })
  }

  function wkRange(s) {
    try {
      var a = new Date(s.week_start * 1000)
      var b = new Date((s.week_end - 1) * 1000)
      return a.toLocaleDateString() + ' – ' + b.toLocaleDateString()
    } catch (_e) { return '-' }
  }

  function wkListHtml(key, names, total) {
    if (!names || !names.length) return ''
    var more = total > names.length ? '<li class="wb-hint">' + esc(t('workbench.wk.more', { n: total - names.length })) + '</li>' : ''
    return '<h3 class="wb-search-group">' + esc(t(key, { n: total })) + '</h3>'
      + '<ul class="wb-wk-list">' + names.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + more + '</ul>'
  }

  function wkSummaryHtml(s) {
    if (!s) return ''
    var c = s.counts || {}
    var head = '<p class="wb-wk-range"><strong>' + esc(t(s.live ? 'workbench.wk.this_week' : 'workbench.wk.week_of', { range: wkRange(s) })) + '</strong>'
      + (s.live ? ' <span class="wb-hint">' + esc(t('workbench.wk.so_far')) + '</span>' : '') + '</p>'
    var errs = (s.errors || []).length
      ? '<div class="wb-wk-warn"><p>' + esc(t('workbench.wk.partial')) + '</p></div>' : ''
    if (s.quiet) return head + '<p class="wb-hint">' + esc(t(s.live ? 'workbench.wk.quiet_now' : 'workbench.wk.quiet')) + '</p>'
    var facts = [
      ['items_created', 'workbench.wk.f.created'], ['finished', 'workbench.wk.f.finished'], ['versions', 'workbench.wk.f.versions'],
      ['files', 'workbench.wk.f.files'], ['approvals_requested', 'workbench.wk.f.appr_req'], ['approvals_approved', 'workbench.wk.f.appr_ok'],
      ['approvals_rejected', 'workbench.wk.f.appr_back'], ['decisions', 'workbench.wk.f.decisions'], ['cards_created', 'workbench.wk.f.cards_new'],
      ['cards_done', 'workbench.wk.f.cards_done'],
    ].filter(function (f) { return c[f[0]] > 0 }).map(function (f) {
      return '<li><strong>' + esc(String(c[f[0]])) + '</strong> ' + esc(t(f[1])) + '</li>'
    }).join('')
    var busiest = (s.busiest || []).length
      ? '<h3 class="wb-search-group">' + esc(t('workbench.wk.busiest')) + '</h3><ul class="wb-wk-list">'
        + s.busiest.map(function (b) { return '<li>' + esc(b.title) + ' <span class="wb-hint">' + esc(t('workbench.wk.versions_n', { n: b.versions })) + '</span></li>' }).join('') + '</ul>'
      : ''
    var open = s.open_now != null ? '<p class="wb-hint">' + esc(t('workbench.wk.open_now', { n: s.open_now })) + '</p>' : ''
    return head + errs
      + (facts ? '<ul class="wb-wk-facts">' + facts + '</ul>' : '')
      + wkListHtml('workbench.wk.new_items', s.created, c.items_created || 0)
      + wkListHtml('workbench.wk.done_items', s.finished, c.finished || 0)
      + busiest
      + wkListHtml('workbench.wk.decisions', s.decisions, c.decisions || 0)
      + open
  }

  function weeklyPanelHtml() {
    if (!WB.wkOpen) return ''
    var body = ''
    if (WB.wkError) {
      body = '<p class="wb-error">' + esc(WB.wkError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="wk-refresh">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.weekly === null) {
      body = '<p class="wb-hint">' + esc(t('workbench.wk.loading')) + '</p>'
    } else {
      var weeks = WB.weekly.weeks || []
      var tabs = '<div class="wb-wk-weeks" role="group" aria-label="' + escA(t('workbench.wk.pick')) + '">'
        + '<button type="button" class="btn-secondary" data-wb-act="wk-show" data-wb-week="current" aria-pressed="' + (WB.wkShown === 'current') + '">'
        + esc(t('workbench.wk.this_week_btn')) + '</button>'
        + weeks.map(function (w) {
          var k = String(w.week_start)
          return '<button type="button" class="btn-secondary" data-wb-act="wk-show" data-wb-week="' + escA(k) + '" aria-pressed="' + (WB.wkShown === k) + '">'
            + esc(wkRange(w)) + '</button>'
        }).join('')
        + '</div>'
      var shown = WB.wkShown === 'current' ? WB.weekly.current
        : weeks.filter(function (w) { return String(w.week_start) === WB.wkShown })[0] || WB.weekly.current
      body = tabs
        + (weeks.length ? '' : '<p class="wb-hint">' + esc(t('workbench.wk.no_history')) + '</p>')
        + wkSummaryHtml(shown)
    }
    return '<section class="wb-caps-panel wb-wk-panel" id="wbWkPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.wk.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="wk-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.wk.intro')) + '</p>'
      + body
      + '</section>'
  }

  function loadDecisions() {
    var pid = WB.projectId
    if (!pid) return
    WB.decError = null
    return api('GET', '/api/workbench/decisions?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.decError = r.message; WB.decisions = null; render(); return }
      WB.decisions = (r.data && r.data.decisions) || []
      render()
    })
  }

  function decRowHtml(d) {
    var revoked = d.revoked_at != null
    var ro = archived() || WB.decBusy ? ' disabled' : ''
    var who = d.source === 'agent' ? t('workbench.dec.by_agent') : (d.created_by ? t('workbench.dec.by', { name: d.created_by }) : '')
    var item = null
    if (d.work_item_id) item = (WB.items || []).filter(function (i) { return i.id === d.work_item_id })[0] || null
    if (WB.decEdit === d.id) {
      return '<li class="wb-dec-row">'
        + '<form id="wbDecEditForm" class="wb-dec-form">'
        + '<textarea id="wbDecEditText" rows="2" maxlength="500" aria-label="' + escA(t('workbench.dec.edit')) + '">' + esc(d.text) + '</textarea>'
        + '<div class="wb-dec-btns">'
        + '<button type="submit" class="btn-primary"' + ro + '>' + esc(t('workbench.dec.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="dec-cancel">' + esc(t('workbench.dec.cancel')) + '</button>'
        + '</div></form></li>'
    }
    return '<li class="wb-dec-row' + (revoked ? ' wb-dec-revoked' : '') + '">'
      + '<div class="wb-dec-text">' + esc(d.text) + '</div>'
      + '<div class="wb-dec-meta wb-muted">' + esc(when(d.created_at)) + (who ? ' · ' + esc(who) : '')
      + (item ? ' · <button type="button" class="wb-tl-link" data-wb-item="' + escA(item.id) + '">' + esc(item.title) + '</button>' : '')
      + (revoked ? ' · ' + esc(t('workbench.dec.revoked_at', { when: when(d.revoked_at) })) : '')
      + '</div>'
      + (archived() ? '' : '<div class="wb-dec-btns">'
        + (revoked
          ? '<button type="button" class="btn-secondary" data-wb-act="dec-restore" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.restore')) + '</button>'
          : '<button type="button" class="btn-secondary" data-wb-act="dec-edit" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.edit')) + '</button>'
            + '<button type="button" class="btn-secondary" data-wb-act="dec-revoke" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.revoke')) + '</button>')
        + '</div>')
      + '</li>'
  }

  // ---- atadocsomag (#406, 12. pont) -----------------------------------------
  //
  // Egy gomb: a projekt anyaga egy ZIP-ben (Tartalom oldal + munkadarabonkent
  // egy mappa). ELOBB a terv latszik -- mi kerul bele, es mi NEM (hianyzo
  // fajl, nincs Raktar) --, hogy senki ne adjon at hianyos csomagot tudtan kivul.

  function hoSize(bytes) {
    var mb = (bytes || 0) / (1024 * 1024)
    return mb >= 1 ? t('workbench.ho.mb', { n: mb.toFixed(1) }) : t('workbench.ho.kb', { n: Math.max(1, Math.round((bytes || 0) / 1024)) })
  }

  // --- BETEKINTO LINK (#406, 18. pont) ---------------------------------------
  // Csak olvashato, lejaro link egy munkadarabra vagy az atadasi csomagra. A
  // letrehozas a jovahagyasi kapun megy at; a visszavonas azonnali.
  function loadShares() {
    var pid = WB.projectId
    if (!pid || WB.sharesLoading === pid) return Promise.resolve()
    WB.sharesLoading = pid
    return api('GET', '/api/workbench/shares?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.sharesLoading === pid) WB.sharesLoading = null
      if (WB.projectId !== pid) return
      WB.sharesFor = pid
      if (!r.ok) { WB.sharesError = r.message; WB.shares = []; render(); return }
      WB.sharesError = null
      WB.shares = (r.data && r.data.shares) || []
      WB.sharesBase = (r.data && r.data.public_base) || null
      render()
    }).catch(function () {
      if (WB.sharesLoading === pid) WB.sharesLoading = null
      if (WB.projectId !== pid) return
      WB.sharesFor = pid
      WB.shares = []
      WB.sharesError = t('workbench.share.load_failed')
      render()
    })
  }

  function shareUrl(sh) {
    if (!sh.path) return ''
    return (WB.sharesBase || (window.location && window.location.origin) || '') + sh.path
  }

  /** Csak ezen a gepen nyilik meg a link? (nincs kulso cim beallitva, es helyi cimen nezzuk) */
  function shareLocalOnly() {
    if (WB.sharesBase) return false
    var h = String((window.location && window.location.hostname) || '')
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  }

  function shareDate(sec) {
    try {
      return new Date(sec * 1000).toLocaleString(window._lang === 'en' ? 'en-GB' : 'hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch (e) { return '' }
  }

  function shareRowHtml(sh) {
    var state, extra = ''
    if (sh.revoked_at) state = t('workbench.share.st.revoked')
    else if (sh.status === 'rejected') state = t('workbench.share.st.rejected')
    else if (sh.status === 'pending') {
      state = t('workbench.share.st.pending')
      extra = ' <button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.td.gcal.open_approvals')) + '</button>'
    } else if (sh.live) {
      state = t('workbench.share.st.live', { date: shareDate(sh.expires_at) })
      var u = shareUrl(sh)
      extra = '<div class="wb-share-link"><input class="wb-input" type="text" readonly value="' + escA(u) + '" aria-label="' + escA(t('workbench.share.link_label')) + '">'
        + '<button type="button" class="btn-secondary btn-compact" data-wb-act="share-copy" data-wb-share-url="' + escA(u) + '">' + esc(t('workbench.share.copy')) + '</button></div>'
        + (sh.view_count ? '<span class="wb-hint">' + esc(t('workbench.share.views', { n: sh.view_count })) + '</span>' : '')
    } else state = t('workbench.share.st.expired')
    var open = !sh.revoked_at && (sh.status === 'pending' || sh.live)
    var what = sh.kind === 'handoff' ? t(sh.scope === 'all' ? 'workbench.share.what_handoff_all' : 'workbench.share.what_handoff_done') : (sh.item_title || '')
    return '<li class="wb-share-row"><span>' + esc(what) + ' · ' + esc(state) + '</span>' + extra
      + (open ? ' <button type="button" class="wb-linklike" data-wb-act="share-revoke" data-wb-share="' + escA(sh.id) + '">' + esc(t('workbench.share.revoke')) + '</button>' : '')
      + '</li>'
  }

  /** A link-doboz. `kind`: 'item' (a kivalasztott munkadarab) vagy 'handoff'. */
  function shareBoxHtml(kind) {
    if (WB.sharesFor !== WB.projectId) { loadShares(); return '<div class="wb-share"><p class="wb-hint">' + esc(t('workbench.loading')) + '</p></div>' }
    var mine = (WB.shares || []).filter(function (sh) {
      return kind === 'handoff' ? sh.kind === 'handoff' : (sh.kind === 'item' && sh.work_item_id === WB.selectedId)
    })
    var days = [1, 7, 30].map(function (d) {
      return '<button type="button" class="btn-secondary btn-compact" data-wb-act="share-days" data-wb-days="' + d + '" aria-pressed="' + (WB.shareDays === d) + '">' + esc(t('workbench.share.days', { n: d })) + '</button>'
    }).join('')
    var ro = archived()
    return '<div class="wb-share" role="region" aria-label="' + escA(t('workbench.share.title')) + '">'
      + '<h4 class="wb-exp-title">' + esc(t('workbench.share.title')) + '</h4>'
      + '<p class="wb-hint">' + esc(t(kind === 'handoff' ? 'workbench.share.intro_handoff' : 'workbench.share.intro_item')) + '</p>'
      + (WB.sharesError ? '<div class="info-box depo-bad">' + esc(WB.sharesError) + '</div>' : '')
      + (ro ? '' : '<div class="wb-share-new" role="group" aria-label="' + escA(t('workbench.share.valid_for')) + '"><span class="wb-hint">' + esc(t('workbench.share.valid_for')) + '</span>' + days
        + '<button type="button" class="btn-primary btn-compact" data-wb-act="share-create" data-wb-share-kind="' + kind + '"' + (WB.shareBusy ? ' disabled' : '') + '>' + esc(t('workbench.share.create')) + '</button></div>')
      + (shareLocalOnly() ? '<p class="wb-hint wb-td-gcal-warn">' + esc(t('workbench.share.local_only')) + '</p>' : '')
      + (mine.length ? '<ul class="wb-share-list">' + mine.map(shareRowHtml).join('') + '</ul>' : '')
      + '</div>'
  }

  function shareCreate(kind) {
    if (WB.shareBusy) return
    var body = { kind: kind, project: WB.projectId, days: WB.shareDays }
    if (kind === 'item') body.item_id = WB.selectedId
    else body.scope = WB.hoScope
    WB.shareBusy = true
    render()
    return api('POST', '/api/workbench/shares', body).then(function (r) {
      WB.shareBusy = false
      if (!r.ok) { window.showToast(r.message); render(); return }
      WB.shares = (r.data && r.data.shares) || WB.shares
      WB.sharesFor = WB.projectId
      window.showToast(t(r.data && r.data.state === 'active' ? 'workbench.share.toast_live' : 'workbench.share.toast_pending'))
      render()
    }).catch(function () { WB.shareBusy = false; window.showToast(t('workbench.share.load_failed')); render() })
  }

  function shareRevoke(id) {
    if (!window.confirm(t('workbench.share.revoke_confirm'))) return
    return api('POST', '/api/workbench/shares/' + encodeURIComponent(id) + '/revoke', {}).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      WB.shares = (r.data && r.data.shares) || WB.shares
      window.showToast(t('workbench.share.toast_revoked'))
      render()
    })
  }

  function shareCopy(u) {
    var done = function () { window.showToast(t('workbench.share.toast_copied')) }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(u).then(done, function () { window.showToast(u) }); return }
    } catch (e) { /* lent: a link maga a toastban */ }
    window.showToast(u)
  }

  function loadHandoff() {
    var pid = WB.projectId
    var scope = WB.hoScope
    WB.hoPlan = null
    WB.hoError = null
    render()
    return api('GET', '/api/workbench/handoff?project=' + encodeURIComponent(pid) + '&scope=' + encodeURIComponent(scope)).then(function (r) {
      if (WB.projectId !== pid || WB.hoScope !== scope) return
      if (!r.ok) { WB.hoError = r.message; render(); return }
      WB.hoPlan = (r.data && r.data.plan) || null
      if (!WB.hoPlan) WB.hoError = t('workbench.ho.no_plan')
      render()
    })
  }

  function hoProblemsHtml(plan) {
    var rows = []
    plan.items.forEach(function (e) {
      [e.source].concat(e.images || []).forEach(function (f) {
        if (f && f.problem) rows.push('<li>' + esc(e.title + ': ' + f.name) + ' -- ' + esc(t('workbench.ho.problem.' + f.problem)) + '</li>')
      })
    })
    if (!rows.length) return ''
    return '<div class="wb-ho-warn"><p>' + esc(t('workbench.ho.problems', { n: rows.length })) + '</p><ul>' + rows.join('') + '</ul></div>'
  }

  function handoffPanelHtml() {
    if (!WB.hoOpen) return ''
    var p = WB.hoPlan
    var scopeBtn = function (sc, label) {
      var on = WB.hoScope === sc
      return '<button type="button" class="btn-secondary" data-wb-act="ho-scope" data-wb-scope="' + sc + '" aria-pressed="' + on + '">' + esc(label) + '</button>'
    }
    var body
    if (WB.hoError) {
      body = '<div class="info-box depo-bad">' + esc(WB.hoError) + '</div>'
        + '<button type="button" class="btn-secondary" data-wb-act="ho-refresh">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (!p) {
      body = '<p class="wb-hint">' + esc(t('workbench.loading')) + '</p>'
    } else if (!p.all_count) {
      body = '<p class="wb-hint">' + esc(t('workbench.ho.no_items')) + '</p>'
    } else if (!p.items.length) {
      body = '<p class="wb-hint">' + esc(t('workbench.ho.nothing_done')) + '</p>'
    } else {
      var href = '/api/workbench/handoff/download?project=' + encodeURIComponent(WB.projectId)
        + '&scope=' + encodeURIComponent(WB.hoScope) + '&lang=' + encodeURIComponent(window._lang || 'hu')
      body = '<p>' + esc(t('workbench.ho.summary', { items: p.items.length, files: p.files, size: hoSize(p.total_bytes) })) + '</p>'
        + '<ul class="wb-ho-list">' + p.items.map(function (e) {
          return '<li>' + esc(e.title) + ' <span class="wb-muted">(' + esc(typeLabel(e.type)) + ' · ' + esc(statusLabel(e.status)) + ')</span></li>'
        }).join('') + '</ul>'
        + hoProblemsHtml(p)
        + (p.too_large
          ? '<div class="info-box depo-bad">' + esc(t('workbench.ho.too_large')) + '</div>'
          : '<a class="btn-primary wb-ho-download" href="' + escA(href) + '" download>' + esc(t('workbench.ho.download')) + '</a>')
    }
    return '<section class="wb-caps-panel wb-ho-panel" id="wbHoPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.ho.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="ho-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.ho.intro')) + '</p>'
      + '<div class="wb-ho-scope" role="group" aria-label="' + escA(t('workbench.ho.scope_label')) + '">'
      + scopeBtn('done', p ? t('workbench.ho.scope_done_n', { n: p.done_count }) : t('workbench.ho.scope_done'))
      + scopeBtn('all', p ? t('workbench.ho.scope_all_n', { n: p.all_count }) : t('workbench.ho.scope_all'))
      + '</div>'
      + body
      + (p && p.items && p.items.length ? shareBoxHtml('handoff') : '')
      + '</section>'
  }

  function decisionsPanelHtml() {
    if (!WB.decOpen) return ''
    var body = ''
    if (WB.decError) body = '<p class="wb-error">' + esc(WB.decError) + '</p>'
    else if (WB.decisions === null) body = '<p class="wb-hint">' + esc(t('workbench.dec.loading')) + '</p>'
    else if (!WB.decisions.length) body = '<p class="wb-hint">' + esc(t('workbench.dec.empty')) + '</p>'
    else {
      var active = WB.decisions.filter(function (d) { return d.revoked_at == null })
      var old = WB.decisions.filter(function (d) { return d.revoked_at != null })
      body = (active.length
        ? '<ul class="wb-dec-list">' + active.map(decRowHtml).join('') + '</ul>'
        : '<p class="wb-hint">' + esc(t('workbench.dec.none_active')) + '</p>')
        + (old.length ? '<h3 class="wb-search-group">' + esc(t('workbench.dec.revoked_head', { n: old.length })) + '</h3>'
          + '<ul class="wb-dec-list">' + old.map(decRowHtml).join('') + '</ul>' : '')
    }
    var form = archived() ? '' : '<form id="wbDecForm" class="wb-dec-form">'
      + '<textarea id="wbDecText" rows="2" maxlength="500"'
      + ' placeholder="' + escA(t('workbench.dec.placeholder')) + '" aria-label="' + escA(t('workbench.dec.add')) + '"></textarea>'
      + '<div class="wb-dec-btns"><button type="submit" class="btn-primary"' + (WB.decBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.dec.add')) + '</button></div>'
      + '</form>'
    return '<section class="wb-caps-panel wb-dec-panel" id="wbDecPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.dec.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="dec-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.dec.intro')) + '</p>'
      + form
      + body
      + '</section>'
  }

  /** Egy dontes-muvelet: a valasz sora a listaban kicserelodik. */
  function decRequest(method, url, body, toastKey) {
    if (WB.decBusy) return
    var pid = WB.projectId
    WB.decBusy = true
    render()
    api(method, url, body).then(function (r) {
      WB.decBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      var d = r.data && r.data.decision
      if (d) {
        var list = (WB.decisions || []).filter(function (x) { return x.id !== d.id })
        list.unshift(d)
        list.sort(function (a, b) { return b.created_at - a.created_at })
        WB.decisions = list
      }
      if (toastKey === 'add') { var el = document.getElementById('wbDecText'); if (el) el.value = '' }
      WB.decEdit = null
      window.showToast(t('workbench.dec.toast.' + toastKey))
      render()
    })
  }

  function addDecisionFromForm() {
    var el = document.getElementById('wbDecText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!text) { window.showToast(t('workbench.dec.empty_text')); return }
    decRequest('POST', '/api/workbench/decisions', { project: WB.projectId, text: text }, 'add')
  }

  function saveDecisionEdit() {
    var el = document.getElementById('wbDecEditText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!WB.decEdit) return
    if (!text) { window.showToast(t('workbench.dec.empty_text')); return }
    decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(WB.decEdit), { text: text }, 'edit')
  }

  // ---- Brand Kit (K-4.1 .. K-4.3) ---------------------------------------------

  var BRAND_FONTS = ['sans', 'serif', 'mono']
  var BRAND_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  var BRAND_IMG = /\.(png|jpe?g|gif|webp|svg)$/i

  function brandCopy(b) {
    var x = b || {}
    return {
      colors: (x.colors || []).map(function (c) { return { name: c.name || '', hex: c.hex } }),
      logo_light: x.logo_light || '', logo_dark: x.logo_dark || '',
      font_heading: x.font_heading || '', font_body: x.font_body || '',
      logo_corner: x.logo_corner || '',
      logo_min_width_pct: x.logo_min_width_pct == null ? '' : x.logo_min_width_pct,
      logo_clear_space_pct: x.logo_clear_space_pct == null ? '' : x.logo_clear_space_pct,
      no_exclamation: !!x.no_exclamation,
      notes: (x.notes || []).slice(),
    }
  }

  /** Loads the brand once (and again whenever the panel opens). */
  function loadBrand() {
    var pid = WB.projectId
    if (!pid) return Promise.resolve()
    WB.brandError = null
    // The form is already on screen when the brand was loaded earlier (the
    // canvas editor loads it for the colour buttons): what the owner types
    // while this request is on its way must not be wiped by the answer.
    var before = WB.brandDraft ? JSON.stringify(WB.brandDraft) : null
    return Promise.all([
      api('GET', '/api/workbench/brand?project=' + encodeURIComponent(pid)),
      api('GET', '/api/workbench/shared?project=' + encodeURIComponent(pid)),
    ]).then(function (rs) {
      if (WB.projectId !== pid) return
      var b = rs[0]
      if (!b.ok) { WB.brandError = b.message; WB.brand = null; render(); return }
      var typed = before !== null && !!WB.brandDraft && JSON.stringify(WB.brandDraft) !== before
      WB.brand = b.data.brand
      WB.brandUnreadable = !!b.data.unreadable
      if (!typed) WB.brandDraft = brandCopy(WB.brand)
      WB.brandTemplates = b.data.templates || []
      WB.brandFilesError = rs[1].ok ? null : rs[1].message
      WB.brandFiles = rs[1].ok && rs[1].data && rs[1].data.files
        ? rs[1].data.files.filter(function (f) { return BRAND_IMG.test(f.name || '') }) : []
      render()
    })
  }

  /** The canvas editor shows the brand colours first, so the brand is loaded in the background. */
  function ensureBrand() {
    if (WB.brand === null && !WB.brandError && !WB.brandLoading && WB.projectId) {
      WB.brandLoading = true
      loadBrand().then(function () { WB.brandLoading = false }, function () { WB.brandLoading = false })
    }
  }

  /** One button per brand colour; `act` is the data-wb-act (and its arguments) a click sends. */
  function brandSwatchRow(act, cls) {
    var cs = (WB.brand && WB.brand.colors) || []
    if (!cs.length) return ''
    return '<span class="wb-brand-sw' + (cls ? ' ' + cls : '') + '" role="group" aria-label="' + escA(t('workbench.brand.swatches')) + '">'
      + cs.map(function (c) {
        return '<button type="button" class="wb-brand-swatch" ' + act
          + ' data-wb-hex="' + escA(c.hex) + '" style="background:' + escA(c.hex) + '"'
          + ' title="' + escA((c.name ? c.name + ' ' : '') + c.hex) + '" aria-label="' + escA((c.name ? c.name + ' ' : '') + c.hex) + '"></button>'
      }).join('') + '</span>'
  }

  /** Brand colour buttons under a colour field; a click puts the colour into the field. */
  function brandSwatchesHtml(targetId) {
    return brandSwatchRow('data-wb-act="brand-swatch" data-wb-target="' + escA(targetId) + '"', '')
  }

  /** The same brand colours on the floating toolbar, IN FRONT OF its colour field (K-4.2: the brand
   *  colours come first in every colour picker of manual editing). There is no form here to fill: a
   *  click recolours the selected element at once, like the colour field next to them does. */
  function brandFloatSwatchesHtml(prop) {
    return brandSwatchRow('data-wb-act="can-float-swatch" data-wb-fprop="' + prop + '"', 'wb-can-fsw')
  }

  /** The form -> the draft. Called on every keystroke too: the page is redrawn
   *  as a whole (chat stream, another panel), and a field only in the DOM would
   *  be thrown away. A field that is not on the page keeps its value. */
  function brandSyncDraft() {
    var d = WB.brandDraft
    if (!d) return
    var v = function (id, keep) { var el = document.getElementById(id); return el ? el.value : keep }
    var colors = []
    for (var i = 0; i < d.colors.length; i++) {
      colors.push({ name: v('wbBrandName' + i, d.colors[i].name), hex: v('wbBrandHex' + i, d.colors[i].hex) })
    }
    d.colors = colors
    d.logo_light = v('wbBrandLogoLight', d.logo_light); d.logo_dark = v('wbBrandLogoDark', d.logo_dark)
    d.font_heading = v('wbBrandFontH', d.font_heading); d.font_body = v('wbBrandFontB', d.font_body)
    d.logo_corner = v('wbBrandCorner', d.logo_corner); d.logo_min_width_pct = v('wbBrandMinW', d.logo_min_width_pct); d.logo_clear_space_pct = v('wbBrandClear', d.logo_clear_space_pct)
    var ex = document.getElementById('wbBrandNoExcl'); if (ex) d.no_exclamation = !!ex.checked
    // The text as typed (a trailing empty line is still being written); trimmed when saved.
    var nt = document.getElementById('wbBrandNotes'); if (nt) d.notes = String(nt.value).split('\n')
  }

  function brandSelect(id, value, options, labelFn, emptyKey) {
    return '<select class="wb-input" id="' + id + '"><option value="">' + esc(t(emptyKey)) + '</option>'
      + options.map(function (o) {
        return '<option value="' + escA(o) + '"' + (value === o ? ' selected' : '') + '>' + esc(labelFn(o)) + '</option>'
      }).join('') + '</select>'
  }

  function brandPanelHtml() {
    if (!WB.brandOpen) return ''
    var body
    if (WB.brandError) body = '<p class="wb-error">' + esc(WB.brandError) + '</p>'
    else if (WB.brand === null || !WB.brandDraft) body = '<p class="wb-hint">' + esc(t('workbench.brand.loading')) + '</p>'
    else {
      var d = WB.brandDraft, ro = archived() || WB.brandBusy ? ' disabled' : ''
      var paths = WB.brandFiles.map(function (f) { return f.path })
      var logoOpts = function (cur) { return cur && paths.indexOf(cur) < 0 ? paths.concat([cur]) : paths }
      var nameOf = function (pth) {
        var f = WB.brandFiles.filter(function (x) { return x.path === pth })[0]
        return f ? f.name : pth
      }
      var colors = d.colors.map(function (c, i) {
        return '<li class="wb-brand-color">'
          + '<input type="color" id="wbBrandHex' + i + '" value="' + escA(c.hex) + '" aria-label="' + escA(t('workbench.brand.color_pick')) + '"' + ro + '>'
          + '<input type="text" class="wb-input" id="wbBrandName' + i + '" maxlength="40" value="' + escA(c.name) + '"'
          + ' placeholder="' + escA(t('workbench.brand.color_name_ph')) + '" aria-label="' + escA(t('workbench.brand.color_name')) + '"' + ro + '>'
          + '<button type="button" class="wb-mini-btn wb-mini-danger" data-wb-act="brand-del-color" data-wb-i="' + i + '"' + ro + '>' + esc(t('workbench.brand.color_del')) + '</button>'
          + '</li>'
      }).join('')
      body = '<form id="wbBrandForm" class="wb-brand-form">'
        + (WB.brandUnreadable ? '<p class="wb-error">' + esc(t('workbench.brand.unreadable')) + '</p>' : '')
        + '<h3 class="wb-search-group">' + esc(t('workbench.brand.h_colors')) + '</h3>'
        + '<p class="wb-hint">' + esc(t('workbench.brand.colors_help')) + '</p>'
        + '<ul class="wb-brand-colors">' + (colors || '<li class="wb-hint">' + esc(t('workbench.brand.colors_none')) + '</li>') + '</ul>'
        + '<p><button type="button" class="wb-btn" data-wb-act="brand-add-color"' + (d.colors.length >= 12 || ro ? ' disabled' : '') + '>' + esc(t('workbench.brand.color_add')) + '</button></p>'
        + '<h3 class="wb-search-group">' + esc(t('workbench.brand.h_logos')) + '</h3>'
        + (WB.brandFilesError
          ? '<p class="wb-error">' + esc(WB.brandFilesError) + '</p>'
          : '<p class="wb-hint">' + esc(t(paths.length ? 'workbench.brand.logos_help' : 'workbench.brand.logos_none')) + '</p>')
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbBrandLogoLight">' + esc(t('workbench.brand.logo_light')) + '</label>'
        + brandSelect('wbBrandLogoLight', d.logo_light, logoOpts(d.logo_light), nameOf, 'workbench.brand.none')
        + '<label class="wb-label" for="wbBrandLogoDark">' + esc(t('workbench.brand.logo_dark')) + '</label>'
        + brandSelect('wbBrandLogoDark', d.logo_dark, logoOpts(d.logo_dark), nameOf, 'workbench.brand.none')
        + '</div>'
        + '<h3 class="wb-search-group">' + esc(t('workbench.brand.h_fonts')) + '</h3>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbBrandFontH">' + esc(t('workbench.brand.font_heading')) + '</label>'
        + brandSelect('wbBrandFontH', d.font_heading, BRAND_FONTS, function (f) { return t('workbench.canvas.font_' + f) }, 'workbench.brand.none')
        + '<label class="wb-label" for="wbBrandFontB">' + esc(t('workbench.brand.font_body')) + '</label>'
        + brandSelect('wbBrandFontB', d.font_body, BRAND_FONTS, function (f) { return t('workbench.canvas.font_' + f) }, 'workbench.brand.none')
        + '</div>'
        + '<h3 class="wb-search-group">' + esc(t('workbench.brand.h_rules')) + '</h3>'
        + '<p class="wb-hint">' + esc(t('workbench.brand.rules_help')) + '</p>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbBrandCorner">' + esc(t('workbench.brand.logo_corner')) + '</label>'
        + brandSelect('wbBrandCorner', d.logo_corner, BRAND_CORNERS, function (c) { return t('workbench.brand.corner_' + c) }, 'workbench.brand.any_place')
        + '<label class="wb-label" for="wbBrandMinW">' + esc(t('workbench.brand.logo_min')) + '</label>'
        + '<input class="wb-input" id="wbBrandMinW" type="number" min="1" max="80" step="0.5" value="' + escA(String(d.logo_min_width_pct)) + '" placeholder="10">'
        + '<label class="wb-label" for="wbBrandClear">' + esc(t('workbench.brand.logo_clear')) + '</label>'
        + '<input class="wb-input" id="wbBrandClear" type="number" min="1" max="100" step="1" value="' + escA(String(d.logo_clear_space_pct)) + '" placeholder="25">'
        + '</div>'
        + '<p class="wb-can-checks"><label><input type="checkbox" id="wbBrandNoExcl"' + (d.no_exclamation ? ' checked' : '') + '> ' + esc(t('workbench.brand.no_excl')) + '</label></p>'
        + '<label class="wb-label" for="wbBrandNotes">' + esc(t('workbench.brand.notes')) + '</label>'
        + '<textarea id="wbBrandNotes" rows="3" placeholder="' + escA(t('workbench.brand.notes_ph')) + '">' + esc(d.notes.join('\n')) + '</textarea>'
        + (archived() ? '' : '<div class="wb-dec-btns"><button type="submit" class="btn-primary"' + (WB.brandBusy ? ' disabled' : '') + '>' + esc(t('workbench.brand.save')) + '</button>'
          + '<button type="button" class="btn-secondary" data-wb-act="brand-reset">' + esc(t('workbench.brand.reset')) + '</button></div>')
        + '</form>'
        + brandTemplatesHtml()
    }
    return '<section class="wb-caps-panel wb-brand-panel" id="wbBrandPanel">'
      + '<div class="wb-caps-head"><h2>' + esc(t('workbench.brand.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="brand-close">' + esc(t('workbench.caps.close')) + '</button></div>'
      + '<p class="wb-hint">' + esc(t('workbench.brand.intro')) + '</p>'
      + body + '</section>'
  }

  function saveBrand() {
    if (WB.brandBusy || !WB.brandDraft) return
    brandSyncDraft()
    var d = WB.brandDraft, pid = WB.projectId
    var payload = {
      colors: d.colors, logo_light: d.logo_light || null, logo_dark: d.logo_dark || null,
      font_heading: d.font_heading || null, font_body: d.font_body || null,
      logo_corner: d.logo_corner || null,
      logo_min_width_pct: d.logo_min_width_pct === '' ? null : Number(d.logo_min_width_pct),
      logo_clear_space_pct: d.logo_clear_space_pct === '' ? null : Number(d.logo_clear_space_pct),
      no_exclamation: d.no_exclamation,
      notes: d.notes.map(function (x) { return String(x).trim() }).filter(Boolean),
    }
    WB.brandBusy = true
    render()
    api('PUT', '/api/workbench/brand', { project: pid, brand: payload }).then(function (r) {
      WB.brandBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      WB.brand = r.data.brand
      WB.brandUnreadable = false
      WB.brandDraft = brandCopy(WB.brand)
      WB.brandCheck = null
      window.showToast(t('workbench.brand.toast_saved'))
      render()
    })
  }

  /** K-4.1: the drawings saved as the brand's templates. Outside the brand
   *  form: a template is saved from a drawing, not with "Save the brand". */
  function brandTemplatesHtml() {
    var list = WB.brandTemplates || []
    var off = archived() || WB.brandTplBusy ? ' disabled' : ''
    var rows = list.map(function (tp) {
      var meta = tp.unreadable
        ? '<span class="wb-error">' + esc(t('workbench.brand.tpl_unreadable')) + '</span>'
        : '<span class="wb-hint">' + esc(t('workbench.brand.tpl_meta', { w: tp.width, h: tp.height, n: tp.objects, when: when(tp.created_at) })) + '</span>'
      var buttons = archived() ? '' : '<div class="wb-dec-btns">'
        + (tp.unreadable ? '' : '<button type="button" class="wb-btn" data-wb-act="brand-tpl-use" data-wb-tpl="' + escA(tp.id) + '"' + off + '>'
          + esc(t(WB.brandTplBusy === tp.id ? 'workbench.brand.tpl_creating' : 'workbench.brand.tpl_use')) + '</button>')
        + '<button type="button" class="wb-mini-btn wb-mini-danger" data-wb-act="brand-tpl-del" data-wb-tpl="' + escA(tp.id) + '"' + off + '>'
        + esc(t('workbench.brand.tpl_del')) + '</button></div>'
      return '<li class="wb-brand-tpl"><div class="wb-brand-tpl-text"><strong>' + esc(tp.name) + '</strong>' + meta + '</div>' + buttons + '</li>'
    }).join('')
    return '<h3 class="wb-search-group">' + esc(t('workbench.brand.h_templates')) + '</h3>'
      + '<p class="wb-hint">' + esc(t(list.length ? 'workbench.brand.tpl_help' : 'workbench.brand.tpl_none')) + '</p>'
      + (rows ? '<ul class="wb-brand-tpls">' + rows + '</ul>' : '')
  }

  /** The drawing on screen becomes a brand template: a snapshot, the work item
   *  is not tied to it. A name that is taken is replaced only after a yes. */
  function saveBrandTemplate(name, replace) {
    var id = WB.selectedId, pid = WB.projectId
    if (!id || WB.brandTplBusy || archived()) return
    if (name == null) {
      var title = (WB.detail && WB.detail.item && WB.detail.item.title) || ''
      var typed = typeof window.prompt === 'function' ? window.prompt(t('workbench.brand.tpl_name_prompt'), title) : title
      if (typed == null) return
      name = String(typed).trim() || title
    }
    WB.brandTplBusy = 'save'
    render()
    api('POST', '/api/workbench/brand/templates', { item: id, name: name, replace: !!replace }).then(function (r) {
      WB.brandTplBusy = null
      if (WB.projectId !== pid) return
      if (!r.ok) {
        render()
        if (r.code === 'brand_template_name_taken' && !replace) {
          if (window.confirm(t('workbench.brand.tpl_replace_confirm', { name: name }))) saveBrandTemplate(name, true)
        } else window.showToast(r.message)
        return
      }
      WB.brandTemplates = r.data.templates || []
      window.showToast(t(r.data.replaced ? 'workbench.brand.tpl_replaced' : 'workbench.brand.tpl_saved', { name: r.data.template.name }))
      render()
    })
  }

  /** A new drawing from a brand template; the template itself is not touched. */
  function useBrandTemplate(tplId) {
    var pid = WB.projectId
    if (!tplId || WB.brandTplBusy || archived()) return
    WB.brandTplBusy = tplId
    render()
    api('POST', '/api/workbench/brand/templates/' + encodeURIComponent(tplId) + '/use', { project: pid }).then(function (r) {
      WB.brandTplBusy = null
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.brandOpen = false
      WB.formOpen = false
      window.showToast(t('workbench.brand.tpl_created', { name: r.data.template.name, title: r.data.item.title }))
      // Opened at once: the copy is there, it can be changed.
      selectItem(r.data.item.id)
      load(pid)
    })
  }

  function deleteBrandTemplate(tplId) {
    var pid = WB.projectId
    var tp = (WB.brandTemplates || []).filter(function (x) { return x.id === tplId })[0]
    if (!tp || WB.brandTplBusy || archived()) return
    if (!window.confirm(t('workbench.brand.tpl_del_confirm', { name: tp.name }))) return
    WB.brandTplBusy = tplId
    render()
    api('DELETE', '/api/workbench/brand/templates/' + encodeURIComponent(tplId) + '?project=' + encodeURIComponent(pid)).then(function (r) {
      WB.brandTplBusy = null
      if (WB.projectId !== pid) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.brandTemplates = r.data.templates || []
      window.showToast(t('workbench.brand.tpl_deleted'))
      render()
    })
  }

  function runBrandCheck() {
    var id = WB.selectedId
    if (!id) return
    WB.brandCheck = { itemId: id, loading: true }
    render()
    api('GET', '/api/workbench/brand/check?item=' + encodeURIComponent(id)).then(function (r) {
      if (WB.selectedId !== id) return
      WB.brandCheck = r.ok ? { itemId: id, data: r.data } : { itemId: id, error: r.message }
      render()
    })
  }

  function brandCheckHtml() {
    var c = WB.brandCheck
    if (!c || c.itemId !== WB.selectedId) return ''
    var inner
    if (c.loading) inner = '<p class="wb-hint">' + esc(t('workbench.brand.checking')) + '</p>'
    else if (c.error) inner = '<p class="wb-error">' + esc(c.error) + '</p>'
    else if (!c.data.has_brand) inner = '<p class="wb-hint">' + esc(t('workbench.brand.check_nobrand')) + '</p>'
    // No drawing was compared: "no deviations" would be a false all-clear.
    else if (c.data.has_canvas === false) inner = '<p class="wb-hint">' + esc(t('workbench.brand.check_nocanvas')) + '</p>'
    else if (!c.data.findings.length) inner = '<p class="wb-hint wb-brand-ok">' + esc(t('workbench.brand.check_ok')) + '</p>'
    else inner = '<p class="wb-hint">' + esc(t('workbench.brand.check_found', { n: c.data.findings.length })) + '</p>'
      + '<ul class="wb-brand-findings">' + c.data.findings.map(function (f) { return '<li>' + esc(f.message) + '</li>' }).join('') + '</ul>'
    return '<div class="wb-brand-check" role="status">' + inner + '</div>'
  }

  // ---- projekt-idovonal (#406, 7. pont) --------------------------------------
  //
  // A projekt minden esemenye egy gorgetheto savban, a legfrissebb felul. A
  // szerver csak adatot ad (`kind` + cim/verzio/fajlnev); a mondatot itt rakjuk
  // ossze, ket nyelven. Munkadarabhoz tartozo sor kattinthato: megnyitja azt.

  function tlText(ev) {
    return t('workbench.tl.kind.' + ev.kind, {
      item: ev.item_title || t('workbench.tl.unknown_item'),
      n: ev.version_no != null ? ev.version_no : '',
      from: ev.from_version_no != null ? ev.from_version_no : '',
      file: ev.file_name || '',
      card: ev.card_seq != null ? '#' + ev.card_seq : '',
      title: ev.card_title || '',
      what: ev.approval_description || '',
    })
  }

  function tlRowHtml(ev) {
    var text = esc(tlText(ev))
    var body = ev.item_id
      ? '<button type="button" class="wb-tl-link" data-wb-item="' + escA(ev.item_id) + '">' + text + '</button>'
      : '<span>' + text + '</span>'
    return '<li class="wb-tl-row wb-tl-' + escA(ev.kind) + '">'
      + '<span class="wb-tl-when">' + esc(when(ev.at)) + '</span>'
      + '<span class="wb-tl-dot" aria-hidden="true"></span>'
      + body
      + '</li>'
  }

  function timelinePanelHtml() {
    if (!WB.tlOpen) return ''
    var body = ''
    if (WB.tlError) body += '<p class="wb-error">' + esc(WB.tlError) + '</p>'
    // Ha egy forras nem olvashato, KIMONDJUK: abbol most semmi nem latszik.
    // Ez nem ugyanaz, mint hogy nem tortent semmi.
    if (WB.tlSources && WB.tlSources.length) {
      body += '<p class="wb-error">' + esc(t('workbench.tl.partial', {
        sources: WB.tlSources.map(function (s) { return t('workbench.tl.source.' + s.source) }).join(', '),
      })) + '</p>'
    }
    if (WB.tl === null) {
      if (!WB.tlError) body += '<p class="wb-hint">' + esc(t('workbench.tl.loading')) + '</p>'
    } else if (!WB.tl.length) {
      body += '<p class="wb-hint">' + esc(t('workbench.tl.empty')) + '</p>'
    } else {
      body += '<ol class="wb-tl">' + WB.tl.map(tlRowHtml).join('') + '</ol>'
      if (WB.tlMore) {
        body += '<button type="button" class="btn-secondary wb-tl-more" data-wb-act="tl-more"' + (WB.tlBusy ? ' disabled' : '') + '>'
          + esc(t(WB.tlBusy ? 'workbench.tl.loading' : 'workbench.tl.more')) + '</button>'
      }
    }
    return '<section class="wb-caps-panel wb-tl-panel" id="wbTimelinePanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.tl.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-refresh">' + esc(t('common.refresh')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.tl.intro')) + '</p>'
      + body
      + '</section>'
  }

  /** `more` = a meglevo lista ala a regebbiek; kulonben elolrol. */
  function loadTimeline(more) {
    if (!WB.projectId || WB.tlBusy) return
    var pid = WB.projectId
    var url = '/api/workbench/timeline?project=' + encodeURIComponent(pid)
    if (more && WB.tlNext) url += '&before=' + encodeURIComponent(WB.tlNext)
    WB.tlBusy = true
    WB.tlError = null
    if (!more) { WB.tl = null; WB.tlSources = [] }
    render()
    api('GET', url).then(function (r) {
      WB.tlBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) {
        // "Nem lattunk oda", nem "nincs esemeny".
        WB.tlError = r.message || t('workbench.tl.error')
        if (!more) WB.tl = null
        render()
        return
      }
      var tl = (r.data && r.data.timeline) || { events: [], more: false, next_before: null, errors: [] }
      WB.tl = (more && WB.tl ? WB.tl : []).concat(tl.events || [])
      WB.tlMore = !!tl.more
      WB.tlNext = tl.next_before || null
      WB.tlSources = tl.errors || []
      render()
    })
  }

  /** A ket elrendezes. Mindkettoben UGYANAZOK a panelek allnak (semmi nem
   *  vesz el valtaskor), csak mas a helyuk.
   *  Harom panel: bal oldalt a CHAT, kozepen az aktualis munka, jobbra a
   *  kontextus; a munkadarab-lista (uj munkadarab, sablonok) ALATTUK -- azt
   *  ritkan kell, a chatet folyamatosan (Boss, 2026-09-26, TG 6552).
   *  Osztott nezet: keskeny chat bal oldalt, SZELES elo munkadarab jobb
   *  oldalt (TG 6553: "a chat a kepernyo felet elfoglalja. Minek?"); a lista
   *  es a reszletek alattuk. Telefonon egymas ala kerulnek -- a CSS dolga. */
  function layoutHtml() {
    if (WB.layout !== 'split') {
      return '<div class="wb-grid wb-grid-chatfirst">'
        + '<div class="wb-grid-chat">' + chatBarHtml() + '</div>'
        + editorPanelHtml() + contextPanelHtml() + '</div>'
        + '<div class="wb-grid-below">' + itemsPanelHtml() + '</div>'
    }
    return '<div class="wb-split">'
      + '<div class="wb-split-chat">' + chatBarHtml() + '</div>'
      + '<div class="wb-split-work">' + editorPanelHtml() + '</div>'
      + '</div>'
      + '<div class="wb-grid wb-grid-aside">' + itemsPanelHtml() + contextPanelHtml() + '</div>'
  }

  /** Did this tool event change what the right side shows? A deck, a video
   *  timeline, a document outline and a project file are work items like a
   *  drawing (#462: after `deck.edit` the slides stayed stale). A tool that only
   *  reads is left out: a refresh redraws the editor under the owner's hands.
   *  `code-bridge` is the full agent -- it works on the files and the API by
   *  itself, no tool of ours reports what it did, so however it ended (done,
   *  stopped, failed half way) the server is asked again. */
  var LIVE_READ_TOOL = /\.(get|read|pages|outline|preview|check|annexes|court|annexSettings|variants|glossary|deadlines)$/
  function toolChangedWork(ev) {
    var name = String(ev.name || '')
    if (name === 'code-bridge') return ev.status === 'ok' || ev.status === 'error'
    if (ev.status !== 'ok') return false
    if (/^(workItem|canvas)\./.test(name)) return true
    return /^(deck|timeline|doc|document|file)\./.test(name) && !LIVE_READ_TOOL.test(name)
  }

  /** ELO elonezet: amikor az agens egy munkadarab-eszkozt SIKERESEN lefuttat,
   *  a jobb oldal meg a valasz vege elott frissul. Rovid kesleltetessel, hogy
   *  egy sor egymas utani lepes ne kerjen le tucatnyi elonezetet. */
  function scheduleLiveRefresh() {
    if (!WB.selectedId) return
    if (WB.liveTimer) clearTimeout(WB.liveTimer)
    var itemId = WB.selectedId
    WB.liveTimer = setTimeout(function () {
      WB.liveTimer = null
      if (!WB.open || WB.selectedId !== itemId) return
      api('GET', '/api/workbench/items/' + encodeURIComponent(itemId)).then(function (r) {
        if (!r.ok || WB.selectedId !== itemId || !WB.detail) return
        WB.detail = r.data
        loadPreview(itemId, WB.previewVersion, true)
        // Az agent a rajzon is dolgozhatott (canvas.edit): a munkapeldany, a
        // visszavonas es a "Mentve" jelzes is onnan jon.
        if (WB.canvas || canvasKind(r.data && r.data.item)) loadCanvas(itemId)
        if (WB.vt || (r.data && r.data.item && r.data.item.type === 'video')) loadVideoTimeline(itemId)
        if (r.data && r.data.item && r.data.item.type === 'presentation') loadDeck(itemId)
        // az agens teendot is felvehetett (workItem.addTodo)
        loadTodos()
      })
    }, 400)
  }


  // ---- EGYSZERU NEZET (#462) ------------------------------------------------
  //
  // A terv szerinti kinezet (v1 terv 2-4. pont, v4 spec 6.1, K-3.1-3.3): felul
  // egy egyszeru fejlec, indulaskor EGY kerdes ("Mit szeretnel letrehozni?"),
  // balra a chat, jobbra az eredmeny munkatipus szerint. MINDEN technikai elem
  // a tobbpontos menu mogott van -- ugyanazok a fuggvenyek rajzoljak, mint a
  // manualis nezetben, semmi nem torlodik, csak mas a helye.

  function isSimple() { return WB.view === 'simple' }

  /** A fejlec gombjai: a legnagyobb meret, amelyiknel a sor egy sorban elfer (Boss, TG 7284: ne
   *  legyenek feleslegesen kicsik). Szint 0 = eredeti, 3 = a legkisebb; ha egyik sem fer, torik. */
  function fitHead() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
    var head = document.querySelector('.wb-head-oneline')
    if (!head || !head.parentElement) return
    var kids = []
    for (var i = 0; i < head.children.length; i++) if (head.children[i].tagName !== 'H1') kids.push(head.children[i])
    var avail = head.clientWidth, chosen = -1
    // Rejtett / meg nem kiszamolt elrendezes: nincs mit merni, kesobb ujra.
    if (!avail) { setTimeout(fitHead, 250); return }
    for (var lvl = 0; lvl <= 3; lvl++) {
      head.className = 'wb-head wb-head-oneline wb-fit-' + lvl
      var gap = parseFloat(window.getComputedStyle(head).columnGap) || 12
      var need = 60 + gap * kids.length
      for (var k = 0; k < kids.length; k++) need += kids[k].getBoundingClientRect().width
      if (need <= avail) { chosen = lvl; break }
    }
    head.className = chosen >= 0 ? 'wb-head wb-head-oneline wb-fit-ok wb-fit-' + chosen : 'wb-head wb-head-oneline wb-fit-3'
  }
  var headObserver = null
  function observeHeadWidth() {
    if (typeof window.ResizeObserver !== 'function' || typeof document.querySelector !== 'function') return
    var head = document.querySelector('.wb-head-oneline')
    if (!head || !head.parentElement) return
    if (headObserver) headObserver.disconnect()
    var last = head.clientWidth
    headObserver = new window.ResizeObserver(function () {
      var w = head.clientWidth
      if (w !== last) { last = w; fitHead() }
    })
    headObserver.observe(head)
    headObserver.observe(head.parentElement)
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(fitHead)
  }
  if (!window.__wbFitBound && typeof window.addEventListener === 'function') {
    window.__wbFitBound = true
    var fitTimer = null
    window.addEventListener('resize', function () { clearTimeout(fitTimer); fitTimer = setTimeout(fitHead, 120) })
  }

  /** A valaszto a fejlecben: ket allas, az aktualis jelolve. */
  function viewSwitchHtml() {
    function btn(v) {
      var on = WB.view === v
      return '<button type="button" class="wb-view-btn' + (on ? ' wb-view-on' : '') + '" data-wb-act="view-set" data-wb-view="' + v + '"'
        + ' aria-pressed="' + on + '">' + esc(t('workbench.view.' + v)) + '</button>'
    }
    return '<div class="wb-view-switch" role="group" aria-label="' + escA(t('workbench.view.label')) + '"'
      + ' title="' + escA(t('workbench.view.hint')) + '">' + btn('manual') + btn('simple') + '</div>'
  }

  function setView(v) {
    v = v === 'simple' ? 'simple' : 'manual'
    if (WB.view === v) return
    WB.view = v
    saveView(v)
    WB.shMore = false
    render()
  }

  /** Mentve / Mentes... / szerkesztes alatt. Az allapotot a FELULET valos
   *  allapotabol szamoljuk (nyitott szerkeszto, folyamatban levo muvelet), nem
   *  allitjuk "Mentve"-nek mindig. */
  function savedState() {
    if (WB.busy || WB.versionBusy || WB.partBusy || WB.upload || WB.docFinalizing) return 'saving'
    var editing = WB.docEdit || WB.pdfEdit || WB.textEdit || WB.partEdit || WB.partNewOpen || WB.canvasEdit
      || (WB.table && WB.table.dirty) || (WB.img && WB.img.dirty)
    return editing ? 'editing' : 'saved'
  }

  function simpleHeadHtml() {
    var it = WB.selectedId && WB.detail ? WB.detail.item : null
    var title = it ? it.title : (WB.project ? WB.project.name : '')
    var st = savedState()
    var out = '<div class="wb-head wb-sh-head">'
      + '<button type="button" class="prj-back-link" data-wb-act="back">' + esc(t('workbench.back_to_project')) + '</button>'
      + '<h1 class="wb-sh-title">' + (it ? workSeqHtml(it) : '') + esc(title) + '</h1>'
    if (it) out += '<span class="wb-sh-saved wb-sh-saved-' + st + '" role="status">' + esc(t('workbench.sh.saved.' + st)) + '</span>'
    if (it && !archived()) {
      out += '<button type="button" class="btn-secondary" data-wb-act="sh-new">' + esc(t('workbench.sh.new')) + '</button>'
    }
    if (it) {
      out += '<button type="button" class="btn-secondary" data-wb-act="' + (exportIsOpen() ? 'export-close' : 'export-open') + '"'
        + ' aria-expanded="' + exportIsOpen() + '">' + esc(t('workbench.exp.open')) + '</button>'
    }
    out += viewSwitchHtml()
      + '<button type="button" class="btn-secondary wb-sh-more" data-wb-act="sh-more" aria-expanded="' + !!WB.shMore + '"'
      + ' aria-label="' + escA(t('workbench.sh.more')) + '" title="' + escA(t('workbench.sh.more')) + '">&#8942;</button>'
      + '</div>'
    return out + (it && exportIsOpen() ? exportPanelHtml() : '')
  }

  /** Az indulo kep: egy kerdes, egy szovegmezo, ot gomb. A mappa-valasztas
   *  (ha a projektnek van mappa-rendszere) a Technikai reszletek helyett itt
   *  marad, mert nelkule a letrehozas nem engedelyezett. */
  function simpleIntakeHtml() {
    var ask = WB.intakeAsk
    var kinds = ask ? ask.options : INTAKE_UI_KINDS
    var busy = !!WB.intakeBusy
    return '<section class="wb-sh-intake">'
      + '<h2 class="wb-sh-ask">' + esc(t('workbench.sh.ask')) + '</h2>'
      + '<textarea class="wb-input wb-intake-text" id="wbIntakeText" rows="3" maxlength="4000" placeholder="'
      + escA(t('workbench.sh.placeholder')) + '" aria-label="' + escA(t('workbench.sh.ask')) + '">' + esc(WB.intakeDraft || '') + '</textarea>'
      + (ask ? '<div class="info-box wb-intake-ask" role="status">' + esc(ask.message) + '</div>' : '')
      + '<div class="wb-intake-kinds">' + kinds.map(function (k) {
        return '<button type="button" class="btn-secondary wb-intake-kind" data-wb-act="intake-kind" data-wb-kind="' + escA(k) + '"'
          + (busy ? ' disabled' : '') + '>' + esc(t('workbench.intake.kind.' + k)) + '</button>'
      }).join('') + '</div>'
      + intakePlatformHtml()
      + (archived() ? '<p class="wb-hint">' + esc(t('workbench.archived_hint')) + '</p>'
        : '<p><button type="button" class="btn-primary" data-wb-act="intake-go"' + (busy ? ' disabled' : '') + '>'
          + esc(busy ? t('workbench.new.creating') : t('workbench.intake.go')) + '</button></p>'
          + (hasFolderSystem() ? '<div class="wb-sh-folder">' + folderPickHtml() + '</div>' : ''))
      + (ask ? '<p><button type="button" class="btn-secondary" data-wb-act="intake-reset">' + esc(t('workbench.intake.all_kinds')) + '</button></p>' : '')
      + '</section>'
  }

  // --- dokumentum: Vazlat | Elonezet | Forrasok | Hianyok ---

  var DOC_MISSING_RE = /⚠\s*(Hiányzó adat|Forrás nem található|Missing data|Source not found)[^\n⚠]*/g

  function docSourcesHtml(o, ro) {
    var rows = []
    ;(o.sections || []).forEach(function (sec) {
      var claims = []
      ;(sec.blocks || []).forEach(function (b) { (b.claims || []).forEach(function (c) { claims.push(c) }) })
      if (claims.length) rows.push('<h4>' + esc(sec.title) + '</h4><ul class="wb-outline-claims">' + claims.map(function (c) { return claimHtml(c, ro) }).join('') + '</ul>')
    })
    return rows.length ? rows.join('') : '<p class="wb-hint">' + esc(t('workbench.sh.doc.sources_none')) + '</p>'
  }

  function docGapsHtml(o, ro) {
    var rows = []
    ;(o.sections || []).forEach(function (sec) {
      var lines = []
      ;(sec.blocks || []).forEach(function (b) {
        ;(String(b.text || '').match(DOC_MISSING_RE) || []).forEach(function (m) {
          lines.push('<li><mark class="wb-outline-missing">' + esc(m) + '</mark></li>')
        })
        ;(b.claims || []).forEach(function (c) {
          if (c.strength === 'unverified' || c.strength === 'owner_unconfirmed' || c.strength === 'inference') {
            lines.push('<li>' + esc(claimIcon(c)) + ' ' + esc(c.text) + ' <span class="wb-muted">' + esc(t('workbench.outline.strength.' + c.strength)) + '</span></li>')
          }
        })
      })
      if (lines.length) rows.push('<h4>' + esc(sec.title) + '</h4><ul class="wb-outline-claims">' + lines.join('') + '</ul>')
    })
    return (rows.length ? rows.join('') : '<p class="wb-hint">' + esc(t('workbench.sh.doc.gaps_none')) + '</p>')
      + (o.check ? outlineCheckHtml(o.check, o, ro) : '')
  }

  // ---- A DOKUMENTUM LAPJA (#462, 4. lepes): a lap maga a szerkeszto --------------------------
  //
  // Kattintas a szovegre = gepeles, nincs kulon beviteli mezo. A sor mellett balra: "+" (beszuras
  // ott) es egy fogantyu (huzas / menu). Az adat a vazlat (fejezetek + blokkok), ugyanaz, amit az
  // agent is ir: a lap csak a kezi felulete. Mentes: a mezobol kilepeskor (blur) es Entert nyomva.

  function dpPlainOk() {
    if (WB.dpPlain === undefined) {
      try { var probe = document.createElement('div'); probe.contentEditable = 'plaintext-only'; WB.dpPlain = probe.contentEditable === 'plaintext-only' } catch (_e) { WB.dpPlain = false }
    }
    return WB.dpPlain
  }

  function dpDraft(key, fallback) {
    var d = WB.docDrafts && WB.docDrafts[key]
    return d === undefined || d === null ? fallback : d
  }

  /** Egy szerkesztheto szovegmezo (blokk, cim vagy uj sor). */
  function dpEditHtml(cls, id, attrs, text, ph, label, ro) {
    return '<div class="wb-dp-edit ' + cls + '" id="' + escA(id) + '" ' + attrs
      + (ro ? '' : ' contenteditable="' + (dpPlainOk() ? 'plaintext-only' : 'true') + '" spellcheck="true"')
      + ' role="textbox" aria-multiline="true" aria-label="' + escA(label) + '" data-placeholder="' + escA(ph) + '">' + esc(text) + '</div>'
  }

  function dpMenuHtml(kind, bid, sid, idx, count) {
    var m = WB.docMenu
    if (!m || m.kind !== kind || m.block !== bid || m.sec !== sid) return ''
    var item = function (act, label, extra, dis) {
      return '<button type="button" class="wb-dp-mi" role="menuitem" data-wb-act="' + act + '" data-wb-block="' + escA(bid || '') + '" data-wb-sec="' + escA(sid) + '"'
        + (extra || '') + (dis ? ' disabled' : '') + '>' + esc(label) + '</button>'
    }
    if (kind === 'add') {
      return '<div class="wb-dp-menu" role="menu">' + item('dp-ins', t('workbench.dp.ins_text'), ' data-wb-kind="paragraph"')
        + item('dp-ins', t('workbench.dp.ins_list'), ' data-wb-kind="list"') + item('dp-ins-section', t('workbench.dp.ins_section')) + '</div>'
    }
    return '<div class="wb-dp-menu" role="menu">' + item('dp-move', t('workbench.dp.up'), ' data-wb-dir="-1"', idx === 0 && !WB.docMenu.canPrevSec)
      + item('dp-move', t('workbench.dp.down'), ' data-wb-dir="1"', idx >= count - 1 && !WB.docMenu.canNextSec)
      + item('dp-del', t('workbench.dp.del')) + '</div>'
  }

  function dpGutterHtml(bid, sid, idx, count, ro) {
    if (ro) return '<div class="wb-dp-gutter"></div>'
    return '<div class="wb-dp-gutter">'
      + '<button type="button" class="wb-dp-gbtn wb-dp-plus" data-wb-act="dp-add" data-wb-block="' + escA(bid || '') + '" data-wb-sec="' + escA(sid) + '" data-wb-idx="' + idx + '"'
      + ' title="' + escA(t('workbench.dp.add')) + '" aria-label="' + escA(t('workbench.dp.add')) + '" aria-haspopup="menu">+</button>'
      + (bid ? '<button type="button" class="wb-dp-gbtn wb-dp-handle" draggable="true" data-wb-act="dp-handle" data-wb-block="' + escA(bid) + '" data-wb-sec="' + escA(sid) + '"'
        + ' title="' + escA(t('workbench.dp.handle')) + '" aria-label="' + escA(t('workbench.dp.handle')) + '" aria-haspopup="menu">&#8942;&#8942;</button>' : '')
      + dpMenuHtml('add', bid, sid, idx, count) + (bid ? dpMenuHtml('handle', bid, sid, idx, count) : '')
      + '</div>'
  }

  function dpGhostHtml(sid, pos, kind, count, ro) {
    return '<div class="wb-dp-row wb-dp-ghost" data-wb-sec="' + escA(sid) + '">' + dpGutterHtml('', sid, pos, count, ro)
      + dpEditHtml('wb-dp-block wb-outline-kind-' + escA(kind || 'paragraph'), 'wbDpNew', 'data-wb-dp="new" data-wb-sec="' + escA(sid) + '" data-wb-pos="' + pos + '" data-wb-kind="' + escA(kind || 'paragraph') + '"',
        dpDraft('new:' + sid + ':' + pos, ''), t('workbench.dp.block_ph'), t('workbench.dp.block_label'), ro) + '</div>'
  }

  function dpSectionHtml(o, sec, si, ro) {
    var blocks = sec.blocks || []
    var nw = WB.docNew && WB.docNew.sec === sec.id ? WB.docNew : null
    var rows = ''
    blocks.forEach(function (b, i) {
      if (nw && nw.pos === i) rows += dpGhostHtml(sec.id, i, nw.kind, blocks.length, ro)
      rows += '<div class="wb-dp-row" data-wb-row="' + escA(b.id) + '" data-wb-sec="' + escA(sec.id) + '">' + dpGutterHtml(b.id, sec.id, i, blocks.length, ro)
        + dpEditHtml('wb-dp-block wb-outline-kind-' + escA(b.kind), 'wbDpB_' + b.id, 'data-wb-dp="block" data-wb-block="' + escA(b.id) + '" data-wb-sec="' + escA(sec.id) + '"',
          dpDraft('b:' + b.id, b.text), t('workbench.dp.block_ph'), t('workbench.dp.block_label'), ro)
        + (b.claims && b.claims.length ? '<ul class="wb-outline-claims wb-dp-extra">' + b.claims.map(function (c) { return claimHtml(c, ro) }).join('') + '</ul>' : '')
        + (b.rewrite ? '<div class="wb-dp-extra">' + rewriteHtml(b, ro) + '</div>' : '') + '</div>'
    })
    if (nw && nw.pos >= blocks.length) rows += dpGhostHtml(sec.id, blocks.length, nw.kind, blocks.length, ro)
    else if (!blocks.length) rows += dpGhostHtml(sec.id, 0, 'paragraph', 0, ro)
    var status = ro ? '<span class="wb-pill">' + esc(t('workbench.outline.status.' + sec.status)) + '</span>'
      : '<button type="button" class="wb-pill wb-outline-status wb-outline-status-' + escA(sec.status) + '" data-wb-act="outline-sec-status" data-wb-sec="' + escA(sec.id) + '" data-wb-status="' + escA(SECTION_NEXT[sec.status] || 'todo') + '"'
        + ' title="' + escA(t('workbench.outline.status_title')) + '">' + esc(t('workbench.outline.status.' + sec.status)) + '</button>'
    return '<section class="wb-dp-sec" data-wb-secbox="' + escA(sec.id) + '">'
      + '<div class="wb-dp-sechead">'
      + dpEditHtml('wb-dp-title', 'wbDpS_' + sec.id, 'data-wb-dp="sec" data-wb-sec="' + escA(sec.id) + '"', dpDraft('s:' + sec.id, sec.title), t('workbench.dp.title_ph'), t('workbench.dp.title_label'), ro)
      + '<span class="wb-dp-secbar">' + status
      + (sec.problems ? ' <span class="wb-doc-low">&#9888; ' + esc(t('workbench.outline.problems', { n: sec.problems })) + '</span>' : '')
      + (ro ? '' : ' <button type="button" class="wb-dp-secdel" data-wb-act="outline-sec-del" data-wb-sec="' + escA(sec.id) + '" title="' + escA(t('workbench.dp.sec_del')) + '" aria-label="' + escA(t('workbench.dp.sec_del')) + '">&#10005;</button>')
      + '</span></div>'
      + '<div class="wb-dp-secextra">' + langSectionHtml(o, sec, ro) + '</div>'
      + rows
      + '<div class="wb-dp-secextra">' + backcheckHtml(o, sec, ro) + '</div>'
      + '</section>'
  }

  function docPageHtml() {
    var d = WB.detail
    if (!d || !d.item) return ''
    var o = d.outline
    var ro = archived()
    var secs = (o && o.sections) || []
    var body
    if (!secs.length) {
      // Meg nincs fejezet: a lap ures, az elso begepelt sor hozza letre az elsot.
      body = dpGhostHtml('', 0, 'paragraph', 0, ro)
    } else body = secs.map(function (s, i) { return dpSectionHtml(o, s, i, ro) }).join('')
    return '<div class="wb-dp-wrap"><div class="wb-dp-page" role="group" aria-label="' + escA(t('workbench.dp.page_label')) + '">' + body + '</div>'
      + (ro ? '' : '<p class="wb-dp-foot"><span class="wb-hint">' + esc(t('workbench.dp.hint')) + '</span> '
        + '<button type="button" class="btn-secondary btn-compact" data-wb-act="dp-add-section">' + esc(t('workbench.dp.add_section')) + '</button></p>')
      + '</div>'
  }

  /** A lap alatti kiegeszitok: nyelvi valtozatok, mellekletek, szoszedet (ezek nem a lap reszei). */
  function docExtrasHtml() {
    var o = WB.detail && WB.detail.outline
    if (!o) return ''
    var ro = archived()
    var inner = langHeadHtml(o, ro) + annexHtml(o, ro) + glossaryHtml(o, ro)
    if (!inner) return ''
    return '<details class="wb-dp-more"><summary>' + esc(t('workbench.dp.more')) + '</summary>' + inner + '</details>'
  }

  // --- mentes es muveletek ---

  function dpCall(method, sub, body) {
    var id = WB.selectedId
    if (!id || archived()) return Promise.resolve(null)
    return api(method, '/api/workbench/items/' + encodeURIComponent(id) + '/outline' + sub, body).then(function (r) {
      if (!r.ok) {
        window.showToast(r.message)
        if (r.data && r.data.outline && WB.selectedId === id && WB.detail) { WB.detail.outline = r.data.outline; render() }
        return null
      }
      if (WB.selectedId === id && WB.detail) WB.detail.outline = r.data.outline
      return r.data.outline
    })
  }

  function dpText(el) {
    return String(el.innerText != null ? el.innerText : el.textContent || '').replace(/\r\n/g, '\n').replace(/ /g, ' ').replace(/\n+$/, '').trim()
  }

  function dpSections() { var o = WB.detail && WB.detail.outline; return (o && o.sections) || [] }

  /** Egy mezo tartalmanak elmentese; a Promise az uj vazlattal (vagy null-lal) ter vissza. */
  /** One save per field at a time: Enter starts the save and the blur that follows (a click elsewhere
   *  a moment later) must not send the same new line a second time. */
  function dpSave(el) {
    var key = dpDraftKey(el)
    if (!key) return dpSaveNow(el)
    WB.dpInflight = WB.dpInflight || {}
    if (WB.dpInflight[key]) return WB.dpInflight[key]
    var p = dpSaveNow(el)
    WB.dpInflight[key] = p
    var done = function () { if (WB.dpInflight[key] === p) delete WB.dpInflight[key] }
    p.then(done, done)
    return p
  }

  function dpSaveNow(el) {
    var kind = el.getAttribute('data-wb-dp')
    var text = dpText(el)
    if (kind === 'block') {
      var bid = el.getAttribute('data-wb-block')
      var b = findBlock(bid)
      if (!b) return Promise.resolve(null)
      if (text === b.text) { delete WB.docDrafts['b:' + bid]; return Promise.resolve(WB.detail.outline) }
      if (!text) { delete WB.docDrafts['b:' + bid]; render(); return Promise.resolve(null) } // ures szoveg nem mentheto: marad a regi
      return dpCall('PATCH', '/blocks/' + encodeURIComponent(bid), { text: text }).then(function (o) { if (o) delete WB.docDrafts['b:' + bid]; return o })
    }
    if (kind === 'sec') {
      var sid = el.getAttribute('data-wb-sec')
      var s = findSection(sid)
      if (!s) return Promise.resolve(null)
      if (text === s.title) { delete WB.docDrafts['s:' + sid]; return Promise.resolve(WB.detail.outline) }
      if (!text) { delete WB.docDrafts['s:' + sid]; render(); return Promise.resolve(null) }
      return dpCall('PATCH', '/sections/' + encodeURIComponent(sid), { title: text }).then(function (o) { if (o) delete WB.docDrafts['s:' + sid]; return o })
    }
    if (kind === 'new') {
      var nsid = el.getAttribute('data-wb-sec')
      var pos = Number(el.getAttribute('data-wb-pos')) || 0
      var key = 'new:' + nsid + ':' + pos
      if (el.getAttribute('data-wb-saved')) return Promise.resolve(null)
      if (!text) { delete WB.docDrafts[key]; return Promise.resolve(null) }
      var kd = el.getAttribute('data-wb-kind') || 'paragraph'
      var make = nsid ? Promise.resolve(nsid) : dpCall('POST', '/sections', { title: t('workbench.sh.seed.section') }).then(function (o) {
        var last = o && o.sections && o.sections[o.sections.length - 1]
        return last ? last.id : null
      })
      return make.then(function (sec) {
        if (!sec) return null
        return dpCall('POST', '/blocks', { section: sec, text: text, kind: kd, position: pos }).then(function (o) {
          if (o) { el.setAttribute('data-wb-saved', '1'); delete WB.docDrafts[key]; if (WB.docNew && WB.docNew.sec === nsid && WB.docNew.pos === pos) WB.docNew = null }
          return o
        })
      })
    }
    return Promise.resolve(null)
  }

  /** Kurzor-helyzet egy szerkesztheto mezoben (karakterekben), a render utani visszaallitashoz. */
  function dpCaret(el) {
    try {
      var sel = window.getSelection()
      if (!sel || !sel.rangeCount) return null
      var r = sel.getRangeAt(0)
      if (!el.contains(r.endContainer)) return null
      var pre = r.cloneRange()
      pre.selectNodeContents(el)
      pre.setEnd(r.endContainer, r.endOffset)
      return pre.toString().length
    } catch (_e) { return null }
  }

  function dpPlaceCaret(el, off) {
    try {
      var sel = window.getSelection()
      var r = document.createRange()
      var left = off == null ? Infinity : off
      var walker = document.createTreeWalker(el, 4)
      var node = null
      var n
      while ((n = walker.nextNode())) {
        node = n
        if (left <= n.nodeValue.length) { r.setStart(n, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return }
        left -= n.nodeValue.length
      }
      if (node) r.setStart(node, node.nodeValue.length)
      else r.setStart(el, 0)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    } catch (_e) { /* nem baj */ }
  }

  /** A mentetlen szoveg a WB.docDrafts-ba kerul, hogy az ujrarajzolas ne torolje ki. */
  function dpDraftKey(el) {
    var k = el.getAttribute('data-wb-dp')
    if (k === 'block') return 'b:' + el.getAttribute('data-wb-block')
    if (k === 'sec') return 's:' + el.getAttribute('data-wb-sec')
    if (k === 'new') return 'new:' + el.getAttribute('data-wb-sec') + ':' + el.getAttribute('data-wb-pos')
    return ''
  }
  function dpKeepDraft(el) {
    var key = dpDraftKey(el)
    if (!key || el.getAttribute('data-wb-saved')) return
    var txt = dpText(el)
    var orig = key.charAt(0) === 'b' ? (findBlock(el.getAttribute('data-wb-block')) || {}).text
      : key.charAt(0) === 's' ? (findSection(el.getAttribute('data-wb-sec')) || {}).title : ''
    if (txt === (orig || '')) delete WB.docDrafts[key]
    else WB.docDrafts[key] = String(el.innerText != null ? el.innerText : el.textContent || '').replace(/\n+$/, '')
  }

  /** A render() hivja a kirajzolas elott / utan: a gepeles kozbeni ujrarajzolas ne vegye el a fokuszt. */
  function dpFocusSnapshot() {
    var a = document.activeElement
    if (a && typeof a.getAttribute === 'function' && a.getAttribute('data-wb-dp') && a.id) {
      dpKeepDraft(a)
      return { id: a.id, off: dpCaret(a) }
    }
    return null
  }
  function dpFocusRestore(snap) {
    var want = WB.docFocus || snap
    WB.docFocus = null
    if (!want) return
    var el = document.getElementById(want.id)
    if (!el || typeof el.focus !== 'function') return
    el.focus()
    if (want.select) {
      try { var sel = window.getSelection(); var r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r) } catch (_e) { /* nem baj */ }
    } else dpPlaceCaret(el, want.end ? null : want.off)
  }

  function dpAddSection() {
    if (archived()) return
    dpCall('POST', '/sections', { title: t('workbench.sh.seed.section') }).then(function (o) {
      var last = o && o.sections && o.sections[o.sections.length - 1]
      if (last) WB.docFocus = { id: 'wbDpS_' + last.id, select: true }
      if (o) render()
    })
  }

  /** "+" menu: uj sor a megadott blokk ala (vagy a fejezet elejere, ha nincs blokk), kivalasztott fajtaval. */
  function dpInsert(sid, bid, kind) {
    var sec = findSection(sid)
    var idx = 0
    if (sec && bid) (sec.blocks || []).forEach(function (b, i) { if (b.id === bid) idx = i + 1 })
    WB.docMenu = null
    WB.docNew = { sec: sid, pos: idx, kind: kind || 'paragraph' }
    WB.docFocus = { id: 'wbDpNew', end: true }
    render()
  }

  function dpInsertSection(sid) {
    var si = 0
    dpSections().forEach(function (s, i) { if (s.id === sid) si = i })
    WB.docMenu = null
    dpCall('POST', '/sections', { title: t('workbench.sh.seed.section'), position: si + 1 }).then(function (o) {
      if (!o) return
      var sec = o.sections[si + 1]
      if (sec) WB.docFocus = { id: 'wbDpS_' + sec.id, select: true }
      render()
    })
  }

  /** Blokk athelyezese: ugyanabban a fejezetben vagy masikba (a fogantyu menuje / huzas). */
  function dpMoveBlock(bid, toSec, toPos) {
    return dpCall('PATCH', '/blocks/' + encodeURIComponent(bid), { section: toSec, position: toPos }).then(function (o) { if (o) render(); return o })
  }

  function dpMoveStep(bid, dir) {
    var secs = dpSections()
    var si = -1, bi = -1
    secs.forEach(function (s, i) { (s.blocks || []).forEach(function (b, j) { if (b.id === bid) { si = i; bi = j } }) })
    if (si < 0) return
    var n = bi + dir
    var cur = secs[si].blocks || []
    WB.docMenu = null
    if (n >= 0 && n < cur.length) dpMoveBlock(bid, secs[si].id, n)
    else if (dir < 0 && si > 0) dpMoveBlock(bid, secs[si - 1].id, (secs[si - 1].blocks || []).length)
    else if (dir > 0 && si < secs.length - 1) dpMoveBlock(bid, secs[si + 1].id, 0)
    else render()
  }

  function dpDeleteBlock(bid) {
    WB.docMenu = null
    var secs = dpSections()
    var prev = null
    secs.forEach(function (s) { var bl = s.blocks || []; bl.forEach(function (b, j) { if (b.id === bid && j > 0) prev = bl[j - 1].id }) })
    dpCall('DELETE', '/blocks/' + encodeURIComponent(bid)).then(function (o) {
      if (!o) return
      delete WB.docDrafts['b:' + bid]
      if (prev) WB.docFocus = { id: 'wbDpB_' + prev, end: true }
      render()
    })
  }

  function dpMenuOpen(kind, bid, sid) {
    var m = WB.docMenu
    if (m && m.kind === kind && m.block === bid && m.sec === sid) { WB.docMenu = null; render(); return }
    var secs = dpSections()
    var si = 0
    secs.forEach(function (s, i) { if (s.id === sid) si = i })
    WB.docMenu = { kind: kind, block: bid, sec: sid, canPrevSec: si > 0, canNextSec: si < secs.length - 1 }
    render()
  }

  function docTabsHtml() {
    var o = WB.detail && WB.detail.outline
    var ro = archived()
    var tab = WB.shDocTab
    var tabs = [['draft', 'workbench.sh.doc.draft'], ['preview', 'workbench.sh.doc.preview'], ['sources', 'workbench.sh.doc.sources'], ['gaps', 'workbench.sh.doc.gaps']]
    var head = '<div class="wb-sh-doc-tabs" role="tablist">' + tabs.map(function (x) {
      return '<button type="button" class="tab-btn' + (tab === x[0] ? ' active' : '') + '" role="tab" aria-selected="' + (tab === x[0]) + '"'
        + ' data-wb-act="sh-doc-tab" data-wb-tab="' + x[0] + '">' + esc(t(x[1])) + '</button>'
    }).join('') + '</div>'
    var base = '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/outline'
    // A ket gomb vazlat nelkul is ott van (kiszurkitve): a tulajdonos lassa, mi
    // jon a vegen, es azt is, miert nem nyomhato meg meg.
    var actions = '<p class="wb-sh-doc-actions">'
      + (o ? '<a class="btn-secondary btn-compact" href="' + escA(base + '/pdf?lang=' + encodeURIComponent(window._lang || 'hu')) + '" target="_blank" rel="noopener"'
        + ' title="' + escA(t('workbench.outline.draft_pdf_hint')) + '">' + esc(t('workbench.sh.doc.draft_pdf')) + '</a> '
        : '<button type="button" class="btn-secondary btn-compact" disabled title="' + escA(t('workbench.sh.doc.no_draft')) + '">' + esc(t('workbench.sh.doc.draft_pdf')) + '</button> ')
      + (ro ? '' : '<button type="button" class="btn-primary btn-compact" data-wb-act="sh-final"' + (o ? '' : ' disabled title="' + escA(t('workbench.sh.doc.no_draft')) + '"')
        + ' aria-expanded="' + !!WB.shFinal + '">' + esc(t('workbench.sh.doc.finalize')) + '</button>')
      + '</p>' + (o && WB.shFinal && !ro ? outlinePdfHtml(o, ro) : '')
    var body = tab === 'preview' ? previewHtml()
      : tab === 'sources' ? (o ? docSourcesHtml(o, ro) : '<p class="wb-hint">' + esc(t('workbench.sh.doc.sources_none')) + '</p>')
      : tab === 'gaps' ? (o ? docGapsHtml(o, ro) : '<p class="wb-hint">' + esc(t('workbench.sh.doc.gaps_none')) + '</p>')
      : docPageHtml() + docExtrasHtml() + canvasHtml() + postPreviewHtml()
    return head + actions + '<div class="wb-sh-doc-body">' + body + '</div>'
  }

  /** A jobb oldal: az eredmeny a munkatipus szerint. A poszt a vaszonnal
   *  EGYUTT latszik (nem gomb mogott), a video lejatszoval es idosavval, a
   *  prezentacio a diakkal. */
  function simpleResultHtml() {
    if (!WB.selectedId) return '<p class="wb-muted wb-center">' + esc(t('workbench.sh.none')) + '</p>'
    if (!WB.detail) return '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    var it = WB.detail.item
    var inner
    if (WB.compare && WB.compare.itemId === WB.selectedId) inner = compareHtml()
    else if (it.type === 'document') inner = docTabsHtml()
    else {
      // Egyszeru nezet: a kesz kep/oldal van legfelul, a szerkeszto gombok alatta (ures vaszon is latszik azonnal).
      // Videonal es diasornal az idosav / a diak a fo tartalom, az (ilyenkor ures) elonezet csak alattuk jon.
      inner = (it.type === 'video' || it.type === 'presentation'
        ? videoTimelineHtml() + deckHtml() + previewHtml() + canvasHtml()
        : previewHtml() + canvasHtml() + videoTimelineHtml() + deckHtml())
        // A sajat .md/.txt fajlu jegyzet tartalma a fajl: az elonezet mutatja, az "ures Tartalom" doboz felesleges.
        + (partsAreTechnical(it) || (it.type === 'note' && it.source_path) ? '' : partsHtml())
        + postPreviewHtml()
    }
    return '<div class="wb-sh-result wb-sh-type-' + escA(it.type) + '"' + (!archived() ? ' data-wb-drop="item"' : '') + '>' + inner + '</div>'
  }

  /** Alul: az Anyagok (a behuzas/feltoltes helye). */
  function simpleMaterialsHtml() {
    if (archived()) return ''
    return '<section class="wb-sh-materials"><h3>📎 ' + esc(t('workbench.sh.materials')) + '</h3>' + uploadZoneHtml() + '</section>'
  }

  /** A Technikai reszletek: a teljes manualis felulet (minden gomb, panel,
   *  lista), a kijelolt munkadarab belso reszeivel egyutt. Ide kerul a chat es
   *  a jobb oldali eredmeny KIVETELEVEL minden: azok az egyszeru nezet
   *  fo teruleten allnak, ketszer nem rajzoljuk ki (azonos azonositok). */
  function simpleTechHtml() {
    var it = WB.selectedId && WB.detail ? WB.detail.item : null
    var itemTech = it
      ? '<div class="wb-sh-tech-item">'
        + versionBarHtml()
        + (it.type === 'document' ? '' : outlineHtml())
        + (partsAreTechnical(it) ? partsTechHtml() : '')
        + deadlinesBoxHtml()
        + todosBoxHtml()
        + approvalBoxHtml()
        + '</div>'
      : ''
    var grp = function (key, body) {
      return body ? '<section class="wb-sh-tech-grp"><h3 class="wb-sh-tech-h">' + esc(t(key)) + '</h3>' + body + '</section>' : ''
    }
    var tools = '<div class="wb-head wb-sh-tech-actions">'
      + ['search', 'wk', 'tl', 'dec', 'brand', 'td', 'ho', 'caps'].map(function (k) {
        var open = { search: WB.searchOpen, wk: WB.wkOpen, tl: WB.tlOpen, dec: WB.decOpen, brand: WB.brandOpen, td: WB.tdOpen, ho: WB.hoOpen, caps: WB.capsOpen }[k]
        return '<button type="button" class="btn-secondary" data-wb-act="' + k + '-open" aria-pressed="' + !!open + '">' + esc(t('workbench.' + k + '.open')) + '</button>'
      }).join('')
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
      + capsPanelHtml() + searchPanelHtml() + timelinePanelHtml() + weeklyPanelHtml() + decisionsPanelHtml()
      + brandPanelHtml() + todosPanelHtml() + handoffPanelHtml()
    // Arranged by what the person is looking at: this work item first, then the project, then the tools.
    return '<section class="wb-sh-tech" id="wbShTech" aria-label="' + escA(t('workbench.sh.tech')) + '">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.sh.tech')) + '</h2>'
      + grp('workbench.sh.tech_item', itemTech)
      + grp('workbench.sh.tech_project', overviewHtml() + '<div class="wb-grid wb-grid-aside">' + itemsPanelHtml() + contextPanelHtml() + '</div>')
      + grp('workbench.sh.tech_tools', tools)
      + '</section>'
  }

  // ---- AZ EGYSZERU NEZET KERETE (#462, 2. lepes; Boss, 2026-10-02, TG 7299-7328) --------------------
  //
  // A Canva mintaja: felul egy sav (Fajl, Meretezes, visszavonas/ujra, Mentve, nev, Export), balra
  // keskeny, feliratos ikonsav + egy panel, KOZEPEN a lap, alul nagyitas, jobbra a chat (osszecsukhato).
  // A lap mellett semmilyen urlap nem all: a muveletek a panelen, a lebego eszkoztaron es a fejlecben vannak.

  var FR_TABS = [
    ['templates', '🖼️'], ['elements', '▦'], ['text', 'T'], ['brand', '🎨'],
    ['uploads', '☁️'], ['tools', '⚙️'], ['projects', '📁'],
  ]

  /** A video has no canvas: only the tabs that mean something for it (the video tools open by default). */
  function frTabs() {
    var it = WB.detail ? WB.detail.item : null
    if (frIsVideo(it)) return FR_TABS.filter(function (x) { return x[0] === 'tools' || x[0] === 'uploads' || x[0] === 'projects' })
    // A table has no canvas: templates/elements/text/faces/tools make no sense next to it.
    if (frIsTable(it)) return FR_TABS.filter(function (x) { return x[0] === 'uploads' || x[0] === 'projects' })
    return FR_TABS
  }
  function frTabNow() {
    if (!WB.frTab) return WB.frTab
    var ok = frTabs().some(function (x) { return x[0] === WB.frTab })
    return ok ? WB.frTab : (frTabs().some(function (x) { return x[0] === 'tools' }) ? 'tools' : 'uploads')
  }

  function frIsCanvasItem(it) {
    return !!it && !isDeckItem() && (!!canvasKind(it) || !!(WB.canvas && WB.canvas.exists))
  }

  function frCanvasReady() {
    return !!(WB.canvas && WB.canvas.exists && WB.canvas.canvas) && !archived()
  }

  /** Fent: Fajl menu, Meretezes menu, visszavonas/ujra, Mentve, nev, chat-kapcsolo, nezet-valaszto, Export. */
  function frTopHtml() {
    var it = WB.detail ? WB.detail.item : null
    var st = savedState()
    var c = WB.canvas
    var h = (c && c.history) || {}
    var busy = WB.canvasBusy
    var canvasOn = frCanvasReady() && c.current !== false
    var sizeOn = canvasOn || deckMode()
    var menuBtn = function (key, label) {
      return '<button type="button" class="wb-fr-tbtn' + (WB.frMenu === key ? ' wb-fr-tbtn-on' : '') + '" data-wb-act="fr-menu" data-wb-m="' + key + '"'
        + ' aria-expanded="' + (WB.frMenu === key) + '">' + esc(label) + (key === 'file' || key === 'size' ? ' ▾' : '') + '</button>'
    }
    var out = '<div class="wb-fr-top">'
      + '<button type="button" class="wb-fr-tbtn wb-fr-home" data-wb-act="back" title="' + escA(t('workbench.back_to_project')) + '" aria-label="' + escA(t('workbench.back_to_project')) + '">⌂</button>'
      + menuBtn('file', t('workbench.fr.file'))
      + (sizeOn ? menuBtn('size', t('workbench.fr.size')) : '')
      + (canvasOn
        ? '<button type="button" class="wb-fr-tbtn" data-wb-act="canvas-undo"' + (busy || !h.can_undo ? ' disabled' : '') + ' title="' + escA(t('workbench.canvas.undo') + ' (Ctrl+Z)') + '" aria-label="' + escA(t('workbench.canvas.undo')) + '">↶</button>'
          + '<button type="button" class="wb-fr-tbtn" data-wb-act="canvas-redo"' + (busy || !h.can_redo ? ' disabled' : '') + ' title="' + escA(t('workbench.canvas.redo') + ' (Ctrl+Y)') + '" aria-label="' + escA(t('workbench.canvas.redo')) + '">↷</button>'
        : '')
      + '<span class="wb-sh-saved wb-sh-saved-' + st + '" role="status">' + esc(t('workbench.sh.saved.' + st)) + '</span>'
      + '<span class="wb-fr-name">' + (it ? workSeqHtml(it) + esc(it.title) : '') + '</span>'
      + '<button type="button" class="wb-fr-tbtn' + (WB.frChat ? ' wb-fr-tbtn-on' : '') + '" data-wb-act="fr-chat" aria-pressed="' + !!WB.frChat + '" title="' + escA(t('workbench.fr.chat_toggle')) + '">💬 ' + esc(t('workbench.fr.chat')) + '</button>'
      + (sizeOn ? '<button type="button" class="wb-fr-tbtn' + (WB.frLive ? ' wb-fr-tbtn-on' : '') + '" data-wb-act="fr-live" aria-pressed="' + !!WB.frLive + '" title="' + escA(t('workbench.fr.live_title')) + '">&#128065; ' + esc(t(WB.frLive ? 'workbench.fr.live_on' : 'workbench.fr.live_off')) + '</button>' : '')
      + viewSwitchHtml()
      + '<button type="button" class="wb-fr-export" data-wb-act="' + (exportIsOpen() ? 'export-close' : 'export-open') + '" aria-expanded="' + exportIsOpen() + '">' + esc(t('workbench.exp.open')) + '</button>'
      + '<button type="button" class="wb-fr-tbtn wb-sh-more" data-wb-act="sh-more" aria-expanded="' + !!WB.shMore + '" aria-label="' + escA(t('workbench.sh.more')) + '" title="' + escA(t('workbench.sh.more')) + '">&#8942;</button>'
      + '</div>'
    return out + frMenuHtml() + (exportIsOpen() ? '<div class="wb-fr-pop wb-fr-pop-export">' + frDeckExportHtml() + exportPanelHtml() + '</div>' : '')
  }

  /** A megnyitott menu (Fajl / Meretezes): a fejlec alatt lenyilo doboz. */
  function frMenuHtml() {
    if (!WB.frMenu) return ''
    var it = WB.detail ? WB.detail.item : null
    if (WB.frMenu === 'size') {
      if (deckMode()) {
        var sz = ((WB.deck.limits && WB.deck.limits.sizes) || ['16:9', '4:3']).map(function (a) {
          return '<button type="button" class="wb-fr-mi' + (WB.deck.deck.size === a ? ' wb-fr-mi-on' : '') + '" data-wb-act="deck-size" data-wb-v="' + escA(a) + '"' + (WB.canvasBusy || archived() ? ' disabled' : '') + '>' + esc(deckSizeLabel(a)) + '</button>'
        }).join('')
        return '<div class="wb-fr-pop wb-fr-menu">' + sz + '</div>'
      }
      return '<div class="wb-fr-pop">' + canvasPlatformHtml() + '</div>'
    }
    var row = function (act, label, extra) {
      return '<button type="button" class="wb-fr-mi" data-wb-act="' + act + '"' + (extra || '') + '>' + esc(label) + '</button>'
    }
    return '<div class="wb-fr-pop wb-fr-menu">'
      + (archived() ? '' : row('sh-new', t('workbench.sh.new')))
      + (frCanvasReady() && !archived() ? row('canvas-version', t('workbench.canvas.version_save')) : '')
      + (frCanvasReady() && it ? '<a class="wb-fr-mi" href="' + escA(canvasSvgUrl(it.id, true)) + '" target="_blank" rel="noopener">' + esc(t('workbench.canvas.download')) + '</a>' : '')
      + row('sh-more', t('workbench.fr.history'))
      + '</div>'
  }

  /** Bal oldali keskeny, feliratos ikonsav. */
  function frRailHtml() {
    return '<nav class="wb-fr-rail" aria-label="' + escA(t('workbench.fr.rail')) + '">' + frTabs().map(function (x) {
      var on = frTabNow() === x[0]
      return '<button type="button" class="wb-fr-rb' + (on ? ' wb-fr-rb-on' : '') + '" data-wb-act="fr-tab" data-wb-tab="' + x[0] + '" aria-pressed="' + on + '">'
        + '<span class="wb-fr-ri" aria-hidden="true">' + x[1] + '</span><span class="wb-fr-rl">' + esc(t('workbench.fr.tab.' + x[0])) + '</span></button>'
    }).join('') + '</nav>'
  }

  /** A kepek, amik a lapra tehetok: ennek a munkadarabnak a kep-reszei (a projekt mappajaban vannak). */
  function frImageThumbs() {
    var imgs = canvasImageChoices()
    if (!imgs.length) return '<p class="wb-hint">' + esc(t('workbench.fr.uploads_none')) + '</p>'
    return '<div class="wb-fr-thumbs">' + imgs.map(function (p) {
      return '<div class="wb-fr-thumbwrap"><button type="button" class="wb-fr-thumb" draggable="true" data-wb-act="fr-add-image" data-wb-src="' + escA(p.asset_path) + '" title="' + escA(p.asset_path) + '">'
        + '<img alt="" src="' + escA(partImageSrc(p)) + '" loading="lazy"></button>'
        + (archived() ? '' : '<button type="button" class="wb-fr-thumb-del" data-wb-act="part-remove" data-wb-part="' + escA(p.id) + '" title="' + escA(t('workbench.fr.thumb_remove')) + '" aria-label="' + escA(t('workbench.fr.thumb_remove')) + '">&times;</button>')
        + '</div>'
    }).join('') + '</div>'
  }

  function frPanelBodyHtml() {
    var can = frCanvasReady()
    var needCanvas = '<p class="wb-hint">' + esc(t(WB.preview && WB.preview.kind === 'text' ? 'workbench.fr.need_canvas_text' : 'workbench.fr.need_canvas')) + '</p>'
    var add = function (act, label, arg) {
      return '<button type="button" class="wb-fr-pbtn" data-wb-act="' + act + '"' + (arg ? ' data-wb-arg="' + escA(arg) + '"' : '') + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(label) + '</button>'
    }
    switch (frTabNow()) {
      case 'templates':
        if (deckMode() && !archived()) {
          return ['title', 'content', 'blank'].map(function (l) {
            return '<button type="button" class="wb-fr-pbtn" data-wb-act="fr-deck-layout" data-wb-arg="' + l + '"' + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.deck.layout_' + l)) + '</button>'
          }).join('') + '<p class="wb-hint">' + esc(t('workbench.fr.layout_hint')) + '</p>'
        }
        return templatesHtml()
      case 'elements':
        return can
          ? '<div class="wb-fr-pgrid">' + add('canvas-add-rect', t('workbench.fr.el.rect')) + add('canvas-add-ellipse', t('workbench.fr.el.circle'))
            + add('canvas-add-line', t('workbench.fr.el.line')) + add('canvas-add-button', t('workbench.fr.el.button')) + '</div>'
            + '<p class="wb-hint">' + esc(t('workbench.fr.el.hint')) + '</p>'
          : needCanvas
      case 'text':
        return can
          ? add('fr-add-text', t('workbench.fr.text.box'), 'body')
            + add('fr-add-text', t('workbench.fr.text.title'), 'title') + add('fr-add-text', t('workbench.fr.text.sub'), 'sub')
            + '<p class="wb-hint">' + esc(t('workbench.fr.text.hint')) + '</p>'
          : needCanvas
      case 'brand':
        return '<button type="button" class="wb-fr-pbtn" data-wb-act="brand-open">' + esc(WB.brandOpen ? t('workbench.fr.brand.hide') : t('workbench.fr.brand.show')) + '</button>' + brandPanelHtml()
      case 'uploads':
        return '<label class="wb-fr-upload"><input type="file" accept="image/*" id="wbFrUpload" hidden>' + esc(t('workbench.fr.upload')) + '</label>'
          + '<p class="wb-hint">' + esc(t('workbench.fr.upload_hint')) + '</p>' + (can ? frImageThumbs() : needCanvas)
      case 'tools':
        if (frIsVideo(WB.detail && WB.detail.item)) return videoTimelineHtml()
        return '<p class="wb-can-snapopts"><label><input type="checkbox" data-wb-act="canvas-snap"' + (WB.canvasSnap ? ' checked' : '') + '> ' + esc(t('workbench.canvas.snap_guides')) + '</label>'
          + '<label><input type="checkbox" data-wb-act="canvas-grid"' + (WB.canvasGrid ? ' checked' : '') + '> ' + esc(t('workbench.canvas.snap_grid', { n: CANVAS_GRID })) + '</label></p>'
          + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_hint')) + '</p><p class="wb-hint">' + esc(t('workbench.canvas.drop_hint')) + '</p>'
          + canvasOrphansHtml()
          + (deckMode() && deckCurrentSlide() && !archived()
            ? '<h4 class="wb-fr-sub">' + esc(t('workbench.deck.notes')) + '</h4><textarea class="wb-input" id="wbDeckNotes" rows="4" placeholder="' + escA(t('workbench.deck.notes_placeholder')) + '">' + esc(deckCurrentSlide().notes || '') + '</textarea>'
              + '<p>' + deckBtn('deck-notes', t('workbench.deck.notes_save')) + '</p>' : '')
      case 'projects':
        return (archived() ? '' : '<button type="button" class="wb-fr-pbtn" data-wb-act="sh-new">' + esc(t('workbench.fr.new')) + '</button>') + itemsPanelHtml()
      default: return ''
    }
  }

  function frPanelHtml() {
    if (!WB.frTab) return ''
    return '<aside class="wb-fr-panel"><h3 class="wb-fr-ptitle">' + esc(t('workbench.fr.tab.' + frTabNow())) + '</h3>' + frPanelBodyHtml() + '</aside>'
  }

  /** A dia-/kartya-export gombjai (PPTX, PDF) -- az Export-doboz tetejen, a deck-nek. */
  function frDeckExportHtml() {
    if (!deckMode()) return ''
    var ex = WB.deckExported
    return '<div class="wb-fr-exp"><p>' + deckBtn('deck-export', WB.deckExporting === 'pdf' ? t('workbench.deck.exporting') : t('workbench.deck.export_pdf'), '', ' data-wb-v="pdf"')
      + deckBtn('deck-export', WB.deckExporting === 'pptx' ? t('workbench.deck.exporting') : t('workbench.deck.export_pptx'), '', ' data-wb-v="pptx"') + '</p>'
      + (deckIsCard() ? '<p class="wb-hint">' + esc(t('workbench.card.export_hint')) + '</p>' : '<p class="wb-hint">' + esc(t('workbench.deck.export_hint')) + '</p>')
      + (ex ? '<p class="wb-muted">' + esc(t('workbench.deck.exported_file', { name: ex.name })) + ' <a href="' + escA(ex.url) + '" target="_blank" rel="noopener">' + esc(t('workbench.preview.open_new_tab')) + '</a></p>'
        + (ex.warnings.length ? '<ul class="wb-hint">' + ex.warnings.map(function (w) { return '<li>' + esc(w) + '</li>' }).join('') + '</ul>' : '') : '')
      + '</div>'
  }

  /** Egy oldal kicsi negyzete az oldal-savban (Canva-minta): a kijelolt kiemelve, rajta apro muveletek. */
  function frStripHtml() {
    var list = deckSlides()
    var cur = deckCurrentSlide()
    var cells = list.map(function (s, i) {
      var on = cur && s.id === cur.id
      var act = function (a, label, title, dis) {
        return '<button type="button" class="wb-fr-ca" data-wb-act="' + a + '" data-wb-id="' + escA(s.id) + '" title="' + escA(title) + '" aria-label="' + escA(title) + '"'
          + (dis || WB.canvasBusy ? ' disabled' : '') + '>' + label + '</button>'
      }
      return '<div class="wb-fr-cell' + (on ? ' wb-fr-cell-on' : '') + '">'
        + '<button type="button" class="wb-fr-cellpick" data-wb-act="deck-pick" data-wb-id="' + escA(s.id) + '" aria-label="' + escA(deckPageLabel(i)) + '"' + (on ? ' aria-current="true"' : '') + '>'
        + '<img loading="lazy" alt="" src="' + escA(deckSlideUrl(s.id)) + '"><span class="wb-fr-cellno">' + esc(deckPageLabel(i)) + '</span></button>'
        + (on && !archived()
          ? '<span class="wb-fr-cellact">' + act('deck-up', '◀', t('workbench.fr.page_left'), i === 0) + act('deck-down', '▶', t('workbench.fr.page_right'), i === list.length - 1)
            + act('deck-dup', '⧉', t('workbench.deck.duplicate')) + act('deck-del', '🗑', t('workbench.deck.remove')) + '</span>'
          : '')
        + '</div>'
    }).join('')
    var add = archived() ? '' : '<button type="button" class="wb-fr-addcell" data-wb-act="deck-add-blank" title="' + escA(t('workbench.fr.add_page')) + '" aria-label="' + escA(t('workbench.fr.add_page')) + '"' + (WB.canvasBusy ? ' disabled' : '') + '>+</button>'
    return '<div class="wb-fr-strip">' + cells + add + '</div>'
  }

  /** A deck oldala (a kozepso fix terulet): csak a kijelolt oldal. */
  function frDeckPageHtml() {
    if (WB.deckError && !WB.deck) {
      return '<p class="wb-preview-bad">' + esc(WB.deckError.message || '') + '</p>' + deckBtn('deck-refresh', t('workbench.canvas.refresh'))
    }
    if (!WB.deck || !WB.deck.deck) return '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    if (!deckSlides().length) {
      return '<div class="wb-empty"><p class="wb-empty-title">' + esc(t('workbench.deck.none_title')) + '</p><p>'
        + (archived() ? '' : '<button type="button" class="wb-fr-addpage" data-wb-act="deck-add-blank">+ ' + esc(t('workbench.fr.add_page')) + '</button>') + '</p></div>'
    }
    return canvasStageHtml(t('workbench.deck.slide_n', { n: deckSlides().indexOf(deckCurrentSlide()) + 1 }), true, true)
  }

  // ---- VIDEO A KOZEPSO ABLAKBAN (#462, 6. lepes (a)) --------------------------------------------------
  //
  // Felul a lejatszo (a kijelolt klip), alul az IDOSAV: a klipek aranyos blokkok. Kattintas = kijeloles,
  // a blokk huzasa = sorrend (moveClip), a szelek huzasa = vagas (trimClip), a lejatszofejnel "Szetvagas"
  // (splitClip). MINDEN ugyanazokat a `vtOps` muveleteket kuldi, amiket az ugynok is: egy allapot.

  function frIsVideo(it) { return !!it && it.type === 'video' }

  /** A table work item: the preview file is a spreadsheet (xlsx/csv/tsv). */
  function frIsTable(it) {
    var p = WB.preview
    if (!it || it.type === 'video' || isDeckItem()) return false
    if (it.source_path) return isTableName(it.source_path)
    return !!p && p.available !== false && isTableName(p.name)
  }

  /** Simple view: open the grid by itself, and reopen it when a newer version
   *  arrives (the agent edited the table) while the hand has no unsaved edits. */
  function frTableEnsure(it) {
    var tb = WB.table
    var p = WB.preview
    var want = !tb || tb.itemId !== it.id
    if (!want && tb && !tb.loading && !tb.busy && !tb.dirty && tb.data && p && p.version_id && tb.data.version_id && tb.data.version_id !== p.version_id) want = true
    if (!want) return
    var key = it.id + ':' + (p && p.version_id || '')
    if (WB.frTblKey === key) return
    WB.frTblKey = key
    setTimeout(function () { if (WB.selectedId === it.id) openTable(it.id, null) }, 0)
  }

  function frVtSelClip() {
    var doc = vtDoc()
    var clips = (doc && doc.clips) || []
    for (var i = 0; i < clips.length; i += 1) if (clips[i].id === WB.vtSel) return clips[i]
    return clips[0] || null
  }

  function frVtSrcUrl(c) {
    return '/api/life/file?rel=' + encodeURIComponent(c.src) + '&lang=' + encodeURIComponent(window._lang || 'hu')
      + '#t=' + c.start + ',' + c.end
  }

  function frVtAddRowHtml() {
    var busy = WB.vtBusy || WB.vtRender || archived()
    return '<select id="wbFrVtSrc" class="wb-input" aria-label="' + escA(t('workbench.vt.pick_file')) + '">' + vtMediaOptions('video') + '</select> '
      + '<button type="button" class="wb-fr-pbtn wb-fr-vt-add" data-wb-act="fr-vt-add"' + (busy ? ' disabled' : '') + '>+ ' + esc(t('workbench.vt.add_clip')) + '</button>'
  }

  /** The fixed middle window of a video: the player of the picked clip (or the empty start). */
  function frVideoPageHtml() {
    if (WB.vtError && !WB.vt) {
      return '<div class="wb-fr-vid-empty"><p class="wb-preview-bad">' + esc(WB.vtError.message || '') + '</p>'
        + (WB.vtError.detail ? '<p class="wb-hint">' + esc(WB.vtError.detail) + '</p>' : '')
        + '<p>' + vtBtn('vt-refresh', t('workbench.canvas.refresh')) + '</p></div>'
    }
    if (!vtDoc()) return '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    var c = frVtSelClip()
    if (!c) {
      return '<div class="wb-fr-vid-empty"><p class="wb-empty-title">' + esc(t('workbench.fr.vid.empty_title')) + '</p>'
        + '<p class="wb-hint">' + esc(t('workbench.fr.vid.empty_hint')) + '</p>'
        + (archived() ? '' : '<p>' + frVtAddRowHtml() + '</p>') + '</div>'
    }
    return '<video class="wb-fr-video" id="wbVideo" src="' + escA(frVtSrcUrl(c)) + '" controls preload="metadata" playsinline></video>'
  }

  /** The timeline under the player: toolbar + proportional clip blocks. */
  function frVideoStripHtml() {
    var doc = vtDoc()
    if (!doc) return ''
    var clips = doc.clips || []
    var sel = frVtSelClip()
    var h = (WB.vt && WB.vt.history) || {}
    var busy = WB.vtBusy || WB.vtRender || archived()
    var total = clips.reduce(function (a, c) { return a + Math.max(0.1, c.end - c.start) }, 0) || 1
    var btn = function (act, label, title, dis, id) {
      return '<button type="button" class="wb-fr-tbtn2" data-wb-act="' + act + '"' + (id ? ' data-wb-id="' + escA(id) + '"' : '')
        + (dis || busy ? ' disabled' : '') + ' title="' + escA(title || label) + '"' + (label.length <= 2 ? ' aria-label="' + escA(title || label) + '"' : '') + '>' + label + '</button>'
    }
    var blocks = clips.map(function (c, i) {
      var dur = Math.max(0.1, c.end - c.start)
      var on = sel && sel.id === c.id
      return '<div class="wb-tl-clip' + (on ? ' wb-tl-on' : '') + '" data-wb-tl="' + escA(c.id) + '" style="width:' + (dur / total * 100).toFixed(3) + '%" title="' + escA(c.src.split('/').pop()) + '">'
        + (archived() ? '' : '<span class="wb-tl-h wb-tl-hl" data-wb-tlh="l" aria-hidden="true"></span>')
        + '<span class="wb-tl-no">' + (i + 1) + '</span><span class="wb-tl-name">' + esc(c.src.split('/').pop()) + '</span><span class="wb-tl-dur">' + esc(vtSecs(dur)) + ' s</span>'
        + (archived() ? '' : '<span class="wb-tl-h wb-tl-hr" data-wb-tlh="r" aria-hidden="true"></span>')
        + '</div>'
    }).join('')
    return '<div class="wb-fr-tl">'
      + '<div class="wb-fr-tl-bar">'
      + btn('vt-undo', '↶', t('workbench.vt.undo'), !h.can_undo) + btn('vt-redo', '↷', t('workbench.vt.redo'), !h.can_redo)
      + btn('fr-vt-split', '✂ ' + esc(t('workbench.fr.vid.split')), t('workbench.fr.vid.split_hint'), !sel)
      + btn('vt-clip-del', '🗑 ' + esc(t('workbench.vt.remove')), t('workbench.vt.remove'), !sel, sel && sel.id)
      + '<span class="wb-fr-tl-sp"></span>'
      + '<span class="wb-muted wb-fr-tl-len">' + esc(t('workbench.vt.length', { s: vtSecs((WB.vt && WB.vt.duration) || 0) })) + '</span>'
      + (archived() ? '' : frVtAddRowHtml())
      + '</div>'
      + (clips.length
        ? '<div class="wb-tl-track" id="wbTlTrack">' + blocks + '</div><p class="wb-hint wb-fr-tl-hint">' + esc(t('workbench.fr.vid.hint')) + '</p>'
        : '')
      + '</div>'
  }

  /** "Szetvagas": the playhead of the player, inside the picked clip. */
  function frVtSplitAtPlayhead() {
    var c = frVtSelClip()
    var v = document.getElementById('wbVideo')
    if (!c || !v || typeof v.currentTime !== 'number') return
    var at = Math.round(v.currentTime * 10) / 10
    if (!(at > c.start + 0.1 && at < c.end - 0.1)) { window.showToast(t('workbench.fr.vid.split_range')); return }
    vtOps([{ op: 'splitClip', id: c.id, at: at }])
  }

  function frVtAddFromStrip() {
    var el = document.getElementById('wbFrVtSrc')
    var src = el ? String(el.value) : ''
    if (!src) { window.showToast(t('workbench.vt.pick_file')); return }
    vtOps([{ op: 'addClip', src: src, start: 0 }])
  }

  /** A kozepso ablak: FIX, nincs gorgetes. A lap felul kezdodik es alul er veget (a Canva mintaja); az oldal-sav alul,
   *  kis negyzetekben; alatta a nagyitas. Dokumentum / video / jegyzet: a sajat teruleten gorgethet. */
  /** A composite (parts list) post can be brought onto a sized canvas on request (#493). Never automatic:
   *  composite is a general type, so the owner opts in per item. The parts stay as they are. */
  function postToCanvasOfferHtml(it) {
    if (!it || it.type !== 'composite' || archived() || !WB.canvas || WB.canvas.exists || WB.canvasError) return ''
    return '<section class="wb-post-tocanvas"><h3>' + esc(t('workbench.post.tocanvas_title')) + '</h3>'
      + '<p class="wb-hint">' + esc(t('workbench.post.tocanvas_hint')) + '</p>'
      + intakePlatformHtml()
      + '<p><button type="button" class="btn-primary" data-wb-act="post-to-canvas"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(WB.canvasBusy ? t('workbench.canvas.starting') : t('workbench.post.tocanvas_go')) + '</button></p></section>'
  }

  /** The canvas document for a post: the first picture on top (cover), the first text as a headline, the rest as body text. */
  function postCanvasDoc(parts, pf) {
    var W = pf.w, H = pf.h
    var texts = parts.filter(function (p) { return p.kind === 'text' && (p.text || '').trim() }).map(function (p) { return p.text.trim() })
    var img = null
    parts.forEach(function (p) { if (!img && p.kind === 'image' && p.asset_path) img = p })
    var objects = []
    var pad = Math.round(W * 0.06)
    var top = img ? Math.round(H * 0.5) : pad
    if (img) objects.push({ type: 'image', src: img.asset_path, x: 0, y: 0, width: W, height: Math.round(H * 0.5), fit: 'cover', alt: img.caption || '' })
    if (texts.length) {
      var head = Math.round(W * 0.05)
      objects.push({ type: 'text', text: texts[0], x: pad, y: top + Math.round(pad / 2), width: W - 2 * pad, height: Math.round(head * 2.6), fontSize: head, color: '#111111', bold: true, align: 'left' })
    }
    if (texts.length > 1) {
      var body = Math.round(W * 0.028)
      var y = top + Math.round(pad / 2) + Math.round(W * 0.05 * 2.8)
      objects.push({ type: 'text', text: texts.slice(1).join('\n\n'), x: pad, y: y, width: W - 2 * pad, height: Math.max(body * 2, H - y - pad), fontSize: body, color: '#333333', align: 'left' })
    }
    return { width: W, height: H, background: '#ffffff', objects: objects }
  }

  function postToCanvas() {
    if (!WB.selectedId || WB.canvasBusy || archived()) return
    var sel = document.getElementById('wbIntakePlatform')
    if (sel) WB.intakePlatform = sel.value
    var doc = postCanvasDoc(partsOf(), intakePlatformNow())
    WB.canvasBusy = true
    render()
    api('PUT', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas', {
      canvas: doc,
      base_version: (WB.detail && WB.detail.item && WB.detail.item.current_version_id) || undefined,
    }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) { WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }; render(); return }
      WB.canvasError = null
      canvasTake(r.data)
      loadPreview(WB.selectedId, null)
      render()
    })
  }

  function frCenterHtml() {
    var it = WB.detail ? WB.detail.item : null
    var page = ''
    var scrolling = ''
    var strip = ''
    var tbl = ''
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!it) scrolling = '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    else if (isDeckItem()) {
      page = frDeckPageHtml()
      if (WB.deck && WB.deck.deck && deckSlides().length) strip = frStripHtml()
      doc = doc || (WB.deck && WB.deck.deck && deckSlides().length ? deckCurrentSlide().canvas : null)
    } else if (frIsVideo(it)) {
      strip = frVideoStripHtml()
    } else if (frIsTable(it)) {
      frTableEnsure(it)
      tbl = '<div class="wb-fr-tbl">' + (WB.table && WB.table.itemId === it.id ? tableHtml() : '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>') + '</div>'
    } else if (frIsCanvasItem(it) && WB.canvas && !WB.canvasError) {
      if (WB.canvas.exists) page = canvasStageHtml(it.title, true)
      else {
        scrolling = '<div class="wb-empty"><p class="wb-empty-title">' + esc(t('workbench.canvas.none_title')) + '</p>'
          + '<p><button type="button" class="btn-primary" data-wb-act="canvas-start"' + (WB.canvasBusy || archived() ? ' disabled' : '') + '>'
          + esc(WB.canvasBusy ? t('workbench.canvas.starting') : t('workbench.canvas.start')) + '</button></p></div>'
      }
    } else scrolling = postToCanvasOfferHtml(it) + simpleResultHtml()
    var zoom = Math.min(100, Math.max(30, WB.frZoom || 100)) / 100
    var isVid = !!it && frIsVideo(it) && !isDeckItem()
    var main = tbl ? tbl : isVid ? '<div class="wb-fr-vid">' + frVideoPageHtml() + '</div>' : page
      ? '<div class="wb-fr-fixed" style="--wb-zoom:' + zoom + ';--ar:' + (doc ? (doc.width / doc.height).toFixed(4) : '1') + '"><div class="wb-fr-page">' + page + '</div></div>'
      : '<div class="wb-fr-scroll" style="--wb-zoom:' + zoom + '">' + scrolling + '</div>'
    // The zoom bar is no longer inside this column: it sits slim at the very bottom of the frame
    // (frameHtml), so the content above gets the room (Boss, TG 2252/2258).
    WB.frShowBar = !(isVid || tbl)
    return '<div class="wb-fr-center">' + main + strip + '</div>'
  }

  /** Alul: nagyitas, oldalszam. */
  function frBottomHtml() {
    return '<div class="wb-fr-bottom">'
      + '<span class="wb-fr-zoomlbl">' + esc(t('workbench.fr.zoom')) + '</span>'
      + '<input type="range" class="wb-fr-zoom" id="wbFrZoom" min="30" max="100" step="10" value="' + Math.min(100, Math.max(30, WB.frZoom || 100)) + '" aria-label="' + escA(t('workbench.fr.zoom')) + '">'
      + '<span class="wb-fr-zoomval">' + WB.frZoom + '%</span>'
      + '</div>'
  }

  function frChatHtml() {
    if (!WB.frChat) return ''
    return '<aside class="wb-fr-chat">' + chatBarHtml() + '</aside>'
  }

  function frameHtml() {
    var top = frTopHtml()
    var bodyHtml = '<div class="wb-fr-body">' + frRailHtml() + frPanelHtml() + frCenterHtml() + frChatHtml() + '</div>'
    return '<div class="wb-fr">' + top + bodyHtml + (WB.frShowBar ? frBottomHtml() : '') + '</div>'
  }

  /** Szoveg hozzaadasa a lapra: cim / alcim / torzs, a lap kozepetol fuggo meretben. */
  function frAddText(kind) {
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc || archived()) return
    var size = kind === 'title' ? Math.round(doc.width * 0.08) : kind === 'sub' ? Math.round(doc.width * 0.045) : Math.round(doc.width * 0.03)
    var label = t(kind === 'title' ? 'workbench.fr.text.title_ph' : kind === 'sub' ? 'workbench.fr.text.sub_ph' : 'workbench.fr.text.body_ph')
    var w = Math.round(doc.width * 0.8)
    var h = Math.round(size * 1.6)
    canvasOps([{ op: 'add', object: { type: 'text', text: label, x: Math.round((doc.width - w) / 2), y: Math.round(doc.height * 0.3), width: w, height: h, fontSize: size, color: '#111111', bold: kind !== 'body', align: 'center' } }])
  }

  /** Kep a lapra a panelbol (kattintas vagy huzas). */
  function frAddImage(src, clientX, clientY) {
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc || !src || archived()) return
    var layer = typeof document.querySelector === 'function' ? document.querySelector('.wb-can-layer') : null
    var rect = layer && typeof layer.getBoundingClientRect === 'function' ? layer.getBoundingClientRect() : null
    var cx = doc.width / 2, cy = doc.height / 2
    if (rect && rect.width && clientX != null) { cx = ((clientX - rect.left) / rect.width) * doc.width; cy = ((clientY - rect.top) / rect.height) * doc.height }
    var w = Math.round(doc.width * 0.4), h = Math.round(w * 0.75)
    canvasOps([{ op: 'add', object: { type: 'image', src: src, x: Math.round(Math.min(Math.max(cx - w / 2, 0), doc.width - w)), y: Math.round(Math.min(Math.max(cy - h / 2, 0), doc.height - h)), width: w, height: h, fit: 'contain' } }])
  }

  var RECENT_ICON = { social_post: '🖼', document: '📄', court_filing: '⚖', video: '🎬', presentation: '🖥' }
  var RECENT_MAX = 12

  /** "Legutobbi munkaid": a start screen under the question -- one click opens a work.
   *  Grid (tiles) or list, remembered per browser. Nothing here is new data: it is the
   *  same item list the manual view shows, newest edit first. */
  function simpleRecentHtml() {
    var items = (WB.items || []).slice().sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0) }).slice(0, RECENT_MAX)
    var mode = WB.recentMode || readRecentMode()
    function btn(m) {
      return '<button type="button" class="btn-secondary wb-sh-recent-mode' + (mode === m ? ' wb-sh-recent-on' : '') + '" data-wb-act="sh-recent-view" data-wb-mode="' + m + '"'
        + ' aria-pressed="' + (mode === m) + '" title="' + escA(t('workbench.sh.recent_' + m)) + '">' + (m === 'grid' ? '&#9638;' : '&#9776;') + '</button>'
    }
    var out = '<section class="wb-sh-recent"><div class="wb-sh-recent-head"><h3>' + esc(t('workbench.sh.recent')) + '</h3>'
      + (items.length ? '<span class="wb-sh-recent-modes">' + btn('grid') + btn('list') + '</span>' : '') + '</div>'
    if (!items.length) return out + '<p class="wb-hint">' + esc(t('workbench.sh.recent_none')) + '</p></section>'
    return out + '<ul class="wb-sh-recent-' + mode + '">' + items.map(function (it) {
      return '<li><button type="button" class="wb-sh-recent-item" data-wb-item="' + escA(it.id) + '">'
        + '<span class="wb-sh-recent-tile" aria-hidden="true">' + (RECENT_ICON[it.type] || '📁') + '</span>'
        + '<span class="wb-sh-recent-name">' + esc(it.title) + '</span>'
        + '<span class="wb-sh-recent-meta">' + esc(typeLabel(it.type)) + (it.updated_at ? ' · ' + esc(when(it.updated_at)) : '') + '</span>'
        + '</button></li>'
    }).join('') + '</ul></section>'
  }

  function simpleHtml() {
    var hasItem = !!WB.selectedId
    if (hasItem) return frameHtml() + (WB.shMore ? simpleTechHtml() : '')
    return simpleHeadHtml() + '<div class="wb-sh-main">' + simpleIntakeHtml() + simpleRecentHtml() + '</div>' + (WB.shMore ? simpleTechHtml() : '')
  }

  /** Puts the slide strip back where it was, and only moves it when the open slide would be
   *  out of view (then it is centered): clicking a slide must not throw the strip to the start. */
  function restoreStripScroll(left) {
    var strip = typeof document.querySelector === 'function' ? document.querySelector('.wb-fr-strip') : null
    if (!strip) return
    if (left !== null) strip.scrollLeft = left
    var on = strip.querySelector('.wb-fr-cell-on')
    if (!on) return
    var from = on.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft
    if (from < strip.scrollLeft || from + on.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = Math.max(0, from - (strip.clientWidth - on.offsetWidth) / 2)
    }
  }

  /** The Simple-view frame reaches the very bottom of the window, like the left menu (Boss, TG 7444):
   *  its height is what is left of the viewport below its top edge. When a work item is opened the
   *  page is scrolled once so the frame's top sits at the top of the window. Phones keep the flow layout. */
  function fitFrame() {
    if (typeof document.querySelector !== 'function') return
    var body = document.querySelector('.wb-fr-body')
    if (!body || typeof body.getBoundingClientRect !== 'function' || !window.innerHeight) return
    if (window.innerWidth <= 900) { body.style.height = ''; return }
    var fr = body.parentNode
    // Independent of the scroll position (it was not, and the frame shrank while the owner scrolled,
    // leaving a blank page below it): the body is the window height minus the frame's own header.
    function setHeight() {
      var hdr = fr && typeof fr.getBoundingClientRect === 'function' ? body.getBoundingClientRect().top - fr.getBoundingClientRect().top : 0
      var bar = body.nextElementSibling && body.nextElementSibling.classList && body.nextElementSibling.classList.contains('wb-fr-bottom') ? body.nextElementSibling.offsetHeight : 0
      // The frame starts below the dashboard's own header, so the room is the window minus where the frame
      // begins on the page (page scroll position removed): the frame then ends exactly at the window bottom
      // and the page itself has nothing to scroll (Boss, TG 2261).
      var scrollHost = fr && typeof fr.closest === 'function' ? fr.closest('main.projects-active') : null
      var frTop = fr && typeof fr.getBoundingClientRect === 'function' ? fr.getBoundingClientRect().top + (window.pageYOffset || 0) + (scrollHost ? scrollHost.scrollTop || 0 : 0) : 0
      // What the page keeps free below the frame (the main area's bottom padding) counts too.
      var below = 0
      for (var a = fr && fr.parentElement; a && a !== document.documentElement && typeof window.getComputedStyle === 'function'; a = a.parentElement) {
        var cs = window.getComputedStyle(a)
        below += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.marginBottom) || 0)
      }
      body.style.height = Math.max(420, Math.floor(window.innerHeight - Math.max(frTop, 0) - Math.max(hdr, 0) - bar - below - 4)) + 'px'
    }
    setHeight()
    // Once per opened work: back to the top of the page (the frame fits the window, nothing to scroll).
    if (WB.fitKey !== WB.selectedId) {
      WB.fitKey = WB.selectedId
      try { window.scrollTo(0, 0) } catch (_e) { /* old browser: harmless */ }
      var host = fr && typeof fr.closest === 'function' ? fr.closest('main.projects-active') : null
      if (host) host.scrollTop = 0
    }
    fitMdSplit()
  }
  /** The markdown split (editor + live preview) fills the frame down to the window bottom: both
   *  boxes are exactly as tall as what is left, so the page itself never scrolls, only the boxes do
   *  (Boss, TG 2239). Whatever follows the split (save buttons, hint) keeps its own room. */
  function fitMdSplit() {
    if (typeof document.querySelector !== 'function') return
    var split = document.querySelector('.wb-md-split')
    var body = document.querySelector('.wb-fr-body')
    if (!split || !body || window.innerWidth <= 900) { if (split) split.style.height = ''; return }
    // #482: reset the editor scroller to the top ONLY on a real item switch, not on every
    // same-item re-render. Otherwise this ran after genericScrollRestore had already put the
    // scroller back, and threw it to the top again on each redraw (chat stream, save, tick).
    var scroller = split.closest ? split.closest('.wb-fr-scroll') : null
    if (scroller && WB.mdFitKey !== WB.selectedId) { WB.mdFitKey = WB.selectedId; scroller.scrollTop = 0 }
    var after = 0
    for (var n = split.nextElementSibling; n; n = n.nextElementSibling) after += n.offsetHeight + 12
    var room = Math.min(body.getBoundingClientRect().bottom, window.innerHeight - 4) - split.getBoundingClientRect().top - after - 16
    split.style.height = Math.max(240, Math.floor(room)) + 'px'
  }

  if (typeof window.addEventListener === 'function') window.addEventListener('resize', function () { if (WB.open) fitFrame() })

  /** The page's scroll position across a full re-render (Boss, TG 7451: pressing "Vegleges torles"
   *  threw the scrollbar to the top). Replacing the whole root briefly collapses the page, and the
   *  browser clamps every scroll position above it; so the root keeps its height until the new
   *  content is in, and every scrolled ancestor (and the window) is put back. */
  function pageScrollSnapshot(el) {
    var keep = { h: el && el.offsetHeight ? el.offsetHeight : 0, tops: [], wy: typeof window.scrollY === 'number' ? window.scrollY : 0 }
    for (var n = el && el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
      if (n.scrollTop > 0) keep.tops.push([n, n.scrollTop])
    }
    if (keep.h && el.style) el.style.minHeight = keep.h + 'px'
    return keep
  }
  function restorePageScroll(el, keep) {
    if (!keep) return
    keep.tops.forEach(function (e) { e[0].scrollTop = e[1] })
    if (keep.wy && typeof window.scrollTo === 'function') window.scrollTo(window.scrollX || 0, keep.wy)
    if (el && el.style) el.style.minHeight = ''
  }

  /** #482: EVERY scrollable box inside the frame keeps its place across a re-render, not only the
   *  slide strip and the chat. Clicking a slide in the deck strip or ticking a picture in the file
   *  list rebuilds the whole root (innerHTML), and the browser puts the new boxes back at 0; so the
   *  horizontal AND vertical offset of each scrolled box is captured first and restored after. The
   *  box is found again by a structural key (id, else tag + classes + position among like siblings),
   *  because the re-render is deterministic and rebuilds the same tree. The box-specific handlers
   *  (restoreStripScroll centres the open slide, fitFrame/fitMdSplit reset once per opened item) run
   *  AFTER this and still win for their own boxes. A class name that is an SVGAnimatedString, a box
   *  that no longer scrolls, or a key that does not match any new box is simply skipped -- safe. */
  function scrollKeyOf(node, root) {
    var parts = []
    for (var n = node; n && n !== root && n.nodeType === 1; n = n.parentNode) {
      if (n.id) { parts.unshift('#' + n.id); break }
      var cls = typeof n.className === 'string' ? n.className : (n.className && typeof n.className.baseVal === 'string' ? n.className.baseVal : '')
      var idx = 0
      var p = n.parentNode
      if (p && p.children) {
        for (var i = 0; i < p.children.length; i++) {
          var sib = p.children[i]
          if (sib === n) break
          if (sib.tagName === n.tagName && (typeof sib.className === 'string' ? sib.className : (sib.className && sib.className.baseVal) || '') === cls) idx++
        }
      }
      parts.unshift(n.tagName + '.' + cls.replace(/\s+/g, ' ').trim() + '[' + idx + ']')
    }
    return parts.join('>')
  }
  function canScroll(n) {
    return (n.scrollHeight - n.clientHeight > 1) || (n.scrollWidth - n.clientWidth > 1)
  }
  function genericScrollSnapshot(root) {
    var out = []
    if (!root || typeof root.querySelectorAll !== 'function') return out
    var all = root.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var n = all[i]
      if ((n.scrollTop > 0 || n.scrollLeft > 0) && canScroll(n)) {
        out.push({ key: scrollKeyOf(n, root), top: n.scrollTop, left: n.scrollLeft })
      }
    }
    return out
  }
  function genericScrollRestore(root, snaps) {
    if (!root || !snaps || !snaps.length || typeof root.querySelectorAll !== 'function') return
    var all = root.querySelectorAll('*')
    var map = {}
    for (var i = 0; i < all.length; i++) {
      if (!canScroll(all[i])) continue
      var k = scrollKeyOf(all[i], root)
      if (!(k in map)) map[k] = all[i]
    }
    for (var j = 0; j < snaps.length; j++) {
      var box = map[snaps[j].key]
      if (!box) continue
      if (snaps[j].top) box.scrollTop = snaps[j].top
      if (snaps[j].left) box.scrollLeft = snaps[j].left
    }
  }

  function render() {
    var el = root()
    if (!el || !WB.open) return
    // A tablazat egy cellajaban all a kurzor: az ujrarajzolas utan ugyanoda
    // tesszuk vissza (a chat streamelese kozben is lehessen gepelni).
    var active = document.activeElement
    var keepCell = active && /^wb(Cell_|Img|TextEdit$|PartText$|PartNewText$|ChatInput$|BrandName\d+$|BrandNotes$|BrandMinW$)/.test(String(active.id || '')) ? active.id : null
    var caret = keepCell && typeof active.selectionStart === 'number' ? active.selectionStart : null
    // Az uj szoveges resz mezojet semmi mas nem tarolja: az ujrarajzolas (pl.
    // mentes kozben, diktalas indulasakor) kulonben kitorolne a begepelt szoveget.
    var newPart = document.getElementById('wbPartNewText')
    // Csak amig a mezo nyitva van: mentes/megse utan a regi elem meg a DOM-ban
    // all, es a kiuritett piszkozatot kulonben visszairnank.
    if (WB.partNewOpen && newPart && typeof newPart.value === 'string') WB.partNewDraft = newPart.value
    // A video lejatszasi helye: az ujrarajzolas uj <video> elemet tesz a
    // helyere, es kulonben a nulladik masodpercre ugrana (pl. "Eleje innen" utan).
    var oldVid = document.getElementById('wbVideo')
    var vidKeep = oldVid && typeof oldVid.currentTime === 'number' && oldVid.currentTime > 0 && oldVid.getAttribute
      ? { src: oldVid.getAttribute('src'), at: oldVid.currentTime } : null
    var chatScroll = chatScrollSnapshot()
    var dpSnap = dpFocusSnapshot()
    // A diasor-sav gorgetese: az ujrarajzolas uj elemet tesz a helyere, es a sav az elejere
    // ugrana -- a 8-9-10. dia utan a 11.-re kattintva (Boss, TG 7426) nem szabad elvesznie a helynek.
    var oldStrip = typeof document.querySelector === 'function' ? document.querySelector('.wb-fr-strip') : null
    var stripLeft = oldStrip ? oldStrip.scrollLeft : null
    // #482: minden gorgetheto doboz (diasor-szerkeszto csikja, fajllista, panelek) helyben marad.
    var genScroll = genericScrollSnapshot(el)
    var pageKeep = pageScrollSnapshot(el)
    WB.rendering = true
    if (isSimple()) {
      el.innerHTML = '<div class="wb-root wb-root-simple">' + simpleHtml() + '</div>'
    } else el.innerHTML = '<div class="wb-root">'
      + '<div class="wb-head wb-head-oneline wb-fit-0">'
      + '<button type="button" class="prj-back-link" data-wb-act="back">' + esc(t('workbench.back_to_project')) + '</button>'
      + '<h1>' + esc(t('workbench.title', { project: WB.project ? WB.project.name : '' })) + '</h1>'
      + viewSwitchHtml()
      + '<button type="button" class="btn-secondary" data-wb-act="layout-toggle" aria-pressed="' + (WB.layout === 'split') + '"'
      + ' title="' + escA(t('workbench.layout.hint')) + '">'
      + esc(t(WB.layout === 'split' ? 'workbench.layout.to_classic' : 'workbench.layout.to_split')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="search-open" aria-pressed="' + !!WB.searchOpen + '">' + esc(t('workbench.search.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="wk-open" aria-pressed="' + !!WB.wkOpen + '">' + esc(t('workbench.wk.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-open" aria-pressed="' + !!WB.tlOpen + '">' + esc(t('workbench.tl.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="dec-open" aria-pressed="' + !!WB.decOpen + '">' + esc(t('workbench.dec.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="brand-open" aria-pressed="' + !!WB.brandOpen + '">' + esc(t('workbench.brand.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-open" aria-pressed="' + !!WB.tdOpen + '">' + esc(t('workbench.td.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="ho-open" aria-pressed="' + !!WB.hoOpen + '">' + esc(t('workbench.ho.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-open" aria-pressed="' + !!WB.capsOpen + '">' + esc(t('workbench.caps.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
      + capsPanelHtml()
      + searchPanelHtml()
      + timelinePanelHtml()
      + weeklyPanelHtml()
      + decisionsPanelHtml()
      + brandPanelHtml()
      + todosPanelHtml()
      + handoffPanelHtml()
      + overviewHtml()
      + panelTabsHtml()
      + layoutHtml()
      + '</div>'
    // A teljes ujrarajzolas (megnyitas, tetel-valtas) uj chat-naplot tesz be,
    // ami kulonben a tetejen allna; ha a tulajdonos felfele gorgetett, ott marad.
    genericScrollRestore(el, genScroll)
    restorePageScroll(el, pageKeep)
    restoreChatScroll(chatScroll)
    restoreStripScroll(stripLeft)
    fitFrame()
    fitHead()
    // Az elso rajzolaskor a kontener meg nem biztos, hogy kapott szelesseget: kesobb ujra.
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(fitHead)
    setTimeout(fitHead, 400)
    setTimeout(fitHead, 1500)
    observeHeadWidth()
    if (WB.formOpen && !WB.intakeFocused) {
      // Egyszer, a megnyitaskor: a kesobbi ujrarajzolas nem rantja el a fokuszt.
      WB.intakeFocused = true
      var input = document.getElementById('wbIntakeText')
      if (input && typeof input.focus === 'function') input.focus()
    }
    // A PDF-nezegeto csomopontja tulelte az ujrarajzolast: visszatesszuk a
    // helyere (vagy uj dokumentumnal elinditjuk a betoltest).
    pdfMount()
    // A dokumentum-szerkeszto (#444) is tartos csomopont: vissza a helyere.
    docEditMount()
    pdfEditMount()
    if (vidKeep) videoRestore(vidKeep)
    WB.rendering = false
    dpFocusRestore(dpSnap)
    if (keepCell) {
      var cell = document.getElementById(keepCell)
      if (cell && typeof cell.focus === 'function') {
        cell.focus()
        if (caret != null && typeof cell.setSelectionRange === 'function') { try { cell.setSelectionRange(caret, caret) } catch (_e) { /* nem baj */ } }
      }
    }
  }

  // ---- muveletek ------------------------------------------------------------

  function create() {
    var titleEl = document.getElementById('wbNewTitle')
    var typeEl = document.getElementById('wbNewType')
    if (!titleEl || !typeEl || WB.busy) return
    var title = titleEl.value.trim()
    var type = typeEl.value
    var folderEl = document.getElementById('wbNewFolder')
    var payload = { project_id: WB.projectId, title: title, type: type }
    if (folderEl && folderEl.value) payload.folder = folderEl.value
    var newFolderEl = document.getElementById('wbNewFolderName')
    if (newFolderEl && String(newFolderEl.value || '').trim()) payload.new_folder = String(newFolderEl.value).trim()
    WB.busy = true
    render()
    api('POST', '/api/workbench/items', payload).then(function (r) {
      WB.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      WB.selectedId = r.data.item.id
      WB.detail = { item: r.data.item, versions: r.data.versions, project: WB.project }
      window.showToast(t('workbench.new.created', { title: r.data.item.title }) + (r.data.folder_existed ? ' ' + t('workbench.new.folder_existed') : ''))
      load(WB.projectId)
    })
  }

  // ---- reszek: muveletek ----------------------------------------------------

  /** A valasz minden resz-muveletnel a TELJES, friss reszlistat hozza -- igy a
   *  felulet nem a sajat feltetelezeseibol epiti ujra a sorrendet. */
  function applyParts(data) {
    if (!WB.detail || !data) return
    if (data.parts) WB.detail.parts = data.parts
    // Uj verzio keletkezett: a lista es a munkadarab is a friss, es az
    // elonezet a legujabbat mutatja (nem egy korabban kivalasztott regit).
    if (data.versions) WB.detail.versions = data.versions
    if (data.item) WB.detail.item = data.item
    if (data.version) WB.previewVersion = null
    WB.partBusy = false
    render()
    // A reszek a munkadarab TARTALMA: valtozasuk utan az elonezet sem a regi.
    if (WB.selectedId) loadPreview(WB.selectedId, WB.previewVersion)
  }

  // --- VERZIOZAS (5. fazis) ------------------------------------------------
  // "Az eredeti automatikusan nem irhato felul": a mentes UJ verziot ir, a
  // visszaallitas pedig a regi allapotbol csinal UJ verziot -- torles nincs.
  function versionsUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/versions' + (tail || '')
  }

  function applyVersions(data) {
    if (!WB.detail || !data) return
    // Uj verzio lett: a regi osszehasonlitas mar nem a mostanirol szol.
    WB.compare = null
    if (data.versions) WB.detail.versions = data.versions
    if (data.item) WB.detail.item = data.item
    if (data.parts) WB.detail.parts = data.parts
    WB.versionBusy = false
    // A mutatott verzio a friss lett: a valaszto ne egy regire alljon.
    WB.previewVersion = null
    render()
    if (WB.selectedId) loadPreview(WB.selectedId, null)
    load(WB.projectId)
  }

  function newVersion() {
    if (!WB.selectedId || WB.versionBusy || archived()) return
    WB.versionBusy = true
    render()
    api('POST', versionsUrl(), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      applyVersions(r.data)
      window.showToast(t('workbench.versions.saved', { n: r.data && r.data.version ? r.data.version.version_no : '' }))
    })
  }

  /** Verzio VEGLEGES torlese (#443). Regi verzional a tobbi verzio es az
   *  elonezet valtozatlan marad, kiveve ha eppen a torolt verziot nezted --
   *  akkor a jelenlegire all vissza. A JELENLEGI torlesekor a szerver az
   *  alatta levore allitja at a munkadarabot (`loaded`), es a felulet azt
   *  tolti be ugyanugy, mint egy visszaallitas utan. */
  function deleteVersion(versionId) {
    if (!versionId || !WB.selectedId || WB.versionBusy || archived()) return
    var id = WB.selectedId
    // Az utolso verzio: a munkadarab a Lomtarba kerul, de csak a piros
    // keret megerositese utan ("1A").
    if (WB.detail && (WB.detail.versions || []).length === 1) { WB.warn = { kind: 'last-version' }; render(); return }
    WB.versionBusy = true
    render()
    api('DELETE', versionsUrl('/' + encodeURIComponent(versionId))).then(function (r) {
      WB.versionBusy = false
      if (WB.selectedId !== id || !WB.detail) return
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (r.data && r.data.loaded) {
        applyVersions(r.data)
        window.showToast(t('workbench.versions.deleted_loaded', { n: r.data.loaded.version_no }))
        return
      }
      if (r.data && r.data.versions) WB.detail.versions = r.data.versions
      if (r.data && r.data.item) WB.detail.item = r.data.item
      if (WB.compare) WB.compare = null
      var wasShown = WB.previewVersion === versionId
      if (wasShown) WB.previewVersion = null
      window.showToast(t('workbench.versions.deleted'))
      render()
      if (wasShown) loadPreview(id, null)
    })
  }

  function restoreVersion(versionId) {
    if (!versionId || !WB.selectedId || WB.versionBusy || archived()) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.versions.restore_confirm'))) return
    WB.versionBusy = true
    render()
    api('POST', versionsUrl('/' + encodeURIComponent(versionId) + '/restore'), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      applyVersions(r.data)
      window.showToast(t('workbench.versions.restored', { n: r.data && r.data.version ? r.data.version.version_no : '' }))
    })
  }

  /** MINDEN MENTES UJ VERZIO (#406, 4. pont): a `new_version=1` miatt a
   *  szerver elobb uj verziot nyit, es a valtoztatas abba kerul -- a regi
   *  allapot megmarad, es egy kattintassal visszaallithato. */
  function partsUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/parts' + (tail || '') + '?new_version=1'
  }

  function addTextPart() {
    var el = document.getElementById('wbPartNewText')
    var text = el && typeof el.value === 'string' ? el.value : ''
    if (!text.trim() || WB.partBusy) return
    WB.partBusy = true
    render()
    api('POST', partsUrl(), { kind: 'text', text: text }).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.partNewOpen = false
      WB.partNewDraft = ''
      applyParts(r.data)
      window.showToast(t('workbench.parts.added'))
    })
  }

  function savePart(partId) {
    var el = document.getElementById('wbPartText')
    var value = el && typeof el.value === 'string' ? el.value : ''
    var part = partsOf().filter(function (p) { return p.id === partId })[0]
    if (!part || WB.partBusy) return
    WB.partBusy = true
    render()
    var body = part.kind === 'image' ? { caption: value } : { text: value }
    api('PATCH', partsUrl('/' + encodeURIComponent(partId)), body).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.partEdit = null
      applyParts(r.data)
      window.showToast(t('workbench.parts.saved'))
    })
  }

  function movePart(partId, dir) {
    if (WB.partBusy) return
    api('POST', partsUrl('/' + encodeURIComponent(partId) + '/move'), { dir: dir }).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      applyParts(r.data)
    })
  }

  /** Kivetel a munkadarabbol. A KEP FAJLJA marad -- ezt a kerdes is kimondja,
   *  mert a "torles" szo mast igerne, mint ami tortenik. */
  function removePart(partId) {
    if (WB.partBusy) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.parts.remove_confirm'))) return
    WB.partBusy = true
    render()
    api('DELETE', partsUrl('/' + encodeURIComponent(partId))).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (WB.partEdit === partId) WB.partEdit = null
      applyParts(r.data)
      window.showToast(t('workbench.parts.removed'))
    })
  }

  /** Kep feltoltese: a nyers bajtok mennek, a nev a query-ben -- igy az
   *  ekezetes fajlnev sem torik el (ugyanaz a mod, mint a projekt-feltoltesnel). */
  function uploadImagePart(file) {
    if (!file || !WB.selectedId || WB.partBusy) return
    WB.partBusy = true
    render()
    var url = partsUrl('/image')
      + '&name=' + encodeURIComponent(file.name || 'kep.jpg')
      + '&type=' + encodeURIComponent(file.type || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        WB.partBusy = false
        if (!res.ok) {
          render()
          // A szerver EMBERI mondatot kuld (a gepi kod csak tartalek).
          window.showToast((data && data.message) || t('workbench.err.http', { status: res.status }))
          return
        }
        applyParts(data)
        window.showToast(t('workbench.parts.added'))
      })
    }).catch(function () {
      WB.partBusy = false
      render()
      window.showToast(t('workbench.err.network'))
    })
  }

  // DOKUMENTUM VISSZATOLTESE UJ VERZIOKENT (7. fazis, spec 8). Semmi nem
  // irodik felul: a fajl foglalt nevnel uj nevet kap (es azt KI IS mondjuk), a
  // munkadarab pedig uj verziot -- a regi verzio erintetlen marad.
  function uploadDocumentVersion(file) {
    if (!file || !WB.selectedId || WB.docBusy) return
    var itemId = WB.selectedId
    WB.docBusy = true
    render()
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/document'
      + '?name=' + encodeURIComponent(file.name || 'dokumentum.docx')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
      + ((WB.detail && WB.detail.item && WB.detail.item.current_version_id) ? '&base_version=' + encodeURIComponent(WB.detail.item.current_version_id) : '')
    fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        WB.docBusy = false
        if (!res.ok) {
          render()
          window.showToast((data && data.message) || t('workbench.err.http', { status: res.status }))
          return
        }
        if (WB.detail && data && data.item) { WB.detail.item = data.item; WB.detail.versions = data.versions || WB.detail.versions }
        loadPreview(itemId, null)
        WB.previewVersion = null
        render()
        // Ha a nev foglalt volt, a fajl MAS neven all -- ezt nem hallgatjuk el.
        window.showToast(data && data.renamed
          ? t('workbench.versions.uploaded_renamed', { name: (data.file && data.file.name) || data.name })
          : t('workbench.versions.uploaded'))
      })
    }).catch(function () {
      WB.docBusy = false
      render()
      window.showToast(t('workbench.err.network'))
    })
  }

  // PDF-ELONEZET KESZITESE irodai dokumentumbol (7. fazis). A fajlhoz nem
  // nyulunk hozza: a PDF szarmaztatott, es barmikor ujra eloallithato.
  //
  // Ha nincs a gepen LibreOffice, a szerver EMBERI mondatot kuld arrol, mi
  // hianyzik es hogyan szerezheto be -- azt mutatjuk, nem gepi kodot. A
  // "megegyszer" ujra MEGMERI az allapotot (force), tehat telepites utan
  // azonnal jo valaszt ad: nem a korabbi meresbol beszel.
  function convertPreview(force) {
    if (!WB.selectedId || WB.convertBusy) return
    var itemId = WB.selectedId
    WB.convertBusy = true
    WB.convertError = null
    render()
    var go = function () {
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/convert'
        + (WB.previewVersion ? '?version=' + encodeURIComponent(WB.previewVersion) : '')
      return api('POST', url).then(function (r) {
        if (WB.selectedId !== itemId) return
        WB.convertBusy = false
        if (!r.ok) {
          WB.convertError = { message: r.message, detail: (r.data && r.data.detail) || null }
          render()
          return
        }
        WB.convertError = null
        loadPreview(itemId, WB.previewVersion)
        window.showToast(t('workbench.preview.converted'))
      })
    }
    // Ujraprobalasnal elobb ujra megmerjuk, van-e mar LibreOffice.
    if (force) {
      fetch('/api/workbench/capabilities?force=1&lang=' + encodeURIComponent(window._lang || 'hu'))
        .then(function () { return go() })
        .catch(function () { return go() })
      return
    }
    go()
  }

  function openWorkbench(projectId, projectName) {
    if (!projectId) return
    WB.open = true
    WB.projectId = projectId
    WB.fileSel = {}
    WB.selName = ''
    WB.shares = null; WB.sharesFor = null; WB.sharesError = null; WB.sharesLoading = null
    WB.project = projectName ? { id: projectId, name: projectName } : null
    WB.items = null
    WB.detail = null
    WB.selectedId = null
    WB.formOpen = false
    WB.intakeAsk = null; WB.intakeDraft = ''; WB.intakeName = ''
    WB.error = null
    WB.panel = 'items'
    WB.chat = {}
    WB.chatStatus = null
    WB.chatStatusError = null
    WB.chatStreaming = false
    WB.chatAbort = null
    if (WB.chatWatch) clearTimeout(WB.chatWatch.timer)
    WB.chatWatch = null
    stopChatActivityTicker()
    WB.chatDraft = ''
    WB.chatSetupOpen = false
    WB.chatSetupBusy = false
    WB.chatConfig = null
    WB.partEdit = null
    WB.partNewOpen = false
    WB.partBusy = false
    WB.overview = null
    WB.overviewError = null
    WB.upload = null
    WB.tlOpen = false
    WB.tl = null
    WB.tlError = null
    WB.tlSources = []
    WB.tlMore = false
    WB.tlNext = null
    WB.tlBusy = false
    WB.searchOpen = false
    WB.searchQ = ''
    WB.search = null
    WB.searchError = null
    WB.searchBusy = false
    WB.wkOpen = false
    WB.weekly = null
    WB.wkError = null
    WB.wkShown = null
    WB.todos = null
    WB.tdError = null
    WB.tdBusy = false
    WB.tdOpen = false
    WB.decOpen = false
    WB.decisions = null
    WB.decError = null
    WB.decBusy = false
    WB.decEdit = null
    WB.brandOpen = false
    WB.brand = null
    WB.brandDraft = null
    WB.brandFiles = []
    WB.brandFilesError = null
    WB.brandUnreadable = false
    WB.brandError = null
    WB.brandBusy = false
    WB.brandCheck = null
    WB.brandTemplates = []
    WB.brandTplBusy = null
    WB.chatForceBottom = true
    render()
    load(projectId)
    loadChatStatus()
    loadChatHistory()
  }

  function closeWorkbench() {
    var pid = WB.projectId
    WB.open = false
    WB.projectId = null
    WB.items = null
    WB.detail = null
    if (pid && typeof window._prjOpenProject === 'function') return window._prjOpenProject(pid)
  }

  /** "...and N more" on an opened overview tile: the whole lists are on the
   *  project page's own Kanban tab (every card and work item, per column). */
  function openProjectKanban() {
    var pid = WB.projectId
    Promise.resolve(closeWorkbench()).then(function () {
      var P = window._prj
      if (!P || P.current !== pid || typeof window._prjRenderProject !== 'function') return
      if (P.tab !== 'kanban') { P.tab = 'kanban'; window._prjRenderProject() }
    })
  }

  // ---- esemenyek (egy delegalt figyelo) -------------------------------------

  // #426: a fiokvalaszto valtozasa. A select ertekbol allitjuk WB.chatAccount-ot;
  // a kovetkezo kuldes ezt viszi. Nem kell ujrarajzolni -- a select maga mutatja.
  document.addEventListener('change', function (e) {
    if (!WB.open || !e.target || !e.target.closest) return
    if (e.target.id === 'wbNewFolder') { WB.pickFolder = e.target.value; return }
    var trk = e.target.getAttribute && e.target.getAttribute('data-wb-tr')
    if (trk) { trSetLang(trk, e.target.value); return }
    // The list, colour and checkbox fields of the Brand Kit form (see brandSyncDraft).
    if (/^wbBrand/.test(String(e.target.id || '')) && WB.brandOpen) { brandSyncDraft(); return }
    var mvf = e.target.getAttribute && e.target.getAttribute('data-wb-move-files')
    if (mvf) { if (e.target.value) moveFilesToFolder(mvf, e.target.value); return }
    var mv = e.target.getAttribute && e.target.getAttribute('data-wb-move')
    if (mv) { if (e.target.value) moveItemToFolder(mv, e.target.value); return }
    var rid = e.target.getAttribute && e.target.getAttribute('data-wb-redact-id')
    if (rid && WB.redact) {
      WB.redact.skip[rid] = !e.target.checked
      render()
      return
    }
    var sideSel = e.target.closest('[data-wb-act="chat-side"]')
    if (sideSel) { WB.chatSide = sideSel.value; return }
    var sel = e.target.closest('[data-wb-act="chat-account"]')
    if (!sel) return
    WB.chatAccount = sel.value === 'auto' ? '' : sel.value
  })

  // ---- Ctrl+click / middle click: a new browser tab (Boss, TG 1802) --------
  // "ha a kontrolt megnyomom ... akkor egy uj bongeszofulon nyissa meg. Ugy,
  // hogy ez a bongeszoful ugyanitt maradjon." The new tab gets the target in
  // its URL in the Projects page's own #435 view shape; this tab is untouched.
  function projectTabState(projectId, name, item) {
    return { current: projectId, tab: null, wb: { projectId: projectId, name: name || '', item: item || null, panel: WB.panel } }
  }
  function newTabNav(e) {
    if (typeof window.isNewTabClick !== 'function' || typeof window.openViewInNewTab !== 'function') return false
    // "Open in the Intezo" always opens a new tab, plain click too (Boss, TG 1807
    // "1A"): the Workbench must not leave this tab.
    var folderBtn = e.target.closest('[data-wb-act="folder-intezo"]')
    if (folderBtn && WB.open && WB.projectId && (e.button === 0 || e.button === 1)) {
      openFolder(folderBtn.getAttribute('data-wb-place'), folderBtn.getAttribute('data-wb-asset'), 'intezo', window.openViewInNewTab(null, null, true))
      return true
    }
    if (!window.isNewTabClick(e)) return false
    var openBtn = e.target.closest('[data-wb-open]')
    if (openBtn) {
      var pid = openBtn.getAttribute('data-wb-open')
      window.openViewInNewTab('projects', projectTabState(pid, openBtn.getAttribute('data-wb-open-name'), null))
      return true
    }
    if (!WB.open || !WB.projectId) return false
    var itemBtn = e.target.closest('[data-wb-item]')
    if (itemBtn) {
      window.openViewInNewTab('projects', projectTabState(WB.projectId, (WB.project && WB.project.name) || '', itemBtn.getAttribute('data-wb-item')))
      return true
    }
    return false
  }
  document.addEventListener('auxclick', function (e) {
    if (e.button === 1 && newTabNav(e)) e.preventDefault()
  })

  document.addEventListener('click', function (e) {
    if (newTabNav(e)) { e.preventDefault(); return }
    var openBtn = e.target.closest('[data-wb-open]')
    if (openBtn) {
      openWorkbench(openBtn.getAttribute('data-wb-open'), openBtn.getAttribute('data-wb-open-name'))
      return
    }
    if (!WB.open) return
    var panelBtn = e.target.closest('[data-wb-panel]')
    if (panelBtn) { WB.panel = panelBtn.getAttribute('data-wb-panel'); render(); return }
    var itemBtn = e.target.closest('[data-wb-item]')
    if (itemBtn) {
      selectItem(itemBtn.getAttribute('data-wb-item'))
      return
    }
    var act = e.target.closest('[data-wb-act]')
    if (!act) return
    var a = act.getAttribute('data-wb-act')
    // A Fajl / Meretezes menu bezarul, ha masra kattintasz (a menu sorai maguk is bezarjak).
    if (WB.frMenu && a !== 'fr-menu') WB.frMenu = null
    if (a === 'fr-menu') { var m = act.getAttribute('data-wb-m'); WB.frMenu = WB.frMenu === m ? null : m; render() }
    else if (a === 'fr-tab') { var tb = act.getAttribute('data-wb-tab'); WB.frTab = WB.frTab === tb ? null : tb; writePref('wb.fr.tab', WB.frTab || ''); render(); if (WB.frTab === 'brand' && !WB.brandOpen) { WB.brandOpen = true; render(); loadBrand() } if (WB.frTab === 'templates' && WB.templates === null) loadTemplates() }
    else if (a === 'fr-live') { WB.frLive = !WB.frLive; render() }
    else if (a === 'fr-chat') { WB.frChat = !WB.frChat; writePref('wb.fr.chat', WB.frChat ? '1' : '0'); render() }
    else if (a === 'fr-add-text') frAddText(act.getAttribute('data-wb-arg'))
    else if (a === 'fr-add-image') frAddImage(act.getAttribute('data-wb-src'), null, null)
    else if (a === 'back') closeWorkbench()
    else if (a === 'item-pin') togglePin(act.getAttribute('data-wb-pin'))
    else if (a === 'item-trash') setTrashed(act.getAttribute('data-wb-id'), true)
    else if (a === 'ov-fold') { WB.ovOpen = !WB.ovOpen; saveOvOpen(WB.ovOpen); render() }
    else if (a === 'ov-kanban') openProjectKanban()
    else if (a === 'folder-delete') { deleteFolder(act.getAttribute('data-wb-folder')) }
    else if (a === 'tr-mode') trSetMode(act.getAttribute('data-wb-mode'))
    else if (a === 'tr-run') trRun()
    else if (a === 'tr-swap') trSwap()
    else if (a === 'file-ctx') { var fr = act.getBoundingClientRect ? act.getBoundingClientRect() : { left: 8, bottom: 8 }; WB.ctx = { file: act.getAttribute('data-wb-rel'), x: fr.left, y: fr.bottom }; render() }
    else if (a === 'folder-ctx') { var dr = act.getBoundingClientRect ? act.getBoundingClientRect() : { left: 8, bottom: 8 }; WB.ctx = { folder: act.getAttribute('data-wb-folder'), x: dr.left, y: dr.bottom }; render() }
    else if (a === 'file-to-item') fileToItem(act.getAttribute('data-wb-rel'))
    else if (a === 'file-delete') deleteFiles(act.getAttribute('data-wb-rel'))
    else if (a === 'file-rename') renameFile(act.getAttribute('data-wb-rel'))
    else if (a === 'file-sel') toggleFileSel(act.getAttribute('data-wb-rel'))
    else if (a === 'sel-to-deck') selectionToDeck()
    else if (a === 'sel-clear') { WB.fileSel = {}; WB.selName = ''; render() }
    else if (a === 'folder-to-deck') folderToDeck(act.getAttribute('data-wb-folder'))
    else if (a === 'folder-rename') { renameFolder(act.getAttribute('data-wb-folder')) }
    else if (a === 'folder-fold') { var ff = act.getAttribute('data-wb-folder'); WB.collapsedFolder[ff] = !WB.collapsedFolder[ff]; render() }
    else if (a === 'mkfolder') { makeFolder() }
    else if (a === 'item-restore') setTrashed(act.getAttribute('data-wb-id'), false)
    else if (a === 'trash-toggle') { WB.trashOpen = !WB.trashOpen; render() }
    else if (a === 'rescue-toggle') { WB.rescueOpen = !WB.rescueOpen; render() }
    else if (a === 'rescue-restore') runRescue(false)
    else if (a === 'rescue-adopt') runRescue(true)
    else if (a === 'privacy-project') setPrivacy('project', act.getAttribute('data-wb-on') === '1')
    else if (a === 'privacy-item') setPrivacy('item', act.getAttribute('data-wb-on') === '1')
    else if (a === 'parts-tech-toggle') { WB.partsTechOpen = !WB.partsTechOpen; render() }
    else if (a === 'tech-toggle') { WB.techOpen = !WB.techOpen; if (WB.techOpen) loadEgress(); else render() }
    else if (a === 'item-purge-ask') {
      WB.warn = { kind: 'purge', id: act.getAttribute('data-wb-id') }; render()
      // The red confirm box opens under the row: bring it into view, but only as far as needed.
      var wbox = typeof document.querySelector === 'function' ? document.querySelector('.wb-warn-box') : null
      if (wbox && typeof wbox.scrollIntoView === 'function') wbox.scrollIntoView({ block: 'nearest' })
    }
    else if (a === 'item-purge') purgeItem(act.getAttribute('data-wb-id'))
    else if (a === 'last-version-trash') { WB.warn = null; setTrashed(act.getAttribute('data-wb-id'), true) }
    else if (a === 'warn-cancel') { WB.warn = null; render() }
    else if (a === 'goto-approvals') { if (typeof window.switchPage === 'function') window.switchPage('approvals') }
    else if (a === 'goto-fullmode') { if (typeof window.openWorkbenchSettings === 'function') window.openWorkbenchSettings(); else if (typeof window.switchPage === 'function') window.switchPage('settings') }
    else if (a === 'export-open') { WB.exportOpen = WB.selectedId; render() }
    else if (a === 'share-days') { var sd = Number(act.getAttribute('data-wb-days')); if (sd === 1 || sd === 7 || sd === 30) { WB.shareDays = sd; render() } }
    else if (a === 'share-create') { var sk = act.getAttribute('data-wb-share-kind'); if (sk === 'item' || sk === 'handoff') shareCreate(sk) }
    else if (a === 'share-revoke') { var sid = act.getAttribute('data-wb-share'); if (sid) shareRevoke(sid) }
    else if (a === 'share-copy') shareCopy(act.getAttribute('data-wb-share-url') || '')
    else if (a === 'export-close') { WB.exportOpen = null; render() }
    else if (a === 'export-print') openPrint()
    else if (a === 'export-png') exportPng()
    else if (a === 'export-doc') { var df = act.getAttribute('data-wb-fmt'); if (df) exportDoc(df) }
    else if (a === 'send-request') { e.preventDefault(); sendRequest() }
    else if (a === 'send-refresh') refreshSendStatus()
    else if (a === 'send-new') { WB.send = null; render() }
    else if (a === 'version-undo') undoVersion()
    else if (a === 'compare-open') openCompare()
    else if (a === 'compare-close') { WB.compare = null; render() }
    else if (a === 'text-edit') openTextEdit()
    else if (a === 'doc-edit') openDocEdit()
    else if (a === 'doc-edit-close') closeDocEdit(true)
    else if (a === 'pdf-edit') openPdfEdit()
    else if (a === 'pdf-edit-close') closePdfEdit(true)
    else if (a === 'pdf-to-docx') pdfToDocx()
    else if (a === 'dict') dictToggle(act.getAttribute('data-wb-dict'))
    else if (a === 'tts') ttsToggle(act.getAttribute('data-wb-tts'))
    else if (a === 'img-open') openImageEditor()
    else if (a === 'img-close') imgClose()
    else if (a === 'img-save') imgSave()
    else if (a === 'vid-mark') { var vw = act.getAttribute('data-wb-which'); if (vw === 'start' || vw === 'end') vidMark(vw) }
    else if (a === 'vid-trim') vidSave('trim')
    else if (a === 'vid-frame') vidSave('frame')
    else if (a === 'img-reset' && imgState()) {
      var ist = imgState()
      ist.rot = 0; ist.flip = false; ist.aspect = 'free'
      ist.caption = { text: '', pos: 'bottom', size: 6, color: 'white', band: true }
      ist.bg = { pick: false, seeds: [], tol: 32 }
      ist.dirty = false
      imgResetGeometry(ist); render(); imgRefresh(true)
    }
    else if (a === 'img-aspect') imgSetAspect(act.getAttribute('data-wb-aspect'))
    else if (a === 'img-rot-left') imgRotate(-90)
    else if (a === 'img-rot-right') imgRotate(90)
    else if (a === 'img-flip' && imgState()) { imgState().flip = !imgState().flip; imgState().bg.seeds = []; imgState().dirty = true; render(); imgRefresh(true) }
    else if (a === 'img-size-orig' && imgState()) { imgState().outW = imgState().crop.w; render(); imgRefresh(false) }
    else if (a === 'img-size-half' && imgState()) { imgState().outW = Math.max(1, Math.round(imgState().crop.w / 2)); imgState().dirty = true; render(); imgRefresh(false) }
    else if (a === 'img-bg-pick' && imgState()) { imgState().bg.pick = !imgState().bg.pick; render() }
    else if (a === 'img-bg-clear' && imgState()) { imgState().bg.seeds = []; render(); imgRefresh(false) }
    else if (a === 'table-open') openTable(WB.selectedId, WB.previewVersion)
    else if (a === 'table-close') closeTable()
    else if (a === 'table-save') saveTable()
    else if (a === 'table-sheet' && WB.table) { WB.table.sheet = Number(act.getAttribute('data-wb-sheet')) || 0; WB.table.page = 0; WB.table.sel = { r: 0, c: 0 }; render() }
    else if (a === 'table-page-prev' && WB.table) { WB.table.page = Math.max(0, WB.table.page - 1); render() }
    else if (a === 'table-page-next' && WB.table) { WB.table.page = WB.table.page + 1; render() }
    else if (a === 'table-row-add') tableStructure('row-add')
    else if (a === 'table-row-del') tableStructure('row-del')
    else if (a === 'table-col-add') tableStructure('col-add')
    else if (a === 'table-col-del') tableStructure('col-del')
    else if (a === 'create-table') { e.preventDefault(); createTable() }
    else if (a === 'text-save') { e.preventDefault(); saveTextEdit() }
    else if (a === 'text-cancel') { WB.textEdit = null; render() }
    else if (a === 'view-set') setView(act.getAttribute('data-wb-view'))
    else if (a === 'sh-more') { WB.shMore = !WB.shMore; render() }
    else if (a === 'sh-recent-view') { WB.recentMode = act.getAttribute('data-wb-mode') === 'list' ? 'list' : 'grid'; saveRecentMode(WB.recentMode); render() }
    else if (a === 'sh-new') { WB.selectedId = null; WB.detail = null; WB.formOpen = false; WB.shMore = false; render() }
    else if (a === 'sh-doc-tab') { WB.shDocTab = act.getAttribute('data-wb-tab') || 'draft'; render() }
    else if (a === 'sh-final') { WB.shFinal = !WB.shFinal; render() }
    else if (a === 'layout-toggle') { WB.layout = WB.layout === 'split' ? 'classic' : 'split'; saveLayout(WB.layout); render() }
    else if (a === 'refresh') load(WB.projectId)
    else if (a === 'card-open') openCard(act.getAttribute('data-wb-card'))
    else if (a === 'new') { if (!archived()) { WB.newDraft = null; WB.formOpen = true; WB.intakeFocused = false; render() } }
    else if (a === 'cancel-new') { WB.formOpen = false; WB.newDraft = null; WB.intakeAsk = null; render() }
    else if (a === 'intake-go') intakeCreate(null)
    else if (a === 'intake-kind') intakeCreate(act.getAttribute('data-wb-kind'))
    else if (a === 'intake-reset') { intakeReadDraft(); WB.intakeAsk = null; render() }
    else if (a === 'create') { e.preventDefault(); create() }
    else if (a === 'tpl-use') useTemplate(act.getAttribute('data-wb-tpl'))
    else if (a === 'tpl-retry') { WB.templatesError = null; WB.templates = null; render(); loadTemplates() }
    else if (a === 'post-toggle') { var ps = postState(); ps.open = !ps.open; render(); if (ps.open && !ps.files) loadPostFiles() }
    else if (a === 'post-view') { var pv = act.getAttribute('data-wb-view'); if (pv === 'mobile' || pv === 'desktop') { postState().view = pv; render() } }
    else if (a === 'post-more') { var pm = postState(); pm.more = !pm.more; render() }
    else if (a === 'post-dl') postDownload(act.getAttribute('data-wb-fmt') === 'png' ? 'png' : 'jpg')
    else if (a === 'post-pdf') postPdf()
    else if (a === 'post-save') postSave()
    else if (a === 'part-new-text') { if (!archived()) { WB.partNewOpen = !WB.partNewOpen; WB.partEdit = null; render() } }
    else if (a === 'part-cancel') { WB.partNewOpen = false; WB.partNewDraft = ''; WB.partEdit = null; render() }
    else if (a === 'part-add-text') { e.preventDefault(); addTextPart() }
    else if (a === 'part-edit') { WB.partEdit = act.getAttribute('data-wb-part'); WB.partDraft = null; WB.partNewOpen = false; render() }
    else if (a === 'part-save') { e.preventDefault(); savePart(act.getAttribute('data-wb-part')) }
    else if (a === 'part-up') movePart(act.getAttribute('data-wb-part'), 'up')
    else if (a === 'part-down') movePart(act.getAttribute('data-wb-part'), 'down')
    else if (a === 'part-remove') removePart(act.getAttribute('data-wb-part'))
    // Toggle like every other header panel button: a second press closes it (Boss, TG 1830).
    else if (a === 'caps-open') { WB.capsOpen = !WB.capsOpen; if (WB.capsOpen && WB.caps === null) loadCaps(false); else render() }
    else if (a === 'caps-close') { WB.capsOpen = false; render() }
    else if (a === 'caps-refresh') loadCaps(true)
    else if (a === 'wk-open') { WB.wkOpen = !WB.wkOpen; if (WB.wkOpen && WB.weekly === null) loadWeekly(); else render() }
    else if (a === 'wk-close') { WB.wkOpen = false; render() }
    else if (a === 'wk-refresh') { WB.weekly = null; WB.wkError = null; render(); loadWeekly() }
    else if (a === 'wk-show') { WB.wkShown = act.getAttribute('data-wb-week') || 'current'; render() }
    else if (a === 'tl-open') { WB.tlOpen = !WB.tlOpen; if (WB.tlOpen && WB.tl === null) loadTimeline(false); else render() }
    else if (a === 'tl-close') { WB.tlOpen = false; render() }
    else if (a === 'tl-refresh') loadTimeline(false)
    else if (a === 'tl-more') loadTimeline(true)
    else if (a === 'approval-submit') approvalAction('submit')
    else if (a === 'approval-withdraw') approvalAction('withdraw')
    else if (a === 'approval-approve') approvalAction('approve')
    else if (a === 'approval-reject') approvalAction('reject')
    else if (a === 'ho-open') { WB.hoOpen = !WB.hoOpen; if (WB.hoOpen) loadHandoff(); else render() }
    else if (a === 'ho-close') { WB.hoOpen = false; render() }
    else if (a === 'ho-refresh') loadHandoff()
    else if (a === 'ho-scope') { var sc = act.getAttribute('data-wb-scope'); if (sc === 'done' || sc === 'all') { WB.hoScope = sc; loadHandoff() } }
    else if (a === 'td-open') {
      WB.tdOpen = !WB.tdOpen; render()
      if (WB.tdOpen && WB.todos === null) loadTodos()
      if (WB.tdOpen && !WB.tdRem) loadReminder()
    }
    else if (a === 'td-rem-retry') { WB.tdRemError = null; WB.tdRem = null; render(); loadReminder() }
    else if (a === 'td-rem-save') saveReminderFromForm()
    else if (a === 'td-rem-test') reminderRequest('POST', '/api/workbench/todo-reminder/test', {}, 'workbench.td.rem.test_ok')
    else if (a === 'td-close') { WB.tdOpen = false; render() }
    else if (a === 'td-retry') { WB.tdError = null; WB.todos = null; render(); loadTodos() }
    else if (a === 'td-gcal') { var gId = act.getAttribute('data-wb-todo'); if (gId) tdGcalRequest(gId) }
    else if (a === 'td-gcal-setup') { if (typeof window.openWizardItem === 'function') window.openWizardItem('google-accounts') }
    else if (a === 'td-item') { var tid = act.getAttribute('data-wb-item-id'); if (tid) selectItem(tid) }
    else if (a === 'td-toggle' || a === 'td-delete' || a === 'td-norepeat') {
      var tdId = act.getAttribute('data-wb-todo')
      var cur = (WB.todos || []).filter(function (x) { return x.id === tdId })[0]
      if (!cur) return
      if (a === 'td-norepeat') tdRequest('PATCH', '/api/workbench/todos/' + encodeURIComponent(tdId), { repeat: '' }, 'norepeat')
      else if (a === 'td-toggle') tdRequest('PATCH', '/api/workbench/todos/' + encodeURIComponent(tdId), { done: cur.done_at == null }, cur.done_at == null ? 'done' : 'undone')
      else if (window.confirm(t('workbench.td.delete_confirm', { text: cur.text }))) tdRequest('DELETE', '/api/workbench/todos/' + encodeURIComponent(tdId), undefined, 'deleted')
    }
    else if (a === 'brand-open') { WB.brandOpen = !WB.brandOpen; render(); if (WB.brandOpen) loadBrand() }
    else if (a === 'brand-close') { WB.brandOpen = false; render() }
    else if (a === 'brand-add-color') { brandSyncDraft(); WB.brandDraft.colors.push({ name: '', hex: '#1a73e8' }); render() }
    else if (a === 'brand-del-color') { brandSyncDraft(); WB.brandDraft.colors.splice(parseInt(act.getAttribute('data-wb-i'), 10), 1); render() }
    else if (a === 'brand-reset') { WB.brandDraft = brandCopy(WB.brand); render() }
    else if (a === 'brand-swatch') {
      var sw = document.getElementById(act.getAttribute('data-wb-target'))
      if (sw) sw.value = act.getAttribute('data-wb-hex')
    }
    else if (a === 'canvas-brand-check') runBrandCheck()
    else if (a === 'canvas-brand-tpl-save') saveBrandTemplate(null, false)
    else if (a === 'brand-tpl-use') useBrandTemplate(act.getAttribute('data-wb-tpl'))
    else if (a === 'brand-tpl-del') deleteBrandTemplate(act.getAttribute('data-wb-tpl'))
    else if (a === 'dec-open') { WB.decOpen = !WB.decOpen; render(); if (WB.decOpen) loadDecisions() }
    else if (a === 'dec-close') { WB.decOpen = false; WB.decEdit = null; render() }
    else if (a === 'dec-edit') { WB.decEdit = act.getAttribute('data-wb-dec'); render() }
    else if (a === 'dec-cancel') { WB.decEdit = null; render() }
    else if (a === 'dec-revoke') {
      if (window.confirm(t('workbench.dec.revoke_confirm'))) decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(act.getAttribute('data-wb-dec')), { revoked: true }, 'revoke')
    }
    else if (a === 'dec-restore') decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(act.getAttribute('data-wb-dec')), { revoked: false }, 'restore')
    else if (a === 'search-open') { WB.searchOpen = !WB.searchOpen; render(); if (WB.searchOpen) { var si = document.getElementById('wbSearchInput'); if (si && si.focus) si.focus() } }
    else if (a === 'search-close') { WB.searchOpen = false; render() }
    else if (a === 'cap-test') testCap(act.getAttribute('data-wb-cap'))
    else if (a === 'cap-save') saveCapSetting(act.getAttribute('data-wb-cap'))
    else if (a === 'canvas-start') { if (!archived()) startCanvas() }
    else if (a === 'post-to-canvas') postToCanvas()
    else if (a === 'canvas-refresh') loadCanvas(WB.selectedId)
    else if (a === 'deck-refresh') loadDeck(WB.selectedId)
    else if (a === 'deck-pick') deckSelectSlide(act.getAttribute('data-wb-id'))
    else if (a === 'deck-add') deckAddSlide()
    else if (a === 'fr-deck-layout') {
      var lay = act.getAttribute('data-wb-arg') || 'content'
      var curl = deckCurrentSlide()
      deckOps([{ op: 'addSlide', layout: lay, at: curl ? deckSlides().indexOf(curl) + 2 : 1, title: t('workbench.deck.new_title'), body: lay === 'title' ? t('workbench.deck.new_subtitle') : t('workbench.deck.new_body') }], function (d) {
        var ap = (d.applied || [])[0]
        if (ap && ap.id) { WB.deckSlide = ap.id; deckSyncCanvas() }
      })
    }
    else if (a === 'deck-add-blank') {
      // Egy UJ, ures oldal a kijelolt utan (a Canva "+ Oldal hozzaadasa" mintaja).
      var curp = deckCurrentSlide()
      deckOps([{ op: 'addSlide', layout: 'blank', at: curp ? deckSlides().indexOf(curp) + 2 : 1 }], function (d) {
        var ap = (d.applied || [])[0]
        if (ap && ap.id) { WB.deckSlide = ap.id; deckSyncCanvas() }
      })
    }
    else if (a === 'deck-up' || a === 'deck-down') deckMoveSlide(act.getAttribute('data-wb-id'), a === 'deck-up' ? -1 : 1)
    else if (a === 'deck-dup') deckOps([{ op: 'duplicateSlide', id: act.getAttribute('data-wb-id') }])
    else if (a === 'deck-del') deckRemoveSlide(act.getAttribute('data-wb-id'))
    else if (a === 'deck-size') deckOps([{ op: 'setSize', size: act.getAttribute('data-wb-v') }])
    else if (a === 'deck-notes') deckSaveNotes()
    else if (a === 'deck-export') deckExportNow(act.getAttribute('data-wb-v'))
    else if (a === 'fr-vt-split') frVtSplitAtPlayhead()
    else if (a === 'fr-vt-add') frVtAddFromStrip()
    else if (a === 'vt-refresh') loadVideoTimeline(WB.selectedId)
    else if (a === 'vt-undo' || a === 'vt-redo') vtStep(a === 'vt-undo' ? 'undo' : 'redo')
    else if (a === 'vt-version') vtVersion()
    else if (a === 'vt-render') vtRenderNow()
    else if (a === 'vt-autosub') vtAutoSubtitle()
    else if (a === 'vt-aspect') vtOps([{ op: 'setAspect', aspect: act.getAttribute('data-wb-v') }])
    else if (a === 'vt-clip-add') vtAddClip()
    else if (a === 'vt-clip-trim') vtTrimClip(act.getAttribute('data-wb-id'))
    else if (a === 'vt-clip-up' || a === 'vt-clip-down') vtMoveClip(act.getAttribute('data-wb-id'), a === 'vt-clip-up' ? -1 : 1)
    else if (a === 'vt-clip-split') vtSplitClip(act.getAttribute('data-wb-id'))
    else if (a === 'vt-clip-del') vtOps([{ op: 'removeClip', id: act.getAttribute('data-wb-id') }])
    else if (a === 'vt-sub-add') vtAddSubtitle()
    else if (a === 'vt-sub-save') vtSaveSubtitle(act.getAttribute('data-wb-id'))
    else if (a === 'vt-sub-del') vtOps([{ op: 'removeSubtitle', id: act.getAttribute('data-wb-id') }])
    else if (a === 'vt-music-set') vtSetMusic()
    else if (a === 'vt-music-save') vtSaveMusic()
    else if (a === 'vt-music-del') vtOps([{ op: 'clearMusic' }])
    else if (a === 'vt-ov-add') vtAddOverlay()
    else if (a === 'vt-ov-save') vtSaveOverlay(act.getAttribute('data-wb-id'))
    else if (a === 'vt-ov-del') vtOps([{ op: 'removeOverlay', id: act.getAttribute('data-wb-id') }])
    else if (a === 'vt-volume') vtSaveVolume()
    else if (a === 'canvas-undo') canvasStep('undo')
    else if (a === 'canvas-redo') canvasStep('redo')
    else if (a === 'canvas-version') canvasSaveVersion()
    else if (a === 'canvas-orphan-restore') canvasOrphan(act.getAttribute('data-wb-version'), true)
    else if (a === 'canvas-orphan-discard') canvasOrphan(act.getAttribute('data-wb-version'), false)
    else if (a === 'canvas-edit') { WB.canvasEdit = act.getAttribute('data-wb-obj'); render() }
    else if (a === 'canvas-cancel') { WB.canvasEdit = null; render() }
    else if (a === 'canvas-save') { e.preventDefault(); saveCanvasObject(act.getAttribute('data-wb-obj')) }
    else if (a === 'canvas-add-text') { if (!archived()) canvasAddText() }
    else if (a === 'canvas-add-rect') { if (!archived()) canvasAddRect() }
    else if (a === 'canvas-add-ellipse') { if (!archived()) canvasAddEllipse() }
    else if (a === 'canvas-add-line') { if (!archived()) canvasAddLine() }
    else if (a === 'canvas-add-button') { if (!archived()) canvasAddButton() }
    else if (a === 'canvas-pick') { var pid = act.getAttribute('data-wb-obj'); if (WB.canvasPick[pid]) delete WB.canvasPick[pid]; else WB.canvasPick[pid] = true; render() }
    else if (a === 'canvas-unpick') { WB.canvasPick = {}; render() }
    else if (a === 'canvas-resize') { if (!archived()) canvasOps([{ op: 'resize', platform: act.getAttribute('data-wb-arg') }]) }
    else if (a === 'canvas-variant') canvasVariant(act.getAttribute('data-wb-arg'))
    else if (a === 'canvas-ai-open') canvasAiOpen(act.getAttribute('data-wb-obj'))
    else if (a === 'canvas-ai-run') canvasAiRun()
    else if (a === 'canvas-snap') { WB.canvasSnap = !WB.canvasSnap; writePref('wb.canvas.snap', WB.canvasSnap ? '1' : '0'); render() }
    else if (a === 'canvas-grid') { WB.canvasGrid = !WB.canvasGrid; writePref('wb.canvas.grid', WB.canvasGrid ? '1' : '0'); render() }
    else if (a === 'canvas-align') canvasMulti('align', act.getAttribute('data-wb-arg'))
    else if (a === 'canvas-distribute') canvasMulti('distribute', act.getAttribute('data-wb-arg'))
    else if (a === 'canvas-group') canvasMulti('group')
    else if (a === 'canvas-ungroup') canvasMulti('ungroup')
    else if (a === 'canvas-add-image') { if (!archived()) canvasAddImage() }
    else if (a === 'canvas-remove') canvasRemoveObject(act.getAttribute('data-wb-obj'))
    else if (a === 'canvas-op') canvasQuickOp(act.getAttribute('data-wb-op'), act.getAttribute('data-wb-obj'))
    else if (a === 'can-float') canvasFloatOp(act.getAttribute('data-wb-fop'))
    else if (a === 'can-float-swatch') canvasFloatColor(act.getAttribute('data-wb-fprop'), act.getAttribute('data-wb-hex'))
    else if (a === 'preview-convert') convertPreview(false)
    else if (a === 'preview-convert-retry') convertPreview(true)
    else if (a === 'version-new') newVersion()
    else if (a === 'version-group') { var gk = act.getAttribute('data-wb-key'); WB.verOpen[gk] = !WB.verOpen[gk]; render() }
    else if (a === 'asset-remove') { WB.warn = { kind: 'asset-remove', id: act.getAttribute('data-wb-asset') }; render() }
    else if (a === 'asset-unlink') removeAsset(act.getAttribute('data-wb-asset'), false)
    else if (a === 'asset-delete-file') removeAsset(act.getAttribute('data-wb-asset'), true)
    else if (a === 'folder-intezo') openFolder(act.getAttribute('data-wb-place'), act.getAttribute('data-wb-asset'), 'intezo')
    else if (a === 'folder-system') openFolder(act.getAttribute('data-wb-place'), act.getAttribute('data-wb-asset'), 'system')
    else if (a === 'asset-tidy') tidyItemFolder()
    else if (a === 'assets-show') showAssetsBlock()
    // A celbirosag-doboz a vazlat PDF-reszeben el, ugyanaz a kezelo (#441, 7.4).
    else if (a && (a.indexOf('outline-') === 0 || a.indexOf('court-') === 0)) outlineAction(a, act)
    else if (a === 'dl-todo') dlTodo(act.getAttribute('data-wb-key'))
    else if (a === 'dl-propose') dlPropose(act.getAttribute('data-wb-key'))
    else if (a === 'dl-dismiss') dlCall('POST', encodeURIComponent(act.getAttribute('data-wb-key')) + '/dismiss', {})
    else if (a === 'dl-undismiss') dlCall('DELETE', encodeURIComponent(act.getAttribute('data-wb-key')) + '/dismiss')
    else if (a === 'doc-searchable') makeSearchable(act.getAttribute('data-wb-path'))
    else if (a === 'redact-open') redactOpen(act.getAttribute('data-wb-path'))
    else if (a === 'redact-scan') redactScan()
    else if (a === 'redact-apply') redactApply()
    else if (a === 'redact-close') { WB.redact = null; render() }
    else if (a === 'shared-toggle') toggleShared()
    else if (a === 'shared-link') linkShared(act.getAttribute('data-wb-path'))
    else if (a === 'chat-attached-drop') {
      // Csak az uzenetbol marad ki -- a fajl az Anyagok kozott marad.
      var dropList = WB.selectedId ? WB.chatAttached[WB.selectedId] : null
      var dropAt = Number(act.getAttribute('data-wb-attached'))
      if (dropList && dropAt >= 0 && dropAt < dropList.length) { dropList.splice(dropAt, 1); renderChat() }
    }
    else if (a === 'item-rename') renameItem()
    else if (a === 'item-ctx') { var cr = act.getBoundingClientRect ? act.getBoundingClientRect() : { left: 8, bottom: 8 }; WB.ctx = { id: act.getAttribute('data-wb-id'), x: cr.left, y: cr.bottom }; render() }
    else if (a === 'item-rename-row') renameItem(act.getAttribute('data-wb-id'))
    else if (a === 'version-restore') restoreVersion(act.getAttribute('data-wb-version'))
    else if (a === 'version-delete') deleteVersion(act.getAttribute('data-wb-version'))
    else if (a === 'chat-send') { if (WB.dict) dictStop(); sendChat() }
    else if (a === 'chat-stop') stopChat()
    else if (a === 'chat-unqueue') unqueueChat(Number(act.getAttribute('data-wb-turn')))
    else if (a === 'chat-continue') continueChat()
    else if (a === 'chat-edit-queued') editQueuedChat(Number(act.getAttribute('data-wb-turn')))
    else if (a === 'chat-setup') { if (WB.chatSetupOpen) { WB.chatSetupOpen = false; renderChat() } else openChatSetup() }
    else if (a === 'chat-setup-close') { WB.chatSetupOpen = false; renderChat() }
    else if (a === 'chat-setup-save') { e.preventDefault(); saveChatSetup() }
  })

  // ---- huzogatos szerkesztes: az esemenyek (kartya d4b05d82) ----------------
  //
  // EGY Pointer Events-figyelo lefedi az egeret ES az erintokepernyot is, tehat
  // telefonon ugyanugy mukodik. A huzas KOZBEN nem megy halozati keres: a doboz
  // helyben mozog, es csak az ELENGEDESKOR megy EGY `update` muvelet -- ugyanaz,
  // amit a szamokat kero urlap es az agent is kuldene, tehat a ket ut nem
  // csuszhat szet.

  var canvasDrag = null

  function canvasDragStyle(el, box, doc) {
    if (!el || !el.style) return
    el.style.left = (Math.round((10000 * box.x) / doc.width) / 100) + '%'
    el.style.top = (Math.round((10000 * box.y) / doc.height) / 100) + '%'
    el.style.width = (Math.round((10000 * box.width) / doc.width) / 100) + '%'
    el.style.height = (Math.round((10000 * box.height) / doc.height) / 100) + '%'
  }

  /** Huzas kozben a SZAMOK is latszanak: a felhasznalonak ne kelljen kitalalnia,
   *  hova kerult az elem. Ugyanazok az ertekek, mint a szerkeszto urlapon. */
  function canvasDragLive(box) {
    var el = document.getElementById('wbCanLive')
    if (!el) return
    var text = t('workbench.canvas.drag_live', { x: box.x, y: box.y, w: box.width, h: box.height })
    if ('textContent' in el) el.textContent = text
  }

  /** A segedvonalak kirajzolasa huzas kozben (csak a ket vonal stilusa
   *  valtozik, a vaszon nem rajzolodik ujra). */
  function canvasGuides(guides, doc) {
    ;['x', 'y'].forEach(function (axis) {
      var el = document.getElementById(axis === 'x' ? 'wbCanGuideX' : 'wbCanGuideY')
      if (!el) return
      var g = null
      guides.forEach(function (x) { if (x.axis === axis) g = x })
      if (!g) { el.hidden = true; return }
      el.hidden = false
      if (el.style) {
        if (axis === 'x') el.style.left = (Math.round((10000 * g.at) / doc.width) / 100) + '%'
        else el.style.top = (Math.round((10000 * g.at) / doc.height) / 100) + '%'
      }
    })
  }

  function canvasDragHighlight(stage, boxEl) {
    if (!stage || typeof stage.querySelectorAll !== 'function') return
    var all = stage.querySelectorAll('[data-wb-box]')
    for (var i = 0; i < all.length; i++) {
      all[i].className = 'wb-can-box' + (all[i] === boxEl ? ' wb-can-box-sel' : '')
    }
  }

  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || WB.canvasBusy || archived()) return
    var target = e.target
    if (!target || typeof target.closest !== 'function') return
    var boxEl = target.closest('[data-wb-box]')
    if (!boxEl) return
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc) return
    var o = canvasObject(boxEl.getAttribute('data-wb-box'))
    if (!o) return
    var stage = target.closest('[data-wb-stage]')
    var rect = stage && typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null
    // Meret nelkul nem tudunk kepernyo-pixelbol vaszon-egyseget szamolni.
    // Ilyenkor INKABB nem mozdulunk, mint hogy talalgassunk: az urlap
    // (X, Y, Szelesseg, Magassag) tovabbra is ott van.
    if (!rect || !rect.width || !rect.height) return
    var gripEl = target.closest('[data-wb-grip]')
    if (gripEl && gripEl.getAttribute('data-wb-grip') === 'rot' && typeof boxEl.getBoundingClientRect === 'function') {
      // Forgatas: a doboz kozepe korul; a kezdo szog a mutato iranya a kozepponthoz kepest.
      var br = boxEl.getBoundingClientRect()
      var rcx = br.left + br.width / 2
      var rcy = br.top + br.height / 2
      canvasDrag = {
        id: o.id, mode: 'rot', el: boxEl, doc: doc, moved: false, startX: e.clientX, startY: e.clientY,
        cx: rcx, cy: rcy, a0: Math.atan2(e.clientY - rcy, e.clientX - rcx), rot0: o.rotation || 0, rot: o.rotation || 0,
        from: { x: o.x, y: o.y, width: o.width, height: o.height }, box: { x: o.x, y: o.y, width: o.width, height: o.height },
      }
      WB.canvasSel = o.id
      if (typeof gripEl.setPointerCapture === 'function' && e.pointerId != null) {
        try { gripEl.setPointerCapture(e.pointerId) } catch (err) { /* nem all meg tole a forgatas */ }
      }
      if (typeof e.preventDefault === 'function') e.preventDefault()
      return
    }
    var from = { x: o.x, y: o.y, width: o.width, height: o.height }
    canvasDrag = {
      id: o.id,
      mode: gripEl ? gripEl.getAttribute('data-wb-grip') : 'move',
      from: from,
      box: from,
      startX: e.clientX,
      startY: e.clientY,
      kx: doc.width / rect.width,
      ky: doc.height / rect.height,
      doc: doc,
      el: boxEl,
      moved: false,
      // A tobbi elem (a sajat csoportja nelkul) -- ezekhez illeszkedik.
      others: canvasObjects().filter(function (x) { return x.id !== o.id && !x.rotation }),
      rotated: !!o.rotation,
    }
    var wasSel = WB.canvasSel === o.id
    canvasDrag.wasSel = wasSel
    WB.canvasSel = o.id
    // Shift+kattintas: hozzaadja a kijeloleshez (vagy kiveszi) -- ahogy minden
    // rajzoloprogramban. Huzas ilyenkor nincs.
    if (e.shiftKey) {
      canvasDrag = null
      if (WB.canvasPick[o.id]) delete WB.canvasPick[o.id]
      else WB.canvasPick[o.id] = true
      if (typeof e.preventDefault === 'function') e.preventDefault()
      render()
      return
    }
    canvasDragHighlight(stage, boxEl)
    // A mutato "hozzaragad" a dobozhoz: ha a kez kifut a kepbol, a huzas akkor
    // sem szakad meg.
    if (typeof boxEl.setPointerCapture === 'function' && e.pointerId != null) {
      try { boxEl.setPointerCapture(e.pointerId) } catch (err) { /* nem all meg tole a huzas */ }
    }
    if (typeof e.preventDefault === 'function') e.preventDefault()
  })

  document.addEventListener('pointermove', function (e) {
    var d = canvasDrag
    if (!d) return
    var sx = e.clientX - d.startX
    var sy = e.clientY - d.startY
    if (d.mode === 'rot') {
      if (!d.moved && Math.abs(sx) < 3 && Math.abs(sy) < 3) return
      d.moved = true
      var deg = d.rot0 + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180) / Math.PI
      if (e.shiftKey) deg = Math.round(deg / 15) * 15
      deg = ((Math.round(deg) % 360) + 360) % 360
      d.rot = deg
      if (d.el && d.el.style) d.el.style.transform = 'rotate(' + deg + 'deg)'
      var live = document.getElementById('wbCanLive')
      if (live && 'textContent' in live) live.textContent = t('workbench.canvas.rot_live', { deg: deg })
      if (typeof e.preventDefault === 'function') e.preventDefault()
      return
    }
    // Par pixel meg nem huzas, hanem kattintas (kijelolés). Kulonben minden
    // erintes elmozditana az elemet.
    if (!d.moved && Math.abs(sx) < 3 && Math.abs(sy) < 3) return
    d.moved = true
    d.box = canvasDragBox(d.from, d.mode, sx * d.kx, sy * d.ky)
    // Illesztes (K-2.7). Az Alt lenyomva tartasa kikapcsolja erre a huzasra --
    // ugyanugy, mint a Figmaban. A tures 6 kepernyo-pixel, barmekkora a kep.
    // Forgatott elemnel nincs illesztes: a doboza nem az, amit a szem lat.
    var snapped = { box: d.box, guides: [] }
    if ((WB.canvasSnap || WB.canvasGrid) && !e.altKey && !d.rotated) {
      snapped = canvasSnapBox(d.box, d.mode, d.others, d.doc, { tol: 6 * d.kx, guides: WB.canvasSnap, grid: WB.canvasGrid })
      d.box = snapped.box
    }
    canvasGuides(snapped.guides, d.doc)
    canvasDragStyle(d.el, d.box, d.doc)
    canvasDragLive(d.box)
    if (typeof e.preventDefault === 'function') e.preventDefault()
  })

  /** A huzas vege. `commit === false` (megszakitas) eseten NEM mentunk: a
   *  kovetkezo rajzolas visszateszi az elemet oda, ahol a szerveren all. */
  function canvasDragFinish(commit) {
    var d = canvasDrag
    if (!d) return
    canvasDrag = null
    if (d.mode === 'rot') {
      if (!commit || !d.moved || d.rot === d.rot0) { render(); return }
      canvasOps([{ op: 'rotate', id: d.id, angle: d.rot }])
      return
    }
    canvasGuides([], d.doc)
    var b = d.box
    var f = d.from
    var same = b.x === f.x && b.y === f.y && b.width === f.width && b.height === f.height
    // Egyszeru kattintas egy MAR kijelolt elemen: nincs mit ujrarajzolni -- es ne is rajzoljuk, mert a
    // dupla kattintas (helyben szerkesztes) csak akkor jon letre, ha az elem a ket kattintas kozott
    // nem cserelodik ki.
    if (commit && !d.moved && d.wasSel) return
    if (!commit || !d.moved || same) { render(); return }
    canvasOps([{ op: 'update', id: d.id, patch: { x: b.x, y: b.y, width: b.width, height: b.height } }])
  }

  document.addEventListener('pointerup', function () { canvasDragFinish(true) })
  document.addEventListener('pointercancel', function () { canvasDragFinish(false) })

  // ---- the video timeline: select / reorder / trim by pointer (no render while dragging) ------------
  var tlDrag = null

  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var blk = e.target.closest('[data-wb-tl]')
    if (!blk || WB.vtBusy || WB.vtRender) return
    var h = e.target.closest('[data-wb-tlh]')
    var rect = blk.getBoundingClientRect()
    var c = null
    var clips = (vtDoc() || {}).clips || []
    for (var i = 0; i < clips.length; i += 1) if (clips[i].id === blk.getAttribute('data-wb-tl')) c = clips[i]
    if (!c || !rect.width) return
    tlDrag = { id: c.id, el: blk, kind: h ? h.getAttribute('data-wb-tlh') : 'move', x0: e.clientX, moved: false, clip: c, secPerPx: Math.max(0.1, c.end - c.start) / rect.width, dx: 0 }
    if (typeof blk.setPointerCapture === 'function') { try { blk.setPointerCapture(e.pointerId) } catch (_e) { /* synthetic event */ } }
  })

  document.addEventListener('pointermove', function (e) {
    if (!tlDrag) return
    var d = tlDrag
    d.dx = e.clientX - d.x0
    if (!d.moved && Math.abs(d.dx) < 4) return
    d.moved = true
    if (archived()) return
    if (d.kind === 'move') {
      d.el.style.transform = 'translateX(' + d.dx + 'px)'
      d.el.style.zIndex = '3'
      d.el.classList.add('wb-tl-drag')
    } else {
      var r = d.el.getBoundingClientRect()
      // The visual feedback only: the block grows or shrinks with the handle.
      var base = d.el.getAttribute('data-w0') || String(r.width)
      d.el.setAttribute('data-w0', base)
      var w = Math.max(24, Number(base) + (d.kind === 'r' ? d.dx : -d.dx))
      d.el.style.width = w + 'px'
      d.el.style.flex = 'none'
    }
  })

  function tlFinish() {
    var d = tlDrag
    tlDrag = null
    if (!d) return
    d.el.style.transform = ''
    d.el.classList.remove('wb-tl-drag')
    if (!d.moved) {
      WB.vtSel = d.id
      render()
      return
    }
    if (archived()) { render(); return }
    if (d.kind === 'move') {
      var from = -1
      var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-wb-tl]'))
      var mid = d.el.getBoundingClientRect().left + d.el.getBoundingClientRect().width / 2 + d.dx
      var to = 0
      blocks.forEach(function (b, i) {
        if (b === d.el) { from = i; return }
        var r = b.getBoundingClientRect()
        if (r.left + r.width / 2 < mid) to += 1
      })
      WB.vtSel = d.id
      if (from < 0 || to === from) { render(); return }
      vtOps([{ op: 'moveClip', id: d.id, to: to + 1 }])
      return
    }
    var secs = Math.round(d.dx * d.secPerPx * 10) / 10
    WB.vtSel = d.id
    if (d.kind === 'l') {
      var ns = Math.max(0, Math.round((d.clip.start + secs) * 10) / 10)
      if (ns >= d.clip.end - 0.1 || ns === d.clip.start) { render(); return }
      vtOps([{ op: 'trimClip', id: d.id, start: ns }])
    } else {
      var ne = Math.round((d.clip.end + secs) * 10) / 10
      if (ne <= d.clip.start + 0.1 || ne === d.clip.end) { render(); return }
      vtOps([{ op: 'trimClip', id: d.id, end: ne }])
    }
  }
  document.addEventListener('pointerup', tlFinish)
  document.addEventListener('pointercancel', function () { if (tlDrag) { tlDrag.el.style.transform = ''; tlDrag = null; render() } })

  // ---- helyben szerkesztes a lapon (Boss, 2026-10-02, TG 7286/7319) ----------
  //
  // "A diaban helyben beirom a cimet, helyben betoltom a fotot, helyben forgatom, kicsinyitem,
  // nagyitom." Minden itteni muvelet UGYANAZT a vaszon-muveletet kuldi (`update`, `rotate`, `add`,
  // `scale`, `order`, `duplicate`, `remove`), amit a gombok es az agent is kuldene: egy allapot.

  WB.canvasEditId = null

  /** A lebego eszkoztar gombjai. */
  function canvasFloatOp(op) {
    var o = WB.canvasSel ? canvasObject(WB.canvasSel) : null
    if (!o || archived() || WB.canvasBusy) return
    if (op === 'smaller' || op === 'bigger' || op === 'rotate' || op === 'front' || op === 'back' || op === 'duplicate') canvasQuickOp(op, o.id)
    else if (op === 'remove') canvasRemoveObject(o.id)
    else if (op === 'bold') canvasOps([{ op: 'update', id: o.id, patch: { bold: !o.bold } }])
    else if (op === 'italic') canvasOps([{ op: 'update', id: o.id, patch: { italic: !o.italic } }])
    else if (op === 'alignleft') canvasOps([{ op: 'update', id: o.id, patch: { align: 'left' } }])
    else if (op === 'aligncenter') canvasOps([{ op: 'update', id: o.id, patch: { align: 'center' } }])
    else if (op === 'alignright') canvasOps([{ op: 'update', id: o.id, patch: { align: 'right' } }])
  }

  /** A colour from the floating toolbar -- its colour field or a brand colour button -- onto the selected element. */
  function canvasFloatColor(prop, hex) {
    var o = WB.canvasSel ? canvasObject(WB.canvasSel) : null
    if (!o || archived() || WB.canvasBusy || (prop !== 'color' && prop !== 'fill') || !hex) return
    var patch = {}
    patch[prop] = hex
    canvasOps([{ op: 'update', id: o.id, patch: patch }])
  }

  var CANVAS_CSS_FONT = { sans: 'system-ui, Arial, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, Consolas, monospace' }

  /** Szoveg szerkesztese HELYBEN: egy szovegmezo kerul az elem helyere, ugyanazzal a betumerettel es
   *  szinnel, mint amit a lapon latsz. Enter = uj sor, Ctrl+Enter vagy kattintas mellé = kesz, Esc = elvet. */
  function canvasEditText(id) {
    if (archived() || WB.canvasBusy || typeof document.querySelector !== 'function') return
    var o = canvasObject(id)
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!o || o.type !== 'text' || !doc) return
    var layer = document.querySelector('.wb-can-layer')
    if (!layer || typeof layer.getBoundingClientRect !== 'function' || typeof document.createElement !== 'function') return
    var rect = layer.getBoundingClientRect()
    // Meret nelkul nem tudjuk a betumeretet a lapra szamolni: inkabb nem nyitjuk meg.
    if (!rect.width) return
    WB.canvasSel = id
    WB.canvasEditId = id
    // NEM rajzoljuk ujra a lapot (a kep ujratoltodne): csak a lebego eszkoztar tunik el, amig irsz.
    var fl = typeof document.querySelector === 'function' ? document.querySelector('[data-wb-float]') : null
    if (fl && typeof fl.remove === 'function') fl.remove()
    var k = rect.width / doc.width
    var ta = document.createElement('textarea')
    ta.className = 'wb-can-edit'
    ta.value = o.text || ''
    ta.setAttribute('aria-label', t('workbench.canvas.edit_text_aria'))
    ta.setAttribute('data-wb-edit', id)
    ta.style.cssText = 'position:absolute;left:' + (Math.round((10000 * o.x) / doc.width) / 100) + '%;top:' + (Math.round((10000 * o.y) / doc.height) / 100) + '%;'
      + 'width:' + (Math.round((10000 * o.width) / doc.width) / 100) + '%;height:' + (Math.round((10000 * o.height) / doc.height) / 100) + '%;'
      + 'font-size:' + (o.fontSize * k) + 'px;line-height:1.25;color:' + (o.color || '#111') + ';text-align:' + (o.align || 'left') + ';'
      + 'font-weight:' + (o.bold ? '700' : '400') + ';font-style:' + (o.italic ? 'italic' : 'normal') + ';font-family:' + (CANVAS_CSS_FONT[o.font] || CANVAS_CSS_FONT.sans) + ';'
      + (o.rotation ? 'transform:rotate(' + o.rotation + 'deg);' : '')
    var done = false
    function finish(commit) {
      if (done) return
      done = true
      WB.canvasEditId = null
      var val = ta.value
      if (typeof ta.remove === 'function') ta.remove()
      if (commit && val.trim() && val !== (o.text || '')) canvasOps([{ op: 'update', id: id, patch: { text: val } }])
      else render()
    }
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true) }
      ev.stopPropagation()
    })
    ta.addEventListener('blur', function () { finish(true) })
    layer.appendChild(ta)
    if (typeof ta.focus === 'function') ta.focus()
    if (typeof ta.select === 'function') ta.select()
  }

  document.addEventListener('dblclick', function (e) {
    if (!WB.open || archived() || !e.target || typeof e.target.closest !== 'function') return
    var boxEl = e.target.closest('[data-wb-box]')
    if (!boxEl) return
    var o = canvasObject(boxEl.getAttribute('data-wb-box'))
    if (o && o.type === 'text') { if (typeof e.preventDefault === 'function') e.preventDefault(); canvasEditText(o.id) }
  })

  // Enter vagy F2 a kijelolt szoveg-dobozon: szerkesztes (billentyuvel is elerheto).
  document.addEventListener('keydown', function (e) {
    if (!WB.open || archived() || !e.target || typeof e.target.closest !== 'function') return
    if (e.key !== 'Enter' && e.key !== 'F2') return
    var boxEl = e.target.closest('[data-wb-box]')
    if (!boxEl) return
    var o = canvasObject(boxEl.getAttribute('data-wb-box'))
    if (o && o.type === 'text') { e.preventDefault(); canvasEditText(o.id) }
  })

  // A szinvalasztok (szoveg-szin, kitoltes): a valasztas elengedesekor megy a muvelet.
  document.addEventListener('change', function (e) {
    var el = e.target
    if (!el || typeof el.getAttribute !== 'function') return
    var a = el.getAttribute('data-wb-act')
    if (a !== 'can-float-color' && a !== 'can-float-fill') return
    canvasFloatColor(a === 'can-float-color' ? 'color' : 'fill', el.value)
  })

  /** Kep a lapra: egy fajl a lapra HUZVA vagy a vagolapbol beillesztve. A fajl a projekt mappajaba kerul
   *  (ott keresi a felhasznalo), a lapra pedig egy kep-elem, a leejtes helyen. */
  function canvasDropImage(file, clientX, clientY) {
    if (!file || !/^image\//.test(file.type || '')) { window.showToast(t('workbench.canvas.drop_not_image')); return }
    if (!WB.selectedId || WB.partBusy || WB.canvasBusy || archived()) return
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc) return
    var layer = typeof document.querySelector === 'function' ? document.querySelector('.wb-can-layer') : null
    var rect = layer && typeof layer.getBoundingClientRect === 'function' ? layer.getBoundingClientRect() : null
    var cx = doc.width / 2
    var cy = doc.height / 2
    if (rect && rect.width && clientX != null) {
      cx = ((clientX - rect.left) / rect.width) * doc.width
      cy = ((clientY - rect.top) / rect.height) * doc.height
    }
    function place(nw, nh) {
      var w = Math.round(doc.width * 0.4)
      var h = Math.round(w * (nh && nw ? nh / nw : 0.75))
      var maxH = Math.round(doc.height * 0.9)
      if (h > maxH) { w = Math.round(w * maxH / h); h = maxH }
      var x = Math.round(Math.min(Math.max(cx - w / 2, 0), Math.max(doc.width - w, 0)))
      var y = Math.round(Math.min(Math.max(cy - h / 2, 0), Math.max(doc.height - h, 0)))
      uploadAndPlace(file, { x: x, y: y, width: w, height: h })
    }
    var natural = function () { place(0, 0) }
    if (typeof Image === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
      var img = new Image()
      var u = URL.createObjectURL(file)
      img.onload = function () { try { URL.revokeObjectURL(u) } catch (_e) { /* mindegy */ } place(img.naturalWidth, img.naturalHeight) }
      img.onerror = function () { try { URL.revokeObjectURL(u) } catch (_e) { /* mindegy */ } natural() }
      img.src = u
    } else natural()
  }

  function uploadAndPlace(file, box) {
    WB.partBusy = true
    render()
    // A fajl a projekt mappajaba kerul, a rajz-elem pedig az utjara mutat. Itt NEM keszul uj verzio (nem
    // `new_version`): egy uj verzio a rajz mentetlen allapotat nem vinne magaval.
    var url = '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/parts/image'
      + '?name=' + encodeURIComponent(file.name || 'kep.png')
      + '&type=' + encodeURIComponent(file.type || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        WB.partBusy = false
        if (!res.ok || !data || !data.part || !data.part.asset_path) {
          render()
          window.showToast((data && data.message) || t('workbench.err.http', { status: res.status }))
          return
        }
        applyParts(data)
        canvasOps([{ op: 'add', object: { type: 'image', src: data.part.asset_path, x: box.x, y: box.y, width: box.width, height: box.height, fit: 'contain' } }])
      })
    }).catch(function () {
      WB.partBusy = false
      render()
      window.showToast(t('workbench.err.network'))
    })
  }

  document.addEventListener('dragover', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var stage = e.target.closest('[data-wb-stage]')
    if (!stage || !e.dataTransfer || !e.dataTransfer.types || (Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0 && Array.prototype.indexOf.call(e.dataTransfer.types, 'text/wb-image') < 0)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (stage.classList) stage.classList.add('wb-can-stage-drop')
  })
  document.addEventListener('dragleave', function (e) {
    var stage = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-wb-stage]') : null
    if (stage && stage.classList) stage.classList.remove('wb-can-stage-drop')
  })
  document.addEventListener('drop', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var stage = e.target.closest('[data-wb-stage]')
    if (!stage) return
    if (stage.classList) stage.classList.remove('wb-can-stage-drop')
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if (!f) {
      var psrc = ''
      try { psrc = (e.dataTransfer && e.dataTransfer.getData('text/wb-image')) || '' } catch (_e) { psrc = '' }
      if (psrc) { e.preventDefault(); e.stopImmediatePropagation(); frAddImage(psrc, e.clientX, e.clientY) }
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    canvasDropImage(f, e.clientX, e.clientY)
  })

  // Beillesztes (Ctrl+V): a vagolapon levo kep a lap kozepere kerul -- csak ha a lap latszik es nem
  // szovegmezo van fokuszban.
  document.addEventListener('paste', function (e) {
    if (!WB.open || archived() || typeof document.querySelector !== 'function' || !document.querySelector('[data-wb-stage]')) return
    var tg = e.target
    if (tg && (tg.tagName === 'TEXTAREA' || tg.tagName === 'INPUT')) return
    var items = e.clipboardData && e.clipboardData.items
    if (!items) return
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type || '')) {
        var f = items[i].getAsFile()
        if (f) { e.preventDefault(); e.stopImmediatePropagation(); canvasDropImage(f, null, null); return }
      }
    }
  })

  // Kattintas az ures lapra: nincs kijeloles (a lebego eszkoztar eltunik).
  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || !WB.canvasSel || !e.target || typeof e.target.closest !== 'function') return
    var t0 = e.target
    if (t0.closest('[data-wb-box]') || t0.closest('[data-wb-float]') || t0.closest('textarea')) return
    if (t0.closest('[data-wb-stage]')) { WB.canvasSel = null; render() }
  })

  // Az Egyszeru nezet kerete: nagyitas-csuszka, feltoltes a panelrol, kep huzasa a panelrol a lapra.
  document.addEventListener('input', function (e) {
    if (!e.target || e.target.id !== 'wbFrZoom') return
    var v = Number(e.target.value) || 100
    WB.frZoom = v
    writePref('wb.fr.zoom', String(v))
    var sc = typeof document.querySelector === 'function' ? document.querySelector('.wb-fr-scroll') : null
    if (sc && sc.style && typeof sc.style.setProperty === 'function') sc.style.setProperty('--wb-zoom', String(v / 100))
    var lbl = typeof document.querySelector === 'function' ? document.querySelector('.wb-fr-zoomval') : null
    if (lbl && 'textContent' in lbl) lbl.textContent = v + '%'
  })
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'wbFrUpload') return
    var f = e.target.files && e.target.files[0]
    if (f) canvasDropImage(f, null, null)
    try { e.target.value = '' } catch (_e) { /* regi bongeszo: nem baj */ }
  })
  document.addEventListener('dragstart', function (e) {
    var th = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-wb-act="fr-add-image"]') : null
    if (th && e.dataTransfer) { try { e.dataTransfer.setData('text/wb-image', th.getAttribute('data-wb-src') || ''); e.dataTransfer.effectAllowed = 'copy' } catch (_e) { /* nem baj */ } }
  })

  // TG 1854: the overview's card rows open with Enter/Space too, not only a click.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || (e.key !== 'Enter' && e.key !== ' ') || !e.target || typeof e.target.closest !== 'function') return
    var row = e.target.closest('[data-wb-act="card-open"]')
    if (!row) return
    e.preventDefault()
    openCard(row.getAttribute('data-wb-card'))
  })

  // Nyilbillentyuk: eger nelkul is mozgathato az elem (Shift = nagyobb lepes).
  // Ez ugyanaz a `move` muvelet, amit az agent is kuldene.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || WB.canvasBusy || archived() || !e.target) return
    if (typeof e.target.closest !== 'function') return
    var boxEl = e.target.closest('[data-wb-box]')
    if (!boxEl) return
    var step = e.shiftKey ? 50 : 10
    var dx = 0
    var dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step
    else return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    WB.canvasSel = boxEl.getAttribute('data-wb-box')
    canvasOps([{ op: 'move', id: WB.canvasSel, dx: dx, dy: dy }])
  })

  // Ctrl+Z / Ctrl+Y (Macen Cmd, es a Cmd+Shift+Z is ujra) a rajzon (K-2.1).
  // Szovegmezoben NEM: ott a bongeszo sajat visszavonasa a helyes (a felig
  // begepelt szoveg), nem a rajz utolso lepese.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !(e.ctrlKey || e.metaKey) || e.altKey) return
    var k = String(e.key || '').toLowerCase()
    if (k !== 'z' && k !== 'y' && k !== 'c' && k !== 'v' && k !== 'd') return
    var c = WB.canvas
    if (!c || !c.exists || c.current === false || !WB.selectedId) return
    var tg = e.target
    var tag = tg && tg.tagName ? String(tg.tagName).toUpperCase() : ''
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (tg && tg.isContentEditable)) return
    // Csak ha a rajz lathato: mas szerkesztonel a Ctrl+Z nem a rajzrol szol.
    var el = root()
    if (!el || String(el.innerHTML || '').indexOf('wb-can-tools') < 0) return
    if (k === 'c' || k === 'v' || k === 'd') {
      // Masolas (K-2.5): Ctrl+C a kijelolt elemet jegyzi meg, Ctrl+V masolatot
      // tesz le belole (akarhanyszor), Ctrl+D rogton duplikal. Kijelolt elem
      // nelkul a bongeszo sajat masolasa marad (pl. egy kijelolt szovegre).
      var sel = WB.canvasSel && canvasObject(WB.canvasSel) ? WB.canvasSel : null
      if (k === 'c') {
        if (!sel) return
        if (typeof window.getSelection === 'function' && String(window.getSelection() || '')) return
        WB.canvasClip = sel
        if (typeof e.preventDefault === 'function') e.preventDefault()
        return
      }
      var src = k === 'v' ? WB.canvasClip : sel
      if (!src || !canvasObject(src) || archived()) return
      if (typeof e.preventDefault === 'function') e.preventDefault()
      canvasOps([{ op: 'duplicate', id: src }])
      return
    }
    if (typeof e.preventDefault === 'function') e.preventDefault()
    canvasStep(k === 'y' || e.shiftKey ? 'redo' : 'undo')
  })

  // A bevitel erteket allapotban tartjuk: a chat-sav ujrarajzolasa (streameles
  // kozben soronkent) kulonben eltorolne a felig beirt mondatot.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbChatInput') WB.chatDraft = e.target.value
    if (e.target.id === 'wbIntakeText') WB.intakeDraft = e.target.value
    if (e.target.id === 'wbIntakeName') WB.intakeName = e.target.value
    if (e.target.id === 'wbIntakePlatform') WB.intakePlatform = e.target.value
    if (e.target.id === 'wbCanAiText' && WB.canvasAi) WB.canvasAi.text = e.target.value
    if (e.target.id === 'wbRedactTerms' && WB.redact) WB.redact.terms = e.target.value
    if (/^wbBrand/.test(String(e.target.id || '')) && WB.brandOpen) brandSyncDraft()
  })

  // Enter kuld, Shift+Enter uj sort ir. (Telefonon a gomb marad a fo ut.)
  // A szerkeszto tartalma az ALLAPOTBAN el, nem csak a mezoben: egy kozben
  // erkezo ujrarajzolas (attekinto, elonezet, lista) kulonben visszairna az
  // eredeti szoveget, es a begepelt munka elveszne.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbCmpSlider' && WB.compare) {
      var pos = Math.max(0, Math.min(100, Number(e.target.value) || 0))
      WB.compare.pos = pos
      // Csak a ket stilus valtozik -- a kepet nem rajzoljuk ujra huzas kozben.
      var top = document.getElementById('wbCmpTop')
      if (top && top.style) top.style.clipPath = 'inset(0 ' + (100 - pos) + '% 0 0)'
      var line = document.getElementById('wbCmpLine')
      if (line && line.style) line.style.left = pos + '%'
      return
    }
    if ((e.target.id === 'wbSendTo' || e.target.id === 'wbSendSubject' || e.target.id === 'wbSendMessage') && WB.selectedId) {
      var ss = sendState()
      if (!ss || ss.result) { ss = { itemId: WB.selectedId, draft: {} }; WB.send = ss }
      ss.draft = readSendDraft()
      return
    }
    if (WB.table && tableCellInput(e.target.id, e.target.value)) return
    if (WB.img && /^wbImg/.test(String(e.target.id || '')) && imgField(e.target.id, e.target)) return
    if (e.target.id === 'wbTextEdit' && WB.textEdit) { WB.textEdit.value = e.target.value; updateMdLive(e.target.value); trMarkStale() }
    else if (e.target.id === 'wbPartText' && WB.partEdit) WB.partDraft = { id: WB.partEdit, value: e.target.value }
  })

  // Kozossegi poszt: a kivagas huzasa a kepkereten. Csak a focus szazalekot
  // allitja (object-position), rajzolas nelkul -- a letoltes ugyanezt hasznalja.
  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || !WB.post || !e.target || !e.target.closest) return
    var frame = e.target.closest('[data-wb-post-frame]')
    if (!frame) return
    var img = frame.querySelector('img')
    if (!img) return
    e.preventDefault()
    var st = WB.post
    var sx = e.clientX, sy = e.clientY, fx0 = st.fx, fy0 = st.fy
    var rect = frame.getBoundingClientRect()
    function move(ev) {
      // Huzas jobbra = a kep jobbra megy = a kivagas balra (kisebb x).
      st.fx = Math.max(0, Math.min(100, fx0 - (ev.clientX - sx) / Math.max(1, rect.width) * 100))
      st.fy = Math.max(0, Math.min(100, fy0 - (ev.clientY - sy) / Math.max(1, rect.height) * 100))
      img.style.objectPosition = st.fx + '% ' + st.fy + '%'
    }
    function up() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  })

  // Ctrl+S / Cmd+S a szerkesztoben: mentes (uj verzio) -- a bongeszo sajat
  // "oldal mentese" ablaka helyett, ami itt senkinek nem kell.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 's') return
    var id = e.target.id
    if (/^wbCell_/.test(String(id || '')) && WB.table) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      saveTable()
      return
    }
    if (id !== 'wbTextEdit' && id !== 'wbPartText' && id !== 'wbPartNewText') return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    if (id === 'wbTextEdit') saveTextEdit()
    else if (id === 'wbPartText' && WB.partEdit) savePart(WB.partEdit)
    else if (id === 'wbPartNewText') addTextPart()
  })

  // Kepszerkeszto: kattintas az EREDMENYEN = a hatter egy pontja (arasztas innen).
  document.addEventListener('click', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var pick = e.target.closest('[data-wb-img-pick]')
    var st = imgState()
    if (!pick || !st || !st.bg.pick || typeof pick.getBoundingClientRect !== 'function') return
    var rect = pick.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    st.bg.seeds.push({
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    })
    st.dirty = true
    render()
    imgRefresh(false)
  })

  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var h = e.target.closest('[data-wb-crop]')
    var st = imgState()
    var stage = document.getElementById('wbImgStage')
    if (!h || !st || !st.crop || !stage || typeof stage.getBoundingClientRect !== 'function') return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    imgDrag = {
      mode: h.getAttribute('data-wb-crop'), x0: e.clientX, y0: e.clientY, rect: stage.getBoundingClientRect(),
      crop: { x: st.crop.x, y: st.crop.y, w: st.crop.w, h: st.crop.h }, last: null,
    }
    if (h.setPointerCapture && e.pointerId != null) { try { h.setPointerCapture(e.pointerId) } catch (_e) { /* nem baj */ } }
  })

  document.addEventListener('pointermove', function (e) {
    if (!imgDrag) return
    var st = imgState()
    if (!st) { imgDrag = null; return }
    var c = imgDragApply(imgDrag, e.clientX, e.clientY)
    if (!c) return
    imgDrag.last = c
    var box = document.querySelector('[data-wb-crop="move"]')
    var saved = st.crop
    st.crop = c
    if (box && box.setAttribute) box.setAttribute('style', imgCropStyle(st))
    st.crop = saved
  })

  function imgDragEnd(commit) {
    if (!imgDrag) return
    var st = imgState()
    var c = imgDrag.last
    imgDrag = null
    if (!st || !c || !commit) { render(); return }
    st.crop = c
    st.aspect = IMG_ASPECTS[st.aspect] ? st.aspect : 'free'
    st.outW = c.w
    st.bg.seeds = []
    st.dirty = true
    render()
    imgRefresh(false)
  }
  document.addEventListener('pointerup', function () { imgDragEnd(true) })
  document.addEventListener('pointercancel', function () { imgDragEnd(false) })

  // Tablazat: Enter = a lenti cella (mint az Excelben), Shift+Enter = a fenti.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || !WB.table || e.key !== 'Enter') return
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(e.target.id || ''))
    if (!m) return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    var sh = tableSheet()
    var r = Number(m[1]) + (e.shiftKey ? -1 : 1)
    if (!sh || r < 0 || r >= sh.rows.length) return
    WB.table.sel = { r: r, c: Number(m[2]) }
    var next = document.getElementById('wbCell_' + r + '_' + m[2])
    if (!next) { WB.table.page = Math.floor(r / TABLE_PAGE); render(); next = document.getElementById('wbCell_' + r + '_' + m[2]) }
    if (next && typeof next.focus === 'function') next.focus()
  })

  document.addEventListener('focusin', function (e) {
    if (!WB.open || !WB.table || !e.target) return
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(e.target.id || ''))
    if (m) WB.table.sel = { r: Number(m[1]), c: Number(m[2]) }
  })

  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || e.target.id !== 'wbChatInput') return
    if (e.key === 'Enter' && !e.shiftKey) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      WB.chatDraft = e.target.value
      if (WB.dict) dictStop()
      sendChat()
    }
  })

  document.addEventListener('change', function (e) {
    if (!WB.open || !e.target) return
    if (WB.img && /^wbImg(CapPos|CapColor|CapBand)$/.test(String(e.target.id || '')) && imgField(e.target.id, e.target)) return
    if (e.target.id === 'wbPostPlatform') { postState().platform = postPlatform(e.target.value).id; postState().more = false; render(); return }
    if (e.target.id === 'wbCanPlatform') { WB.canvasPlatformPick = e.target.value; render(); return }
    if (e.target.id === 'wbSwitch') {
      selectItem(e.target.value)
      return
    }
    // MELLEKLETEK szamozasa (#441, K-1.18): a szerver a szovegbeli hivatkozasokat is atirja.
    if (e.target.id === 'wbAnnexScheme') { outlineCall('PATCH', '/settings', { annex_scheme: e.target.value }); return }
    if (e.target.id === 'wbAnnexMode') { outlineCall('PATCH', '/settings', { annex_mode: e.target.value }); return }
    // CELBIROSAG-PROFIL (#441, K-1.36)
    if (e.target.id === 'wbCourtProfile') { courtCall('PUT', '', { profile_id: e.target.value || null }); return }
    if (e.target.id === 'wbCourtMaxAge') { courtCall('PUT', '/settings', { max_age_days: Number(e.target.value) }, function () { window.showToast(t('workbench.court.settings_saved')) }); return }
    if (e.target.id === 'wbAnnexPrefix') {
      var px = String(e.target.value || '').trim().toUpperCase()
      if (/^[A-Z]{1,2}$/.test(px)) outlineCall('PATCH', '/settings', { annex_prefix: px })
      else window.showToast(t('workbench.annex.prefix_bad'))
      return
    }
    if ((e.target.id === 'wbCmpLeft' || e.target.id === 'wbCmpRight') && WB.compare) {
      if (e.target.id === 'wbCmpLeft') WB.compare.left = e.target.value
      else WB.compare.right = e.target.value
      render()
      loadCompareSide(e.target.value)
      return
    }
    if (e.target.id === 'wbUploadNew') {
      var picked = e.target.files
      if (picked && picked.length) uploadFiles(picked, 'new')
      try { e.target.value = '' } catch (_e) { /* regi bongeszo: nem baj */ }
      return
    }
    if (e.target.id === 'wbAssetUpload' || e.target.id === 'wbChatAssetUpload') {
      var att = e.target.files
      if (att && att.length) uploadFiles(att, 'assets')
      try { e.target.value = '' } catch (_e) { /* regi bongeszo: nem baj */ }
      return
    }
    if (e.target.id === 'wbSharedUpload') {
      var sf = e.target.files
      if (sf && sf.length) uploadShared(sf)
      try { e.target.value = '' } catch (_e) { /* regi bongeszo: nem baj */ }
      return
    }
    if (e.target.id === 'wbDocUpload') {
      var docs = e.target.files
      if (docs && docs.length) uploadDocumentVersion(docs[0])
      return
    }
    if (e.target.id === 'wbPartImage') {
      var files = e.target.files
      if (files && files.length) uploadImagePart(files[0])
      return
    }
    // Verzio-valaszto az elonezethez: a REGI verziot is meg lehet nezni.
    if (e.target.id === 'wbPreviewVersion' && WB.selectedId) {
      WB.previewVersion = e.target.value || null
      loadPreview(WB.selectedId, WB.previewVersion)
    }
  })

  // Item rows can be dragged onto a folder row (files the item into it).
  document.addEventListener('dragstart', function (e) {
    if (!WB.open || !e.target || !e.target.closest) return
    var row = e.target.closest('[data-wb-drag-item]')
    if (!row || !e.dataTransfer) return
    WB.dragItem = row.getAttribute('data-wb-drag-item')
    try { e.dataTransfer.setData('text/x-wb-item', WB.dragItem); e.dataTransfer.effectAllowed = 'move' } catch (_e) { /* nem baj */ }
  })
  document.addEventListener('dragend', function () { WB.dragItem = null })
  document.addEventListener('dragover', function (e) {
    if (!WB.open || !WB.dragItem || !e.target || !e.target.closest) return
    if (e.target.closest('[data-wb-drop-folder]')) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move' } catch (_e) { /* nem baj */ } }
  })
  document.addEventListener('drop', function (e) {
    if (!WB.open || !WB.dragItem || !e.target || !e.target.closest) return
    var z = e.target.closest('[data-wb-drop-folder]')
    if (!z) return
    e.preventDefault()
    var id = WB.dragItem
    WB.dragItem = null
    moveItemToFolder(id, z.getAttribute('data-wb-drop-folder') || '\u0000box')
  })

  // Behuzas: a bongeszo alapbol MEGNYITNA a fajlt (elhagyva a Munkapadot) --
  // ezt csak a Munkapadon belul akadalyozzuk meg, mashol nem szolunk bele.
  document.addEventListener('dragover', function (e) {
    if (!WB.open || !hasFiles(e) || !inWorkbench(e)) return
    e.preventDefault()
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy' } catch (_e) { /* nem baj */ } }
    setDragging(true)
  })
  document.addEventListener('dragleave', function (e) {
    if (!WB.open) return
    // Csak ha tenyleg kiment a Munkapadrol (a gyerek-elemek kozott is jon dragleave).
    if (!e.relatedTarget || !inWorkbench({ target: e.relatedTarget })) setDragging(false)
  })
  document.addEventListener('drop', function (e) {
    if (!WB.open || !inWorkbench(e)) return
    setDragging(false)
    if (!hasFiles(e)) return
    e.preventDefault()
    uploadFiles(e.dataTransfer.files, dropTarget(e))
  })
  // Beillesztes (Ctrl+V): kepernyokep, masolt fajl. Szoveg beillesztesebe
  // nem szolunk bele -- csak ha a vagolapon FAJL van.
  document.addEventListener('paste', function (e) {
    if (!WB.open) return
    var files = e && e.clipboardData && e.clipboardData.files
    if (!files || !files.length) return
    e.preventDefault()
    var inChat = false
    try { inChat = !!(document.activeElement && document.activeElement.id === 'wbChatInput') } catch (_e) { inChat = false }
    uploadFiles(files, WB.selectedId && WB.detail ? (inChat ? 'assets' : 'item') : 'new')
  })

  // ---- dokumentum-lap: esemenyek (#462, 4. lepes) ---------------------------------------------

  function dpField(e) {
    return e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-wb-dp]') : null
  }

  document.addEventListener('click', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var act = e.target.closest('[data-wb-act]')
    var a = act ? act.getAttribute('data-wb-act') : ''
    if (WB.docMenu && (!a || a.indexOf('dp-') !== 0) && !e.target.closest('.wb-dp-menu')) { WB.docMenu = null; if (!a) render() }
    if (!a || a.indexOf('dp-') !== 0) return
    e.preventDefault()
    var sid = act.getAttribute('data-wb-sec') || ''
    var bid = act.getAttribute('data-wb-block') || ''
    if (a === 'dp-add') dpMenuOpen('add', bid, sid)
    else if (a === 'dp-handle') dpMenuOpen('handle', bid, sid)
    else if (a === 'dp-ins') dpInsert(sid, bid, act.getAttribute('data-wb-kind'))
    else if (a === 'dp-ins-section') dpInsertSection(sid)
    else if (a === 'dp-move') dpMoveStep(bid, Number(act.getAttribute('data-wb-dir')) || 0)
    else if (a === 'dp-del') dpDeleteBlock(bid)
    else if (a === 'dp-add-section') dpAddSection()
  })

  // Mentes: a mezobol kilepve. Az ujrarajzolas altal okozott "kilepes" nem szamit.
  document.addEventListener('focusout', function (e) {
    if (!WB.open || WB.rendering) return
    var el = dpField(e)
    if (!el || !el.isConnected) return
    var kind = el.getAttribute('data-wb-dp')
    dpSave(el).then(function (o) { if (o && kind === 'new') render() })
  })

  document.addEventListener('input', function (e) {
    if (!WB.open) return
    var el = dpField(e)
    if (el) dpKeepDraft(el)
  })

  document.addEventListener('keydown', function (e) {
    if (!WB.open || e.isComposing) return
    var el = dpField(e)
    if (!el) return
    var kind = el.getAttribute('data-wb-dp')
    var sid = el.getAttribute('data-wb-sec') || ''
    if (e.key === 'Escape') {
      delete WB.docDrafts[dpDraftKey(el)]
      if (kind === 'new') WB.docNew = null
      WB.docMenu = null
      if (typeof el.blur === 'function') { WB.rendering = true; el.blur(); WB.rendering = false }
      render()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      if (kind === 'sec') {
        // A cim Entere az elso sorra ugrik.
        dpSave(el).then(function () {
          var s = findSection(sid)
          var first = s && s.blocks && s.blocks[0]
          if (first) { var n = document.getElementById('wbDpB_' + first.id); if (n) n.focus() }
          else dpInsert(sid, '', 'paragraph')
        })
        return
      }
      var text = dpText(el)
      var curKind = el.getAttribute('data-wb-kind') || (kind === 'block' ? (findBlock(el.getAttribute('data-wb-block')) || {}).kind : '') || 'paragraph'
      if (!text) {
        // Ures sor + Enter: kilepes a sorbol (lista vege).
        if (kind === 'new') { WB.docNew = null; delete WB.docDrafts[dpDraftKey(el)]; WB.rendering = true; el.blur(); WB.rendering = false; render() }
        return
      }
      var bid = el.getAttribute('data-wb-block')
      var pos = Number(el.getAttribute('data-wb-pos')) || 0
      dpSave(el).then(function (o) {
        if (!o) return
        var after = bid
        if (kind === 'new') { var s2 = findSection(sid || (o.sections[o.sections.length - 1] || {}).id); after = s2 && s2.blocks[pos] ? s2.blocks[pos].id : '' ; sid = s2 ? s2.id : sid }
        dpInsert(sid, after, curKind === 'list' ? 'list' : 'paragraph')
      })
      return
    }
    if (e.key === 'Backspace' && !dpText(el) && (kind === 'block' || kind === 'new')) {
      e.preventDefault()
      if (kind === 'new') { WB.docNew = null; delete WB.docDrafts[dpDraftKey(el)]; WB.rendering = true; el.blur(); WB.rendering = false; render() }
      else dpDeleteBlock(el.getAttribute('data-wb-block'))
    }
  })

  // Beillesztes: mindig sima szoveg (a masolt formazas nem kerul a vazlatba).
  document.addEventListener('paste', function (e) {
    if (!WB.open) return
    var el = dpField(e)
    if (!el || !e.clipboardData) return
    var txt = e.clipboardData.getData('text/plain')
    if (!txt && e.clipboardData.files && e.clipboardData.files.length) return
    e.preventDefault()
    e.stopImmediatePropagation()
    try { document.execCommand('insertText', false, txt) } catch (_e) { el.textContent = (el.textContent || '') + txt }
  }, true)

  // --- huzas: a fogantyuval a blokk mas helyre vihet (akar masik fejezetbe is) ---

  document.addEventListener('dragstart', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var h = e.target.closest('[data-wb-act="dp-handle"]')
    if (!h || !e.dataTransfer) return
    WB.dpDrag = h.getAttribute('data-wb-block')
    try { e.dataTransfer.setData('text/wb-block', WB.dpDrag); e.dataTransfer.effectAllowed = 'move' } catch (_e) { /* nem baj */ }
    var row = h.closest('.wb-dp-row')
    if (row) { row.classList.add('wb-dp-dragging'); try { e.dataTransfer.setDragImage(row, 10, 10) } catch (_e) { /* nem baj */ } }
  })

  function dpDropPoint(e) {
    var t0 = e.target && typeof e.target.closest === 'function' ? e.target : null
    if (!t0) return null
    var row = t0.closest('[data-wb-row]')
    var box = t0.closest('[data-wb-secbox]')
    if (!box) return null
    var sid = box.getAttribute('data-wb-secbox')
    var sec = findSection(sid)
    if (!sec) return null
    var list = (sec.blocks || []).filter(function (b) { return b.id !== WB.dpDrag })
    if (!row) return { sid: sid, pos: e.clientY < box.getBoundingClientRect().top + 60 ? 0 : list.length, el: box, after: false }
    var rid = row.getAttribute('data-wb-row')
    var r = row.getBoundingClientRect()
    var after = e.clientY > r.top + r.height / 2
    var idx = 0
    list.forEach(function (b, i) { if (b.id === rid) idx = i })
    if (rid === WB.dpDrag) return { sid: sid, pos: -1, el: row, after: false }
    return { sid: sid, pos: idx + (after ? 1 : 0), el: row, after: after }
  }

  function dpClearMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.wb-dp-drop-before,.wb-dp-drop-after'), function (n) { n.classList.remove('wb-dp-drop-before', 'wb-dp-drop-after') })
  }

  document.addEventListener('dragover', function (e) {
    if (!WB.open || !WB.dpDrag) return
    var p = dpDropPoint(e)
    dpClearMarks()
    if (!p || p.pos < 0) return
    e.preventDefault()
    e.stopImmediatePropagation()
    try { e.dataTransfer.dropEffect = 'move' } catch (_e) { /* nem baj */ }
    p.el.classList.add(p.after ? 'wb-dp-drop-after' : 'wb-dp-drop-before')
  }, true)

  document.addEventListener('drop', function (e) {
    if (!WB.open || !WB.dpDrag) return
    var bid = WB.dpDrag
    var p = dpDropPoint(e)
    WB.dpDrag = null
    dpClearMarks()
    if (!p || p.pos < 0) return
    e.preventDefault()
    e.stopImmediatePropagation()
    dpMoveBlock(bid, p.sid, p.pos)
  }, true)

  document.addEventListener('dragend', function () {
    WB.dpDrag = null
    dpClearMarks()
    Array.prototype.forEach.call(document.querySelectorAll('.wb-dp-dragging'), function (n) { n.classList.remove('wb-dp-dragging') })
  })

  document.addEventListener('submit', function (e) {
    if (!WB.open) return
    if (e.target && e.target.id === 'wbNewForm') { e.preventDefault(); create() }
    if (e.target && e.target.id === 'wbTextEditForm') { e.preventDefault(); saveTextEdit() }
    if (e.target && e.target.id === 'wbSendForm') { e.preventDefault(); sendRequest() }
    if (e.target && e.target.id === 'wbPartNewForm') { e.preventDefault(); addTextPart() }
    if (e.target && e.target.id === 'wbPartForm') { e.preventDefault(); savePart(WB.partEdit) }
    if (e.target && e.target.id === 'wbChatSetup') { e.preventDefault(); saveChatSetup() }
    if (e.target && e.target.id === 'wbSearchForm') { e.preventDefault(); runSearch() }
    if (e.target && e.target.id === 'wbBrandForm') { e.preventDefault(); saveBrand() }
    if (e.target && e.target.id === 'wbDecForm') { e.preventDefault(); addDecisionFromForm() }
    if (e.target && e.target.id === 'wbTdForm') { e.preventDefault(); addTodoFromForm() }
    if (e.target && e.target.id === 'wbDecEditForm') { e.preventDefault(); saveDecisionEdit() }
  })

  /** Alaphelyzet RAJZOLAS NELKUL: az oldal-betolto hivja, amikor a Projektek
   *  oldal ujraindul. A `closeWorkbench()` visszavinne a projekt-oldalra --
   *  itt eppen az a dolgunk, hogy ne szoljunk bele abba, amit a hivo rajzol. */
  function resetWorkbench() {
    if (WB.liveTimer) { clearTimeout(WB.liveTimer); WB.liveTimer = null }
    WB.open = false
    WB.projectId = null
    WB.project = null
    WB.items = null
    WB.detail = null
    WB.selectedId = null
    WB.formOpen = false
    WB.busy = false
    WB.error = null
    WB.panel = 'items'
    WB.chat = {}
    WB.chatStatus = null
    WB.chatStatusError = null
    WB.chatStreaming = false
    // Csak a bongeszo olvasasa all le: a valasz a szerveren vegigfut es
    // mentodik, visszaterve betoltjuk (a Leallitas gomb allitja le a szerveren).
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    WB.chatAbort = null
    if (WB.chatWatch) clearTimeout(WB.chatWatch.timer)
    WB.chatWatch = null
    stopChatActivityTicker()
    WB.chatDraft = ''
    WB.chatSetupOpen = false
    WB.chatSetupBusy = false
    WB.chatConfig = null
    WB.partEdit = null
    WB.partNewOpen = false
    WB.partBusy = false
    WB.preview = null
    WB.previewVersion = null
    WB.table = null
    WB.img = null
    WB.vid = null
    WB.vidStatus = null
    if (WB.dict) { try { WB.dict.rec.stop() } catch (_e) { /* mar all */ } }
    WB.dict = null
    ttsStop()
    WB.overview = null
    WB.overviewError = null
  }


  /** The same two-way choice for the Settings page (#462): a small card with
   *  two radio buttons. It writes the same per-browser value as the Workbench
   *  header switch, so the two always agree. */
  function viewSettingCard() {
    var card = document.createElement('div')
    card.className = 'settings-row wb-view-setting'
    card.style.cssText = 'padding:12px 0;border-top:1px solid var(--border)'
    var title = document.createElement('div')
    title.style.fontWeight = '600'
    title.textContent = t('workbench.view.label')
    var hint = document.createElement('div')
    hint.style.cssText = 'font-size:13px;color:var(--text-muted);margin:4px 0 8px'
    hint.textContent = t('workbench.view.hint')
    card.appendChild(title)
    card.appendChild(hint)
    ;['manual', 'simple'].forEach(function (v) {
      var label = document.createElement('label')
      label.style.cssText = 'display:block;margin:4px 0;cursor:pointer'
      var input = document.createElement('input')
      input.type = 'radio'
      input.name = 'wbViewSetting'
      input.value = v
      input.checked = WB.view === v
      input.addEventListener('change', function () { if (input.checked) setView(v) })
      label.appendChild(input)
      label.appendChild(document.createTextNode(' ' + t('workbench.view.' + v)))
      card.appendChild(label)
    })
    return card
  }

  window.MarvinWorkbench = {
    open: openWorkbench,
    viewSettingCard: viewSettingCard,
    close: closeWorkbench,
    reset: resetWorkbench,
    isOpen: function () { return WB.open },
    // #435: where the Workbench is (project, work item, panel), so an F5
    // brings back the same view; the Projects page saves and replays it.
    viewState: function () {
      if (!WB.open || !WB.projectId) return null
      return { projectId: WB.projectId, name: (WB.project && WB.project.name) || '', item: WB.selectedId || null, panel: WB.panel }
    },
    restore: function (st) {
      if (!st || typeof st.projectId !== 'string' || !st.projectId) return
      openWorkbench(st.projectId, typeof st.name === 'string' ? st.name : '')
      if (typeof st.item === 'string' && st.item) selectItem(st.item)
      if (typeof st.panel === 'string' && st.panel && st.panel !== WB.panel) { WB.panel = st.panel; render() }
    },
    // A kepszerkeszto tiszta (DOM nelkuli) lepesei -- a tesztek ezeket merik.
    _img: { floodKey: imgFloodKey, clampCrop: imgClampCrop, aspectCrop: imgAspectCrop, outSize: imgOutSize, rotSize: imgRotSize },
    _post: { crop: postCrop, maxBytes: POST_MAX_BYTES },
  }
})()

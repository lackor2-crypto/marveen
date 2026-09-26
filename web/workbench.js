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
    projectId: null,
    project: null,
    items: null,
    selectedId: null,
    detail: null,
    formOpen: false,
    busy: false,
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
    chatDraft: '',
    chatSetupOpen: false,
    chatSetupBusy: false,
    chatConfig: null,
    // --- reszek (vegyes munkadarab, 3. fazis) ---
    partEdit: null,
    partNewOpen: false,
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
    // Melyik elemet jelolte ki a felhasznalo a vasznon (huzogatas, kartya
    // d4b05d82). Csak a KIEMELEST jelenti, a szerkeszto urlapot nem nyitja.
    canvasSel: null,
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
    // --- osztott nezet (#406, 1. pont) ---
    // 'split' = bal oldalt a chat, jobb oldalt az ELO munkadarab (a szakmaban
    // bevett "chat + artifact" elrendezes); 'classic' = a harom panel, alatta a
    // chat. A valasztas a bongeszoben marad meg (nincs szerver-oldali allapot).
    layout: readLayout(),
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

  function saveLayout(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.layout', v) } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  function esc(s) { return window.escapeHtml(s == null ? '' : String(s)) }
  function escA(s) { return window.escapeAttr(s == null ? '' : String(s)) }
  function t(key, params) { return window.t(key, params || {}) }

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

  function load(projectId) {
    return api('GET', '/api/workbench/items?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.error = r.message; WB.items = []; render(); return }
      WB.error = null
      WB.project = r.data.project
      WB.items = r.data.items || []
      loadOverview(projectId)
      if (WB.selectedId && !WB.items.some(function (i) { return i.id === WB.selectedId })) WB.selectedId = null
      render()
    })
  }

  // ---- projekt-attekinto (#406, 2. pont) -------------------------------------

  function loadOverview(projectId) {
    return api('GET', '/api/workbench/overview?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.overviewError = r.message; render(); return }
      WB.overviewError = null
      WB.overview = (r.data && r.data.overview) || null
      render()
    })
  }

  function ovItemsHtml(items) {
    if (!items || !items.length) return ''
    return '<ul class="wb-ov-list">' + items.map(function (it) {
      return '<li><button type="button" class="wb-linklike" data-wb-item="' + escA(it.id) + '">' + esc(it.title) + '</button></li>'
    }).join('') + '</ul>'
  }

  function ovTile(cls, title, count, body) {
    return '<div class="wb-ov-tile ' + cls + '">'
      + '<div class="wb-ov-title">' + esc(title) + '</div>'
      + (count === null ? '' : '<div class="wb-ov-num">' + esc(String(count)) + '</div>')
      + body + '</div>'
  }

  /** Egy pillantasra: nyitott, jovahagyasra var, friss kesz, utoljara valtozott
   *  fajl. Minden szam MERT: ha egy forras nem valaszolt, azt kimondjuk, es a
   *  helyere nem irunk nullat. */
  function overviewHtml() {
    if (WB.overviewError) {
      return '<section class="wb-ov" aria-label="' + escA(t('workbench.ov.title')) + '">'
        + '<p class="wb-preview-bad">' + esc(t('workbench.ov.error', { message: WB.overviewError })) + '</p></section>'
    }
    var o = WB.overview
    if (!o) return '<section class="wb-ov"><p class="wb-muted">' + esc(t('workbench.ov.loading')) + '</p></section>'

    var cards = o.cards || {}
    var openBody = ovItemsHtml(o.open && o.open.items)
      + (cards.open === null
        ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.cards_unknown', { message: cards.error || '' })) + '</p>'
        : '<p class="wb-hint">' + esc(t('workbench.ov.cards_open', { n: cards.open || 0 })) + '</p>')
      + (o.open && o.open.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.open_none')) + '</p>')

    var ap = o.approvals || {}
    var reviewCount = (o.review && o.review.count) || 0
    var waitBody = ovItemsHtml(o.review && o.review.items)
      + (ap.count === null
        ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.approvals_unknown', { message: ap.error || '' })) + '</p>'
        : (ap.items && ap.items.length
          ? '<ul class="wb-ov-list">' + ap.items.map(function (a) { return '<li class="wb-ov-approval">' + esc(a.description) + '</li>' }).join('') + '</ul>'
          : ''))
      + (reviewCount || ap.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.wait_none')) + '</p>')
      + (ap.count ? '<p><button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.ov.goto_approvals')) + '</button></p>' : '')
    var waitCount = ap.count === null ? null : reviewCount + (ap.count || 0)

    var rd = o.recent_done || {}
    var doneBody = ovItemsHtml(rd.items)
      + (rd.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.done_none', { days: rd.days || 14 })) + '</p>')

    var lf = o.last_file
    var fileBody = lf
      ? '<p class="wb-ov-file">' + esc(lf.name) + '</p>'
        + '<p class="wb-hint">' + esc(t('workbench.ov.file_in', { when: when(lf.at) })) + ' '
        + '<button type="button" class="wb-linklike" data-wb-item="' + escA(lf.item_id) + '">' + esc(lf.item_title) + '</button></p>'
      : '<p class="wb-hint">' + esc(t('workbench.ov.file_none')) + '</p>'

    return '<section class="wb-ov" aria-label="' + escA(t('workbench.ov.title')) + '">'
      + ovTile('wb-ov-open', t('workbench.ov.open'), (o.open && o.open.count) || 0, openBody)
      + ovTile('wb-ov-wait' + (waitCount ? ' wb-ov-attn' : ''), t('workbench.ov.wait'), waitCount, waitBody)
      + ovTile('wb-ov-done', t('workbench.ov.done', { days: rd.days || 14 }), rd.count || 0, doneBody)
      + ovTile('wb-ov-file-tile', t('workbench.ov.file'), null, fileBody)
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
  }

  function loadDetail(id) {
    WB.detail = null
    WB.textEdit = null
    if (WB.compare && WB.compare.itemId !== id) WB.compare = null
    WB.preview = null
    WB.previewVersion = null
    WB.versionBusy = false
    WB.canvas = null
    WB.canvasError = null
    WB.canvasEdit = null
    // Mas munkadarab = mas vaszon: a kijeloles nem szivaroghat at.
    WB.canvasSel = null
    render()
    loadPreview(id, null)
    return api('GET', '/api/workbench/items/' + encodeURIComponent(id)).then(function (r) {
      if (WB.selectedId !== id) return
      if (!r.ok) { window.showToast(r.message); return }
      WB.detail = r.data
      render()
      // A rajz-fajta munkadarabnal magatol megnezzuk, van-e mar vaszon. Mas
      // fajtanal nem kerdezunk feleslegesen -- ott az elonezet mondja meg, ha
      // megis rajz all mogotte.
      if (canvasKind(r.data && r.data.item)) loadCanvas(id)
    })
  }

  // ---- panelek --------------------------------------------------------------

  /** Archivalt projektben nem keletkezik uj munkadarab -- a meglevok latszanak. */
  function archived() { return !!(WB.project && WB.project.archived) }

  function typeLabel(type) { return t('workbench.type.' + type) }
  function statusLabel(status) { return t('workbench.status.' + status) }

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
      body = '<ul class="wb-items">' + WB.items.map(function (it, i) {
        var on = it.id === WB.selectedId
        return '<li><button type="button" class="wb-item' + (on ? ' wb-item-active' : '') + '" data-wb-item="' + escA(it.id) + '"' + (on ? ' aria-current="true"' : '') + '>'
          + '<span class="wb-item-title">' + esc((i + 1) + '. ' + it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
          + '</button></li>'
      }).join('') + '</ul>'
    }
    return '<section class="wb-panel wb-panel-items' + (WB.panel === 'items' ? ' wb-panel-current' : '') + '" data-wb-panel-body="items" data-wb-drop="new">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.items')) + (WB.items && WB.items.length ? ' (' + WB.items.length + ')' : '') + '</h2>'
      + '<p class="wb-hint">' + esc(t(WB.layout === 'split' ? 'workbench.items.switch_hint_split' : 'workbench.items.switch_hint')) + '</p>'
      + body
      + (archived()
        ? '<p class="wb-hint">' + esc(t('workbench.archived_hint')) + '</p>'
        : (WB.formOpen ? newFormHtml() : '<button type="button" class="btn-primary wb-new-btn" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button>')
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

  /** `target === 'item'`: a megnyitott munkadarabba (kep -> resz, mas -> uj
   *  verzio). Kulonben minden fajlbol UJ munkadarab. Egymas utan megy, hogy a
   *  szamlalo pontos legyen, es egy hiba ne vigye el a tobbit. */
  function uploadFiles(fileList, target) {
    var files = []
    for (var i = 0; fileList && i < fileList.length; i++) if (fileList[i]) files.push(fileList[i])
    if (!files.length || WB.upload || !WB.projectId) return Promise.resolve()
    if (archived()) { window.showToast(t('workbench.archived_hint')); return Promise.resolve() }
    var intoItem = target === 'item' && WB.selectedId ? WB.selectedId : null
    var projectId = WB.projectId
    var lang = encodeURIComponent(window._lang || 'hu')
    WB.upload = { done: 0, total: files.length }
    render()
    var created = []
    var errors = []
    var chain = Promise.resolve()
    files.forEach(function (f) {
      chain = chain.then(function () {
        var name = encodeURIComponent(f.name || 'fajl')
        var type = encodeURIComponent(f.type || '')
        var url
        if (intoItem) {
          url = '/api/workbench/items/' + encodeURIComponent(intoItem)
            + (isImageFile(f) ? '/parts/image?new_version=1&' : '/document?')
            + 'name=' + name + '&type=' + type + '&lang=' + lang
        } else {
          url = '/api/workbench/items/upload?project=' + encodeURIComponent(projectId)
            + '&name=' + name + '&type=' + type + '&lang=' + lang
        }
        return postFile(url, f).then(function (r) {
          if (WB.upload) WB.upload.done++
          if (!r.ok) errors.push((f.name ? f.name + ': ' : '') + r.message)
          else if (!intoItem && r.data && r.data.item) created.push(r.data.item)
          if (WB.projectId === projectId) render()
        })
      })
    })
    return chain.then(function () {
      WB.upload = null
      if (WB.projectId !== projectId) return
      var ok = files.length - errors.length
      if (errors.length) window.showToast(errors.join(' \u2014 '))
      if (ok) {
        window.showToast(intoItem
          ? t('workbench.upload.done_item', { n: ok })
          : t('workbench.upload.done_new', { n: ok }))
      }
      if (intoItem) {
        if (WB.selectedId === intoItem) loadDetail(intoItem)
        load(projectId)
      } else {
        load(projectId)
        // Egy fajl = egy uj munkadarab: azt nyitjuk meg, hogy latsszon.
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
    return kind === 'item' && WB.selectedId ? 'item' : 'new'
  }

  function setDragging(on) {
    var el = root()
    var box = el && typeof el.querySelector === 'function' ? el.querySelector('.wb-root') : null
    if (box && box.classList) box.classList.toggle('wb-dragging', !!on)
  }

  function newFormHtml() {
    var types = ['document', 'image', 'graphic', 'video', 'note']
    return '<form class="wb-form" id="wbNewForm">'
      + '<label class="wb-label" for="wbNewTitle">' + esc(t('workbench.new.name_label')) + '</label>'
      + '<input class="wb-input" id="wbNewTitle" type="text" maxlength="200" placeholder="' + escA(t('workbench.new.name_placeholder')) + '" autocomplete="off">'
      + '<label class="wb-label" for="wbNewType">' + esc(t('workbench.new.type_label')) + '</label>'
      + '<select class="wb-input" id="wbNewType">'
      + types.map(function (ty) { return '<option value="' + escA(ty) + '">' + esc(typeLabel(ty)) + '</option>' }).join('')
      + '</select>'
      + '<p class="wb-hint">' + esc(t('workbench.new.type_hint')) + '</p>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="create"' + (WB.busy ? ' disabled' : '') + '>'
      + esc(WB.busy ? t('workbench.new.creating') : t('workbench.new.create')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="cancel-new">' + esc(t('common.cancel')) + '</button>'
      + '</div></form>'
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
        + escA(t('workbench.parts.text_placeholder')) + '"></textarea>'
        + '<div class="wb-form-actions">'
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
      return pdfSlotHtml(p.url)
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
      return pdfSlotHtml(p.url)
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
      return '<img class="wb-preview-image" src="' + escA(p.url) + '" alt="' + escA(p.name || t('workbench.preview.title')) + '">'
    }
    if (p.kind === 'video') {
      return '<video class="wb-preview-video" src="' + escA(p.url) + '" controls></video>'
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
        ? '<p><button type="button" class="btn-secondary" data-wb-act="text-edit">' + esc(t('workbench.edit.text_open')) + '</button></p>'
        : '')
        + '<pre class="wb-preview-text">' + esc(p.text || '') + '</pre>'
        + (p.truncated ? '<p class="wb-hint">' + esc(t('workbench.preview.truncated')) + '</p>' : '')
        + (!archived() && !current ? '<p class="wb-hint">' + esc(t('workbench.edit.text_old_version')) + '</p>' : '')
    }
    return ''
  }

  function textEditHtml() {
    var busy = WB.textEdit && WB.textEdit.busy
    return '<form class="wb-part-form" id="wbTextEditForm">'
      + '<label class="wb-label" for="wbTextEdit">' + esc(t('workbench.edit.text_label')) + '</label>'
      + '<textarea class="wb-input wb-part-input wb-text-edit" id="wbTextEdit" rows="16">' + esc(WB.textEdit.value) + '</textarea>'
      + '<div class="wb-form-actions">'
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
    WB.textEdit = { itemId: WB.selectedId, value: p.text || '', busy: false }
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
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/text', { text: WB.textEdit.value }).then(function (r) {
      if (WB.selectedId !== itemId || !WB.textEdit) return
      WB.textEdit.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.textEdit = null
      applyVersions(r.data)
      window.showToast(t('workbench.edit.text_saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  function previewHtml() {
    var p = WB.preview
    if (!p) return '<div class="wb-preview"><p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    // A sajat reszeit (szoveg + kep) a reszlista mutatja: nem duplazzuk meg.
    if (p.available && p.kind === 'parts') return ''
    var head = '<div class="wb-preview-head"><h4>' + esc(t('workbench.preview.title')) + '</h4>'
      + (p.name ? '<span class="wb-muted">' + esc(p.name) + '</span>' : '')
      + previewVersionPickerHtml() + '</div>'
    if (!p.available && p.reason === 'needs_conversion') {
      // NEM HIBA, hanem TEENDO: ebbol a dokumentumbol tudunk elonezetet
      // csinalni. A gomb mellett ott a letoltes is -- ha a gepen nincs meg a
      // LibreOffice, a felhasznalo attol meg hozzafer a sajat fajljahoz.
      return '<div class="wb-preview">' + head
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
    return '<div class="wb-preview">' + head + previewBodyHtml(p) + '</div>'
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
    return '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas.svg'
      + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
      // A kep a vaszonnal egyutt valtozik: a bongeszo gyorsitotara kulonben a
      // mentes ELOTTI kepet mutatna tovabb.
      + '&v=' + encodeURIComponent(WB.canvasStamp || '0')
      + (download ? '&download=1' : '')
  }

  function loadCanvas(itemId) {
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
      WB.canvas = {
        canvas: r.data.canvas, exists: true, rel: r.data.rel, name: r.data.name,
        version_id: r.data.version && r.data.version.id,
        version_no: r.data.version && r.data.version.version_no,
      }
      bumpCanvasStamp()
      if (WB.detail && r.data.item) { WB.detail.item = r.data.item }
      if (WB.detail && r.data.versions) { WB.detail.versions = r.data.versions }
      window.showToast(r.data.renamed
        ? t('workbench.canvas.renamed', { name: r.data.name })
        : (r.data.message || t('workbench.canvas.saved')))
      // A kozepso panel elonezete is a vaszonrol szol: ujra kell kerni -- de a
      // mostani kep a helyen marad, amig az uj meg nem jon (nincs villogas).
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  /** Az ures vaszon LETREHOZASA. Addig nincs fajl, amig a felhasznalo el nem
   *  kezdi -- es ez a gomb az, ami elkezdi. */
  function startCanvas() {
    if (!WB.selectedId || WB.canvasBusy) return
    WB.canvasBusy = true
    render()
    api('PUT', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas', {
      canvas: { width: 1080, height: 1080, background: '#ffffff', objects: [] },
    }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
        render()
        return
      }
      WB.canvasError = null
      WB.canvas = {
        canvas: r.data.canvas, exists: true, rel: r.data.rel, name: r.data.name,
        version_id: r.data.version && r.data.version.id,
        version_no: r.data.version && r.data.version.version_no,
      }
      bumpCanvasStamp()
      if (WB.detail && r.data.item) { WB.detail.item = r.data.item }
      if (WB.detail && r.data.versions) { WB.detail.versions = r.data.versions }
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
    }
    if (o.type === 'text') {
      patch.text = fieldValue('wbCanText', o.text)
      patch.fontSize = numField('wbCanFontSize', o.fontSize)
      patch.color = fieldValue('wbCanColor', o.color)
      patch.align = fieldValue('wbCanAlign', o.align)
      patch.bold = checked('wbCanBold')
      patch.italic = checked('wbCanItalic')
    } else if (o.type === 'rect') {
      patch.fill = fieldValue('wbCanFill', o.fill)
      patch.radius = numField('wbCanRadius', o.radius)
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

  /** A doboz helye SZAZALEKBAN: a kep kicsinyitve is jo helyen all, es nem
   *  kell megmernunk a kepernyon elfoglalt meretet a kirajzolashoz. */
  function canvasBoxStyle(box, doc) {
    var pct = function (v, total) { return (Math.round((10000 * v) / total) / 100) + '%' }
    return 'left:' + pct(box.x, doc.width) + ';top:' + pct(box.y, doc.height)
      + ';width:' + pct(box.width, doc.width) + ';height:' + pct(box.height, doc.height)
  }

  function canvasBoxHtml(o, doc) {
    return '<div class="wb-can-box' + (WB.canvasSel === o.id ? ' wb-can-box-sel' : '') + '"'
      + ' data-wb-box="' + escA(o.id) + '" tabindex="0" role="button"'
      + ' title="' + escA(canvasObjectLabel(o)) + '"'
      + ' aria-label="' + escA(t('workbench.canvas.drag_aria', { name: canvasObjectLabel(o) })) + '"'
      + ' style="' + escA(canvasBoxStyle(o, doc)) + '">'
      + CANVAS_GRIPS.map(function (g) {
        return '<span class="wb-can-grip wb-can-grip-' + g + '" data-wb-grip="' + g + '" aria-hidden="true"></span>'
      }).join('')
      + '</div>'
  }

  /** A vaszon elonezete: a szerver rajzolta kep + (ha lehet) a huzogato reteg.
   *  Amikor a reteg NEM jelenik meg, azt KIMONDJUK, es megmondjuk, mi helyette
   *  az ut -- a nema hianyzas a legrosszabb valasz. */
  function canvasStageHtml(name) {
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
    return '<div class="wb-can-stage" data-wb-stage="1">' + img
      + '<div class="wb-can-layer">'
      + canvasObjects().map(function (o) { return canvasBoxHtml(o, doc) }).join('')
      + '</div>'
      + '<span class="wb-can-live" id="wbCanLive" aria-live="polite"></span>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_hint')) + '</p>'
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
      + '</div>'
    var own = ''
    if (o.type === 'text') {
      own = '<label class="wb-label" for="wbCanText">' + esc(t('workbench.canvas.label_text')) + '</label>'
        + '<textarea class="wb-input" id="wbCanText" rows="3">' + esc(o.text || '') + '</textarea>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFontSize">' + esc(t('workbench.canvas.label_font_size')) + '</label>'
        + '<input class="wb-input" id="wbCanFontSize" type="number" min="4" max="1200" value="' + escA(String(o.fontSize)) + '">'
        + '<label class="wb-label" for="wbCanColor">' + esc(t('workbench.canvas.label_color')) + '</label>'
        + '<input class="wb-input" id="wbCanColor" type="color" value="' + escA(o.color || '#111111') + '">'
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
        + '<input class="wb-input" id="wbCanFill" type="color" value="' + escA(o.fill || '#dddddd') + '">'
        + '<label class="wb-label" for="wbCanRadius">' + esc(t('workbench.canvas.label_radius')) + '</label>'
        + '<input class="wb-input" id="wbCanRadius" type="number" min="0" value="' + escA(String(o.radius)) + '">'
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
    return t('workbench.canvas.obj_image', { name: (o.src || '').split('/').pop() })
  }

  function canvasObjectHtml(o) {
    var btn = function (act, op, label) {
      return '<button type="button" class="wb-part-btn" data-wb-act="' + act + '" data-wb-op="' + op + '" data-wb-obj="' + escA(o.id) + '"'
        + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(label) + '</button>'
    }
    return '<li class="wb-can-obj">'
      + '<div class="wb-can-obj-head">'
      + '<span class="wb-pill">' + esc(t('workbench.canvas.type_' + o.type)) + '</span>'
      + '<span class="wb-can-obj-name">' + esc(canvasObjectLabel(o)) + '</span>'
      + '<code class="wb-can-id">' + esc(o.id) + '</code>'
      + '</div>'
      + '<div class="wb-can-obj-actions">'
      + btn('canvas-op', 'center', t('workbench.canvas.center'))
      + btn('canvas-op', 'bigger', t('workbench.canvas.bigger'))
      + btn('canvas-op', 'smaller', t('workbench.canvas.smaller'))
      + btn('canvas-op', 'front', t('workbench.canvas.front'))
      + btn('canvas-op', 'back', t('workbench.canvas.back'))
      + '<button type="button" class="wb-part-btn" data-wb-act="canvas-edit" data-wb-obj="' + escA(o.id) + '">'
      + esc(t('workbench.canvas.edit')) + '</button>'
      + '<button type="button" class="wb-part-btn wb-part-btn-bad" data-wb-act="canvas-remove" data-wb-obj="' + escA(o.id) + '"'
      + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.canvas.remove')) + '</button>'
      + '</div>'
      + (WB.canvasEdit === o.id ? canvasFormHtml(o) : '')
      + '</li>'
  }

  function canvasAddHtml() {
    var images = canvasImageChoices()
    return '<div class="wb-can-add">'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-text"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_text')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-rect"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_rect')) + '</button>'
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

  function canvasHtml() {
    var it = WB.detail && WB.detail.item
    if (!it) return ''
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
        + '<div class="wb-empty">'
        + '<p class="wb-empty-title">' + esc(t('workbench.canvas.none_title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.canvas.none_hint')) + '</p>'
        + '<p><button type="button" class="btn-primary" data-wb-act="canvas-start"' + (WB.canvasBusy || archived() ? ' disabled' : '') + '>'
        + esc(WB.canvasBusy ? t('workbench.canvas.starting') : t('workbench.canvas.start')) + '</button></p>'
        + '</div></div>'
    }
    var objects = canvasObjects()
    return '<div class="wb-can">' + head
      + '<p class="wb-hint">' + esc(t('workbench.canvas.intro')) + '</p>'
      + (archived() ? '' : canvasAddHtml())
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
        return '<option value="' + escA(it.id) + '"' + (j === idx ? ' selected' : '') + '>' + esc((j + 1) + '. ' + it.title) + '</option>'
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
          + '<span class="wb-item-title">' + esc(it.title) + '</span>'
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

  function editorPanelHtml() {
    var inner
    if (!WB.selectedId) {
      inner = '<p class="wb-muted wb-center">' + esc(t(WB.layout === 'split' ? 'workbench.split.none' : 'workbench.editor.none')) + '</p>'
        + (WB.layout === 'split' ? splitPickHtml() : '')
    } else if (!WB.detail) {
      inner = '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    } else {
      var it = WB.detail.item
      inner = '<div class="wb-editor-head"><h3>' + esc(it.title) + '</h3>'
        + '<span class="wb-pill">' + esc(typeLabel(it.type)) + '</span>'
        + '<span class="wb-pill">' + esc(statusLabel(it.status)) + '</span></div>'
        + versionBarHtml()
        + (WB.compare && WB.compare.itemId === WB.selectedId
          ? compareHtml()
          : (archived() ? '' : '<p class="wb-hint wb-drop-item-hint">' + esc(t(WB.upload
            ? 'workbench.upload.busy'
            : 'workbench.upload.drop_item')) + '</p>')
            + previewHtml()
            + canvasHtml()
            + partsHtml())
    }
    var dropAttr = WB.selectedId && WB.detail && !archived() ? ' data-wb-drop="item"' : ''
    return '<section class="wb-panel wb-panel-editor' + (WB.panel === 'editor' ? ' wb-panel-current' : '') + '" data-wb-panel-body="editor"' + dropAttr + '>'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.editor')) + '</h2>'
      + switcherHtml()
      + inner + '</section>'
  }

  function contextPanelHtml() {
    var rows = []
    rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.project')) + '</h3>'
      + '<p>' + esc(WB.project ? WB.project.name : '-') + '</p></div>')
    if (WB.detail) {
      var it = WB.detail.item
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p>' + esc(it.title) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.created', { when: when(it.created_at) })) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.updated', { when: when(it.updated_at) })) + '</p></div>')
      var versions = WB.detail.versions || []
      var ro = archived() || WB.versionBusy
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.versions')) + '</h3>'
        + (versions.length
          ? '<ul class="wb-versions">' + versions.map(function (v) {
            var current = v.id === it.current_version_id
            // A JELENLEGIT nincs mire visszaallitani; a regihez ott a gomb, es a
            // kattintas elott KIMONDJUK, hogy a kesobbi verziok megmaradnak.
            var back = (current || ro) ? '' : (' <button type="button" class="wb-linklike" data-wb-act="version-restore"'
              + ' data-wb-version="' + escA(v.id) + '">' + esc(t('workbench.versions.restore')) + '</button>')
            return '<li>' + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) }))
              + (current ? ' <span class="wb-pill">' + esc(t('workbench.versions.current')) + '</span>' : '')
              + (v.restored_from_no ? ' <span class="wb-muted">'
                + esc(t('workbench.versions.restored_from', { n: v.restored_from_no })) + '</span>' : '')
              + back + '</li>'
          }).join('') + '</ul>'
          : '<p class="wb-muted">' + esc(t('workbench.context.no_versions')) + '</p>')
        + (ro ? '' : '<p><button type="button" class="wb-btn" data-wb-act="version-new">'
          + esc(t('workbench.versions.save_new')) + '</button></p>')
        // A KOR BEZARASA (spec 8): letoltod, megszerkeszted a sajat gepeden,
        // visszatoltod -- es UJ VERZIO lesz belole. A regi megmarad.
        + (ro ? '' : '<p><label class="wb-btn wb-part-upload" for="wbDocUpload">'
          + esc(WB.docBusy ? t('workbench.versions.uploading') : t('workbench.versions.upload_document')) + '</label>'
          + '<input type="file" id="wbDocUpload" class="wb-file-input"></p>'
          + '<p class="wb-hint">' + esc(t('workbench.versions.upload_document_hint')) + '</p>')
        + '<p class="wb-hint">' + esc(t('workbench.versions.hint')) + '</p>'
        + '</div>')
    } else {
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p class="wb-muted">' + esc(t('workbench.context.no_selection')) + '</p></div>')
    }
    rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.kanban')) + '</h3>'
      + '<p class="wb-muted">' + esc(t('workbench.context.kanban_soon')) + '</p></div>')
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
      st.turns = regi.concat(st.turns)
      renderChat()
    })
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

  /** A kulcs/modell beallitasa UGYANEBBOL a feluletbol -- terminal nelkul. */
  function chatSetupHtml() {
    var cfg = WB.chatConfig || { WORKBENCH_MODEL: '', keyConfigured: false }
    return '<form class="wb-chat-setup" id="wbChatSetup">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_intro')) + '</p>'
      + '<label class="wb-label" for="wbChatKey">' + esc(t('workbench.chat.setup_key_label')) + '</label>'
      + '<input class="wb-input" id="wbChatKey" type="password" autocomplete="off" placeholder="'
      + escA(cfg.keyConfigured ? t('workbench.chat.setup_key_set') : t('workbench.chat.setup_key_placeholder')) + '">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_key_hint')) + ' '
      + '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com/settings/keys</a></p>'
      + '<label class="wb-label" for="wbChatModel">' + esc(t('workbench.chat.setup_model_label')) + '</label>'
      + '<input class="wb-input" id="wbChatModel" type="text" autocomplete="off" value="' + escA(cfg.WORKBENCH_MODEL || '') + '" placeholder="'
      + escA(t('workbench.chat.setup_model_placeholder')) + '">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_model_hint')) + '</p>'
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
  var CHAT_STALL_MS = 45000
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

  function turnHtml(turn) {
    var who = turn.role === 'user' ? t('workbench.chat.you') : t('workbench.chat.agent')
    var body = ''
    if (turn.text) body += '<div class="wb-turn-text">' + esc(turn.text) + '</div>'
    if (turn.tools && turn.tools.length) body += turn.tools.map(toolLineHtml).join('')
    if (turn.notices && turn.notices.length) {
      body += turn.notices.map(function (n) { return '<div class="wb-turn-notice">' + esc(n) + '</div>' }).join('')
    }
    if (turn.error) body += '<div class="info-box depo-bad">' + esc(turn.error) + '</div>'
    if (turn.aborted) body += '<div class="wb-turn-notice">' + esc(t('workbench.chat.stopped')) + '</div>'
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

  function chatInnerHtml() {
    var streaming = WB.chatStreaming
    var max = (WB.chatStatus && WB.chatStatus.maxMessageChars) || 8000
    return '<div class="wb-chat-head">'
      + '<label class="wb-chat-label" for="wbChatInput">' + esc(t('workbench.chat.title')) + '</label>'
      + chatStatusHtml()
      + '<button type="button" class="btn-secondary wb-chat-setup-btn" data-wb-act="chat-setup">' + esc(t('workbench.chat.setup')) + '</button>'
      + '</div>'
      + (WB.chatSetupOpen ? chatSetupHtml() : '')
      + '<div class="wb-chat-log" id="wbChatLog">' + chatLogHtml() + '</div>'
      + chatActivityHtml()
      + '<div class="wb-chat-row">'
      + '<textarea class="wb-input wb-chat-input" id="wbChatInput" rows="2" maxlength="' + max + '" placeholder="'
      + escA(t('workbench.chat.placeholder')) + '">' + esc(WB.chatDraft) + '</textarea>'
      + (streaming
        ? '<button type="button" class="btn-secondary" data-wb-act="chat-stop">' + esc(t('workbench.chat.stop')) + '</button>'
        : '<button type="button" class="btn-primary" data-wb-act="chat-send">' + esc(t('workbench.chat.send')) + '</button>')
      + '</div>'
      + '<p class="wb-hint">' + esc(WB.selectedId && WB.detail
        ? t('workbench.chat.target_item', { title: WB.detail.item.title })
        : t('workbench.chat.target_project')) + '</p>'
  }

  function chatBarHtml() {
    return '<div class="wb-chat" id="wbChat">' + chatInnerHtml() + '</div>'
  }

  /** CSAK a chat-sav ujrarajzolasa: streameles kozben a teljes oldal ujraepitese
   *  elvenne a fokuszt es a gorgetest. Ha a sav nincs a DOM-ban (meg nem
   *  rajzoltunk), a teljes rajzolas lep a helyebe. */
  function renderChat() {
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChat') : null
    if (!el || typeof el.innerHTML !== 'string') { render(); return }
    var focused = false
    try { focused = !!(document.activeElement && document.activeElement.id === 'wbChatInput') } catch (_e) { focused = false }
    el.innerHTML = chatInnerHtml()
    var log = document.getElementById('wbChatLog')
    if (log && typeof log.scrollHeight === 'number') log.scrollTop = log.scrollHeight
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
      var found = null
      for (var i = turn.tools.length - 1; i >= 0; i--) {
        if (turn.tools[i].name === ev.name && turn.tools[i].status === 'running') { found = turn.tools[i]; break }
      }
      if (found) { found.status = ev.status; found.detail = ev.detail || found.detail; found.approvalId = ev.approvalId || found.approvalId }
      else turn.tools.push({ name: ev.name, status: ev.status, detail: ev.detail || '', approvalId: ev.approvalId || '' })
      if (ev.status === 'ok' && String(ev.name || '').indexOf('workItem.') === 0) scheduleLiveRefresh()
      return
    }
    if (ev.type === 'notice') { turn.notices.push(ev.message || ev.code); return }
    if (ev.type === 'error') { turn.error = ev.message || ev.code; return }
    if (ev.type === 'done') { turn.done = true; turn.model = ev.model || null; turn.via = ev.via || null }
  }

  function parseSseChunk(turn, chunk) {
    var lines = String(chunk).split('\n')
    var data = ''
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).trim()
    }
    if (!data) return
    try { applyChatEvent(turn, JSON.parse(data)) } catch (_e) { /* fel-keret: eldobjuk */ }
  }

  function finishChatTurn(turn) {
    stopChatActivityTicker()
    WB.chatStreaming = false
    WB.chatAbort = null
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
    // A keret allapota a fordulo utan mar mas: ujramerjuk, nem emlekezetbol irjuk.
    loadChatStatus()
  }

  function sendChat() {
    if (WB.chatStreaming) return
    // A mezo TENYLEGES tartalma a forras -- az `input` esemenyre epiteni
    // onmagaban keves (beillesztes, IME, automatikus kitoltes utan elmaradhat).
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatInput') : null
    if (el && typeof el.value === 'string') WB.chatDraft = el.value
    var text = String(WB.chatDraft || '').trim()
    if (!text) return
    var st = chatState()
    st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    var turn = { role: 'agent', text: '', tools: [], notices: [], error: null, done: false }
    st.turns.push(turn)
    WB.chatDraft = ''
    WB.chatStreaming = true
    WB.chatActivityClock = { startedAt: Date.now(), lastEventAt: Date.now() }
    startChatActivityTicker()
    renderChat()

    var body = { project_id: WB.projectId, work_item_id: WB.selectedId || null, message: text }
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
            if (r.done) { if (buf.trim()) parseSseChunk(turn, buf); finishChatTurn(turn); return null }
            buf += dec.decode(r.value, { stream: true })
            var parts = buf.split('\n\n')
            buf = parts.pop()
            for (var i = 0; i < parts.length; i++) parseSseChunk(turn, parts[i])
            renderChat()
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
          finishChatTurn(turn)
        })
      }
      turn.error = t('workbench.chat.no_stream')
      finishChatTurn(turn)
      return null
    }).catch(function (e) {
      if (e && e.name === 'AbortError') turn.aborted = true
      else turn.error = t('workbench.err.network')
      finishChatTurn(turn)
    })
  }

  function stopChat() {
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    else { WB.chatStreaming = false; renderChat() }
  }

  function openChatSetup() {
    WB.chatSetupOpen = true
    renderChat()
    api('GET', '/api/workbench/agent/config').then(function (r) {
      if (r.ok) WB.chatConfig = r.data
      renderChat()
    })
  }

  function saveChatSetup() {
    if (WB.chatSetupBusy) return
    var keyEl = document.getElementById('wbChatKey')
    var modelEl = document.getElementById('wbChatModel')
    var body = {}
    // URES kulcs-mezo NEM torles: a felulet sosem kapja meg a meglevo kulcsot.
    if (keyEl && String(keyEl.value || '').trim()) body.WORKBENCH_ANTHROPIC_API_KEY = String(keyEl.value).trim()
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
      // mi tortent pontosan.
      + (cap.detail ? '<p class="wb-cap-detail"><span>' + esc(t('workbench.caps.detail')) + '</span> <code>' + esc(cap.detail) + '</code></p>' : '')
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
   *  vesz el valtaskor), csak mas a helyuk. Osztott nezetben a chat bal
   *  oldalt, az elo munkadarab jobb oldalt all; a lista es a reszletek alattuk.
   *  Telefonon (keskeny kepernyo) a ket oszlop egymas ala kerul: felul a
   *  munkadarab, alatta a chat -- a CSS dolga, nem kulon kod. */
  function layoutHtml() {
    if (WB.layout !== 'split') {
      return '<div class="wb-grid">' + itemsPanelHtml() + editorPanelHtml() + contextPanelHtml() + '</div>'
        + chatBarHtml()
    }
    return '<div class="wb-split">'
      + '<div class="wb-split-chat">' + chatBarHtml() + '</div>'
      + '<div class="wb-split-work">' + editorPanelHtml() + '</div>'
      + '</div>'
      + '<div class="wb-grid wb-grid-aside">' + itemsPanelHtml() + contextPanelHtml() + '</div>'
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
      })
    }, 400)
  }

  function render() {
    var el = root()
    if (!el || !WB.open) return
    el.innerHTML = '<div class="wb-root">'
      + '<div class="wb-head">'
      + '<button type="button" class="prj-back-link" data-wb-act="back">' + esc(t('workbench.back_to_project')) + '</button>'
      + '<h1>' + esc(t('workbench.title', { project: WB.project ? WB.project.name : '' })) + '</h1>'
      + '<button type="button" class="btn-secondary" data-wb-act="layout-toggle" aria-pressed="' + (WB.layout === 'split') + '"'
      + ' title="' + escA(t('workbench.layout.hint')) + '">'
      + esc(t(WB.layout === 'split' ? 'workbench.layout.to_classic' : 'workbench.layout.to_split')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-open" aria-pressed="' + !!WB.tlOpen + '">' + esc(t('workbench.tl.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-open">' + esc(t('workbench.caps.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
      + capsPanelHtml()
      + timelinePanelHtml()
      + overviewHtml()
      + panelTabsHtml()
      + layoutHtml()
      + '</div>'
    if (WB.formOpen) {
      var input = document.getElementById('wbNewTitle')
      if (input) input.focus()
    }
    // A PDF-nezegeto csomopontja tulelte az ujrarajzolast: visszatesszuk a
    // helyere (vagy uj dokumentumnal elinditjuk a betoltest).
    pdfMount()
  }

  // ---- muveletek ------------------------------------------------------------

  function create() {
    var titleEl = document.getElementById('wbNewTitle')
    var typeEl = document.getElementById('wbNewType')
    if (!titleEl || !typeEl || WB.busy) return
    var title = titleEl.value.trim()
    var type = typeEl.value
    WB.busy = true
    render()
    api('POST', '/api/workbench/items', { project_id: WB.projectId, title: title, type: type }).then(function (r) {
      WB.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      WB.selectedId = r.data.item.id
      WB.detail = { item: r.data.item, versions: r.data.versions, project: WB.project }
      window.showToast(t('workbench.new.created', { title: r.data.item.title }))
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
    WB.project = projectName ? { id: projectId, name: projectName } : null
    WB.items = null
    WB.detail = null
    WB.selectedId = null
    WB.formOpen = false
    WB.error = null
    WB.panel = 'items'
    WB.chat = {}
    WB.chatStatus = null
    WB.chatStatusError = null
    WB.chatStreaming = false
    WB.chatAbort = null
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
    if (pid && typeof window._prjOpenProject === 'function') window._prjOpenProject(pid)
  }

  // ---- esemenyek (egy delegalt figyelo) -------------------------------------

  document.addEventListener('click', function (e) {
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
    if (a === 'back') closeWorkbench()
    else if (a === 'goto-approvals') { if (typeof window.switchPage === 'function') window.switchPage('approvals') }
    else if (a === 'version-undo') undoVersion()
    else if (a === 'compare-open') openCompare()
    else if (a === 'compare-close') { WB.compare = null; render() }
    else if (a === 'text-edit') openTextEdit()
    else if (a === 'text-save') { e.preventDefault(); saveTextEdit() }
    else if (a === 'text-cancel') { WB.textEdit = null; render() }
    else if (a === 'layout-toggle') { WB.layout = WB.layout === 'split' ? 'classic' : 'split'; saveLayout(WB.layout); render() }
    else if (a === 'refresh') load(WB.projectId)
    else if (a === 'new') { if (!archived()) { WB.formOpen = true; render() } }
    else if (a === 'cancel-new') { WB.formOpen = false; render() }
    else if (a === 'create') { e.preventDefault(); create() }
    else if (a === 'part-new-text') { if (!archived()) { WB.partNewOpen = true; WB.partEdit = null; render() } }
    else if (a === 'part-cancel') { WB.partNewOpen = false; WB.partEdit = null; render() }
    else if (a === 'part-add-text') { e.preventDefault(); addTextPart() }
    else if (a === 'part-edit') { WB.partEdit = act.getAttribute('data-wb-part'); WB.partDraft = null; WB.partNewOpen = false; render() }
    else if (a === 'part-save') { e.preventDefault(); savePart(act.getAttribute('data-wb-part')) }
    else if (a === 'part-up') movePart(act.getAttribute('data-wb-part'), 'up')
    else if (a === 'part-down') movePart(act.getAttribute('data-wb-part'), 'down')
    else if (a === 'part-remove') removePart(act.getAttribute('data-wb-part'))
    else if (a === 'caps-open') { WB.capsOpen = true; if (WB.caps === null) loadCaps(false); else render() }
    else if (a === 'caps-close') { WB.capsOpen = false; render() }
    else if (a === 'caps-refresh') loadCaps(true)
    else if (a === 'tl-open') { WB.tlOpen = !WB.tlOpen; if (WB.tlOpen && WB.tl === null) loadTimeline(false); else render() }
    else if (a === 'tl-close') { WB.tlOpen = false; render() }
    else if (a === 'tl-refresh') loadTimeline(false)
    else if (a === 'tl-more') loadTimeline(true)
    else if (a === 'cap-test') testCap(act.getAttribute('data-wb-cap'))
    else if (a === 'cap-save') saveCapSetting(act.getAttribute('data-wb-cap'))
    else if (a === 'canvas-start') { if (!archived()) startCanvas() }
    else if (a === 'canvas-refresh') loadCanvas(WB.selectedId)
    else if (a === 'canvas-edit') { WB.canvasEdit = act.getAttribute('data-wb-obj'); render() }
    else if (a === 'canvas-cancel') { WB.canvasEdit = null; render() }
    else if (a === 'canvas-save') { e.preventDefault(); saveCanvasObject(act.getAttribute('data-wb-obj')) }
    else if (a === 'canvas-add-text') { if (!archived()) canvasAddText() }
    else if (a === 'canvas-add-rect') { if (!archived()) canvasAddRect() }
    else if (a === 'canvas-add-image') { if (!archived()) canvasAddImage() }
    else if (a === 'canvas-remove') canvasRemoveObject(act.getAttribute('data-wb-obj'))
    else if (a === 'canvas-op') canvasQuickOp(act.getAttribute('data-wb-op'), act.getAttribute('data-wb-obj'))
    else if (a === 'preview-convert') convertPreview(false)
    else if (a === 'preview-convert-retry') convertPreview(true)
    else if (a === 'version-new') newVersion()
    else if (a === 'version-restore') restoreVersion(act.getAttribute('data-wb-version'))
    else if (a === 'chat-send') sendChat()
    else if (a === 'chat-stop') stopChat()
    else if (a === 'chat-setup') openChatSetup()
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
    }
    WB.canvasSel = o.id
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
    // Par pixel meg nem huzas, hanem kattintas (kijelolés). Kulonben minden
    // erintes elmozditana az elemet.
    if (!d.moved && Math.abs(sx) < 3 && Math.abs(sy) < 3) return
    d.moved = true
    d.box = canvasDragBox(d.from, d.mode, sx * d.kx, sy * d.ky)
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
    var b = d.box
    var f = d.from
    var same = b.x === f.x && b.y === f.y && b.width === f.width && b.height === f.height
    if (!commit || !d.moved || same) { render(); return }
    canvasOps([{ op: 'update', id: d.id, patch: { x: b.x, y: b.y, width: b.width, height: b.height } }])
  }

  document.addEventListener('pointerup', function () { canvasDragFinish(true) })
  document.addEventListener('pointercancel', function () { canvasDragFinish(false) })

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

  // A bevitel erteket allapotban tartjuk: a chat-sav ujrarajzolasa (streameles
  // kozben soronkent) kulonben eltorolne a felig beirt mondatot.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbChatInput') WB.chatDraft = e.target.value
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
    if (e.target.id === 'wbTextEdit' && WB.textEdit) WB.textEdit.value = e.target.value
    else if (e.target.id === 'wbPartText' && WB.partEdit) WB.partDraft = { id: WB.partEdit, value: e.target.value }
  })

  // Ctrl+S / Cmd+S a szerkesztoben: mentes (uj verzio) -- a bongeszo sajat
  // "oldal mentese" ablaka helyett, ami itt senkinek nem kell.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 's') return
    var id = e.target.id
    if (id !== 'wbTextEdit' && id !== 'wbPartText' && id !== 'wbPartNewText') return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    if (id === 'wbTextEdit') saveTextEdit()
    else if (id === 'wbPartText' && WB.partEdit) savePart(WB.partEdit)
    else if (id === 'wbPartNewText') addTextPart()
  })

  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || e.target.id !== 'wbChatInput') return
    if (e.key === 'Enter' && !e.shiftKey) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      WB.chatDraft = e.target.value
      sendChat()
    }
  })

  document.addEventListener('change', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbSwitch') {
      selectItem(e.target.value)
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
    uploadFiles(files, WB.selectedId && WB.detail ? 'item' : 'new')
  })

  document.addEventListener('submit', function (e) {
    if (!WB.open) return
    if (e.target && e.target.id === 'wbNewForm') { e.preventDefault(); create() }
    if (e.target && e.target.id === 'wbTextEditForm') { e.preventDefault(); saveTextEdit() }
    if (e.target && e.target.id === 'wbPartNewForm') { e.preventDefault(); addTextPart() }
    if (e.target && e.target.id === 'wbPartForm') { e.preventDefault(); savePart(WB.partEdit) }
    if (e.target && e.target.id === 'wbChatSetup') { e.preventDefault(); saveChatSetup() }
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
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    WB.chatAbort = null
    WB.chatDraft = ''
    WB.chatSetupOpen = false
    WB.chatSetupBusy = false
    WB.chatConfig = null
    WB.partEdit = null
    WB.partNewOpen = false
    WB.partBusy = false
    WB.preview = null
    WB.previewVersion = null
    WB.overview = null
    WB.overviewError = null
  }

  window.MarvinWorkbench = {
    open: openWorkbench,
    close: closeWorkbench,
    reset: resetWorkbench,
    isOpen: function () { return WB.open },
  }
})()

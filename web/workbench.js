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
    // --- elonezet (4. fazis) ---
    preview: null,
    previewVersion: null,
    versionBusy: false,
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
      if (WB.selectedId && !WB.items.some(function (i) { return i.id === WB.selectedId })) WB.selectedId = null
      render()
    })
  }

  function loadDetail(id) {
    WB.detail = null
    WB.preview = null
    WB.previewVersion = null
    WB.versionBusy = false
    WB.canvas = null
    WB.canvasError = null
    WB.canvasEdit = null
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
      body = '<ul class="wb-items">' + WB.items.map(function (it) {
        return '<li><button type="button" class="wb-item' + (it.id === WB.selectedId ? ' wb-item-active' : '') + '" data-wb-item="' + escA(it.id) + '">'
          + '<span class="wb-item-title">' + esc(it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
          + '</button></li>'
      }).join('') + '</ul>'
    }
    return '<section class="wb-panel wb-panel-items' + (WB.panel === 'items' ? ' wb-panel-current' : '') + '" data-wb-panel-body="items">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.items')) + '</h2>'
      + body
      + (archived()
        ? '<p class="wb-hint">' + esc(t('workbench.archived_hint')) + '</p>'
        : WB.formOpen ? newFormHtml() : '<button type="button" class="btn-primary wb-new-btn" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button>')
      + '</section>'
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
      var value = part.kind === 'text' ? (part.text || '') : (part.caption || '')
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
  function loadPreview(itemId, versionId) {
    WB.preview = null
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
      return '<iframe class="wb-preview-frame" src="' + escA(p.url) + '" title="' + escA(p.name || t('workbench.preview.title')) + '"></iframe>'
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
      return '<iframe class="wb-preview-frame" src="' + escA(p.url) + '" title="' + escA(p.name || t('workbench.preview.title')) + '"></iframe>'
        + '<p class="wb-hint"><a href="' + escA(p.url) + '" target="_blank" rel="noopener">' + esc(t('workbench.preview.open_new_tab')) + '</a></p>'
    }
    if (p.kind === 'canvas') {
      // A rajzot a SZERVER rajzolja ki SVG-be: a bongeszonek nem kell hozza
      // semmilyen kulso konyvtar, es a letoltott kep ugyanez a kep.
      return '<img class="wb-preview-image" src="' + escA(canvasSvgUrl(WB.selectedId, false)) + '" alt="' + escA(p.name || t('workbench.preview.title')) + '">'
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
      return '<pre class="wb-preview-text">' + esc(p.text || '') + '</pre>'
        + (p.truncated ? '<p class="wb-hint">' + esc(t('workbench.preview.truncated')) + '</p>' : '')
    }
    return ''
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
      // A kozepso panel elonezete is a vaszonrol szol: ujra kell kerni.
      loadPreview(WB.selectedId, null)
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

  function editorPanelHtml() {
    var inner
    if (!WB.selectedId) {
      inner = '<p class="wb-muted wb-center">' + esc(t('workbench.editor.none')) + '</p>'
    } else if (!WB.detail) {
      inner = '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    } else {
      var it = WB.detail.item
      inner = '<div class="wb-editor-head"><h3>' + esc(it.title) + '</h3>'
        + '<span class="wb-pill">' + esc(typeLabel(it.type)) + '</span>'
        + '<span class="wb-pill">' + esc(statusLabel(it.status)) + '</span></div>'
        + previewHtml()
        + canvasHtml()
        + partsHtml()
    }
    return '<section class="wb-panel wb-panel-editor' + (WB.panel === 'editor' ? ' wb-panel-current' : '') + '" data-wb-panel-body="editor">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.editor')) + '</h2>'
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
        return { role: m.role === 'user' ? 'user' : 'agent', text: m.content || '', tools: [], notices: [], error: null, done: true }
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
      bits.push(esc(t('workbench.chat.provider_on', { model: s.provider.model || '-' })))
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

  function toolLineHtml(tool) {
    var cls = tool.status === 'error' || tool.status === 'blocked' ? ' wb-tool-bad'
      : tool.status === 'needs_approval' ? ' wb-tool-wait' : ''
    return '<div class="wb-tool' + cls + '">'
      + '<span class="wb-tool-name">' + esc(tool.name) + '</span> '
      + esc(t('workbench.chat.tool_' + tool.status))
      + (tool.detail ? ' <span class="wb-muted">' + esc(tool.detail) + '</span>' : '')
      + (tool.approvalId ? ' <span class="wb-muted">' + esc(t('workbench.chat.approval_id', { id: tool.approvalId })) + '</span>' : '')
      + '</div>'
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
    if (!body && turn.role === 'agent') body = '<div class="wb-turn-text wb-muted">' + esc(t('workbench.chat.thinking')) + '</div>'
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
    if (ev.type === 'session') { chatState().sessionId = ev.sessionId; return }
    if (ev.type === 'text') { turn.text += ev.text || ''; return }
    if (ev.type === 'tool') {
      var found = null
      for (var i = turn.tools.length - 1; i >= 0; i--) {
        if (turn.tools[i].name === ev.name && turn.tools[i].status === 'running') { found = turn.tools[i]; break }
      }
      if (found) { found.status = ev.status; found.detail = ev.detail || found.detail; found.approvalId = ev.approvalId || found.approvalId }
      else turn.tools.push({ name: ev.name, status: ev.status, detail: ev.detail || '', approvalId: ev.approvalId || '' })
      return
    }
    if (ev.type === 'notice') { turn.notices.push(ev.message || ev.code); return }
    if (ev.type === 'error') { turn.error = ev.message || ev.code; return }
    if (ev.type === 'done') { turn.done = true; turn.model = ev.model || null }
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

  function render() {
    var el = root()
    if (!el || !WB.open) return
    el.innerHTML = '<div class="wb-root">'
      + '<div class="wb-head">'
      + '<button type="button" class="prj-back-link" data-wb-act="back">' + esc(t('workbench.back_to_project')) + '</button>'
      + '<h1>' + esc(t('workbench.title', { project: WB.project ? WB.project.name : '' })) + '</h1>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-open">' + esc(t('workbench.caps.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
      + capsPanelHtml()
      + panelTabsHtml()
      + '<div class="wb-grid">' + itemsPanelHtml() + editorPanelHtml() + contextPanelHtml() + '</div>'
      + chatBarHtml()
      + '</div>'
    if (WB.formOpen) {
      var input = document.getElementById('wbNewTitle')
      if (input) input.focus()
    }
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

  function partsUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/parts' + (tail || '')
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
      + '?name=' + encodeURIComponent(file.name || 'kep.jpg')
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
      WB.selectedId = itemBtn.getAttribute('data-wb-item')
      WB.panel = 'editor'
      // Mas munkadarab: a felig nyitott resz-szerkesztes nem szivaroghat at.
      WB.partEdit = null
      WB.partNewOpen = false
      loadDetail(WB.selectedId)
      // Mas munkadarab = MAS beszelgetes: a hozza tartozot toltjuk be.
      loadChatHistory()
      return
    }
    var act = e.target.closest('[data-wb-act]')
    if (!act) return
    var a = act.getAttribute('data-wb-act')
    if (a === 'back') closeWorkbench()
    else if (a === 'refresh') load(WB.projectId)
    else if (a === 'new') { if (!archived()) { WB.formOpen = true; render() } }
    else if (a === 'cancel-new') { WB.formOpen = false; render() }
    else if (a === 'create') { e.preventDefault(); create() }
    else if (a === 'part-new-text') { if (!archived()) { WB.partNewOpen = true; WB.partEdit = null; render() } }
    else if (a === 'part-cancel') { WB.partNewOpen = false; WB.partEdit = null; render() }
    else if (a === 'part-add-text') { e.preventDefault(); addTextPart() }
    else if (a === 'part-edit') { WB.partEdit = act.getAttribute('data-wb-part'); WB.partNewOpen = false; render() }
    else if (a === 'part-save') { e.preventDefault(); savePart(act.getAttribute('data-wb-part')) }
    else if (a === 'part-up') movePart(act.getAttribute('data-wb-part'), 'up')
    else if (a === 'part-down') movePart(act.getAttribute('data-wb-part'), 'down')
    else if (a === 'part-remove') removePart(act.getAttribute('data-wb-part'))
    else if (a === 'caps-open') { WB.capsOpen = true; if (WB.caps === null) loadCaps(false); else render() }
    else if (a === 'caps-close') { WB.capsOpen = false; render() }
    else if (a === 'caps-refresh') loadCaps(true)
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

  // A bevitel erteket allapotban tartjuk: a chat-sav ujrarajzolasa (streameles
  // kozben soronkent) kulonben eltorolne a felig beirt mondatot.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbChatInput') WB.chatDraft = e.target.value
  })

  // Enter kuld, Shift+Enter uj sort ir. (Telefonon a gomb marad a fo ut.)
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

  document.addEventListener('submit', function (e) {
    if (!WB.open) return
    if (e.target && e.target.id === 'wbNewForm') { e.preventDefault(); create() }
    if (e.target && e.target.id === 'wbPartNewForm') { e.preventDefault(); addTextPart() }
    if (e.target && e.target.id === 'wbPartForm') { e.preventDefault(); savePart(WB.partEdit) }
    if (e.target && e.target.id === 'wbChatSetup') { e.preventDefault(); saveChatSetup() }
  })

  /** Alaphelyzet RAJZOLAS NELKUL: az oldal-betolto hivja, amikor a Projektek
   *  oldal ujraindul. A `closeWorkbench()` visszavinne a projekt-oldalra --
   *  itt eppen az a dolgunk, hogy ne szoljunk bele abba, amit a hivo rajzol. */
  function resetWorkbench() {
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
  }

  window.MarvinWorkbench = {
    open: openWorkbench,
    close: closeWorkbench,
    reset: resetWorkbench,
    isOpen: function () { return WB.open },
  }
})()

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
          return { ok: false, status: res.status, code: data && data.error, message: (data && data.message) || t('workbench.err.http', { status: res.status }) }
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
    render()
    return api('GET', '/api/workbench/items/' + encodeURIComponent(id)).then(function (r) {
      if (WB.selectedId !== id) return
      if (!r.ok) { window.showToast(r.message); return }
      WB.detail = r.data
      render()
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
        + '<div class="wb-soon">' + esc(t('workbench.editor.soon', { kind: typeLabel(it.type) })) + '</div>'
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
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.versions')) + '</h3>'
        + (versions.length
          ? '<ul class="wb-versions">' + versions.map(function (v) {
            return '<li>' + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) }))
              + (v.id === it.current_version_id ? ' <span class="wb-pill">' + esc(t('workbench.versions.current')) + '</span>' : '')
              + '</li>'
          }).join('') + '</ul>'
          : '<p class="wb-muted">' + esc(t('workbench.context.no_versions')) + '</p>')
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

  function chatBarHtml() {
    return '<div class="wb-chat" aria-disabled="true">'
      + '<label class="wb-chat-label" for="wbChatInput">' + esc(t('workbench.chat.title')) + '</label>'
      + '<div class="wb-chat-row">'
      + '<input class="wb-input" id="wbChatInput" type="text" disabled placeholder="' + escA(t('workbench.chat.placeholder')) + '">'
      + '<button type="button" class="btn-primary" disabled>' + esc(t('workbench.chat.send')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.chat.soon')) + '</p>'
      + '</div>'
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
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
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
    render()
    load(projectId)
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
      loadDetail(WB.selectedId)
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
  })

  document.addEventListener('submit', function (e) {
    if (!WB.open) return
    if (e.target && e.target.id === 'wbNewForm') { e.preventDefault(); create() }
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
  }

  window.MarvinWorkbench = {
    open: openWorkbench,
    close: closeWorkbench,
    reset: resetWorkbench,
    isOpen: function () { return WB.open },
  }
})()

// ArmorIQ Cookbook browser. Vanilla JS, no build step.
(() => {
  'use strict';

  // ───────── icons (paths from design-system/primitives/icons; sun, moon, folder drawn to match) ─────────
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="m4.93 4.93 14.14 14.14"/>',
    play: '<path d="M6 4v16l14-8L6 4Z"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    shield: '<path d="M12 2 4 5v7c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5l-8-3Z"/>',
    shieldCheck: '<path d="M12 2 4 5v7c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    alert: '<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
    network: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11l-5 6M12 11l5 6"/>',
    scroll: '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  };
  const icon = (name, size = 14, extra = '') =>
    `<svg class="icon ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (sel, root = document) => root.querySelector(sel);
  // Rail rows drop the shared "Build a ... with the ArmorIQ SDK" wrapper so the scenario name fits.
  const shortTitle = (t) => t.replace(/^Build (an?|the) /i, '').replace(/ with the ArmorIQ SDK$/i, '');

  // ───────── outcome / status vocabularies ─────────
  const OUTCOME = {
    allow: { tone: 'good', icon: 'check' },
    hold: { tone: 'warn', icon: 'pause' },
    block: { tone: 'bad', icon: 'block' },
    'prompt-injection': { tone: 'bad', icon: 'alert' },
    delegation: { tone: 'info', icon: 'network' },
    'multi-server': { tone: 'info', icon: 'network' },
    'audit-log': { tone: 'neutral', icon: 'scroll' },
  };
  const ACTION = {
    allow: { tone: 'good', icon: 'check', label: 'Allow' },
    hold: { tone: 'warn', icon: 'pause', label: 'Hold' },
    block: { tone: 'bad', icon: 'block', label: 'Block' },
  };
  const CHECK = {
    ALLOWED: { tone: 'good', icon: 'check', label: 'Allowed' },
    HELD: { tone: 'warn', icon: 'pause', label: 'Held' },
    BLOCKED: { tone: 'bad', icon: 'block', label: 'Blocked' },
  };
  const badge = (tone, ic, label, extra = '') =>
    `<span class="aq-status aq-status--${tone} ${extra}">${icon(ic, 12)}${esc(label)}</span>`;

  // ───────── state ─────────
  const state = {
    recipes: [],
    taxonomy: {},
    selectedId: null,
    detail: null,
    policy: null,
    tab: 'overview',
    file: null,
    query: '',
    filters: { language: new Set(), framework: new Set(), outcome: new Set(), tier: new Set() },
    runs: {},
    approval: 'approve',
    es: null,
    check: { status: 'idle', output: '' },
    detailSeq: 0,
    homeLang: 'all',
  };

  const label = (kind, key) => state.taxonomy?.[kind]?.[key]?.label || key;
  const tierOf = (r) => r.manifest?.tier || (r.isOfficial ? 'official' : 'community');

  // ───────── theme ─────────
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('aiq-cookbook-theme', theme); } catch {}
    renderThemeButton();
  }
  function renderThemeButton() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const b = $('#btn-theme');
    b.innerHTML = icon(dark ? 'sun' : 'moon', 16);
    b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    b.title = b.getAttribute('aria-label');
  }

  // ───────── checks ─────────
  function renderChecks() {
    const s = $('#check-status');
    const b = $('#btn-checks');
    const c = state.check.status;
    const map = {
      idle: ['neutral', 'shield', 'Repo checks'],
      running: ['info', 'refresh', 'Checking'],
      pass: ['good', 'shieldCheck', 'Checks pass'],
      fail: ['bad', 'alert', 'Checks fail'],
    }[c];
    b.className = `aq-button aq-button--ghost aq-button--sm check-button check-button--${map[0]}`;
    b.disabled = c === 'running';
    b.title = 'Runs npm run check (manifests, schema, README index). Click to run again.';
    s.innerHTML = `${icon(map[1], 14, c === 'running' ? 'spin' : '')}<span>${map[2]}</span>`;
    const banner = $('#check-banner');
    if (c === 'fail') {
      banner.hidden = false;
      banner.innerHTML = `<div class="aq-banner aq-banner--bad" role="alert">${icon('alert', 16)}<div class="banner-body">
        <strong>npm run check failed.</strong>
        <details class="aq-collapsible-inline"><summary class="link-button">Show output</summary><pre class="banner-pre mono">${esc(state.check.output)}</pre></details></div></div>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
  async function runChecks() {
    state.check.status = 'running';
    renderChecks();
    try {
      const res = await fetch('/api/check');
      const data = await res.json();
      state.check = { status: data.code === 0 ? 'pass' : 'fail', output: data.output || '' };
    } catch (e) {
      state.check = { status: 'fail', output: String(e) };
    }
    renderChecks();
  }

  // ───────── rail ─────────
  function optionsFor(kind) {
    const counts = new Map();
    for (const r of state.recipes) {
      const m = r.manifest || {};
      let vals = [];
      if (kind === 'language') vals = [m.language];
      if (kind === 'framework') vals = [m.framework];
      if (kind === 'outcome') vals = m.demonstrates || [];
      if (kind === 'tier') vals = [tierOf(r)];
      for (const v of vals.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.keys()].sort();
  }
  function optionLabel(kind, v) {
    if (kind === 'language') return label('languages', v).replace(' / JavaScript', '');
    if (kind === 'framework') return label('frameworks', v);
    if (kind === 'outcome') return label('outcomes', v);
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  function matches(r) {
    const m = r.manifest || {};
    const q = state.query.trim().toLowerCase();
    if (q) {
      const hay = [r.id, m.title, m.summary, ...(m.tags || [])].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    const f = state.filters;
    if (f.language.size && !f.language.has(m.language)) return false;
    if (f.framework.size && !f.framework.has(m.framework)) return false;
    if (f.outcome.size && !(m.demonstrates || []).some((o) => f.outcome.has(o))) return false;
    if (f.tier.size && !f.tier.has(tierOf(r))) return false;
    return true;
  }
  const anyFilter = () => state.query || Object.values(state.filters).some((s) => s.size);

  const SHORT_OUTCOME = { allow: 'Allow', hold: 'Hold', block: 'Block', 'prompt-injection': 'Injection', delegation: 'Delegation', 'multi-server': 'Multi MCP', 'audit-log': 'Audit' };
  const LANG_SHORT = { typescript: 'TypeScript', python: 'Python', config: 'Config' };
  const LANG_TILE = { typescript: 'TS', python: 'PY', config: 'CFG' };
  const fwLabel = (fw) => label('frameworks', fw || '').replace(' (no framework)', '');
  // Name each recipe after its scenario (the folder slug), since the framework is shown beside it.
  const WORD_FIX = { mcp: 'MCP', github: 'GitHub', adk: 'ADK', sdk: 'SDK' };
  const titleOf = (r) =>
    r.id.split('/').pop().split('-').map((w) => WORD_FIX[w] || w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  function outcomeMini(m) {
    return (m.demonstrates || [])
      .map((o) => {
        const tone = (OUTCOME[o] || { tone: 'neutral' }).tone;
        return `<span class="outcome-mini" title="${esc(label('outcomes', o))}"><span class="dot dot--${tone}"></span>${esc(SHORT_OUTCOME[o] || o)}</span>`;
      })
      .join('');
  }

  // Recipes grouped by use case (what you want to build), largest group first.
  function groupByUseCase(list) {
    const groups = new Map();
    for (const r of list) {
      const uc = r.manifest?.use_case || 'other';
      if (!groups.has(uc)) groups.set(uc, []);
      groups.get(uc).push(r);
    }
    return [...groups.entries()]
      .map(([uc, items]) => [uc, items.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))])
      .sort((a, b) => b[1].length - a[1].length || label('use_cases', a[0]).localeCompare(label('use_cases', b[0])));
  }

  function renderRail() {
    const list = state.recipes.filter(matches);
    $('#count').innerHTML = state.query
      ? `<span>${list.length} of ${state.recipes.length} match</span><button type="button" class="link-button" id="clear-filters">Clear</button>`
      : '';
    const el = $('#rail-list');
    const home = `<button type="button" class="rail-item rail-home" data-home aria-current="${!state.selectedId}">
        <span class="lang-tile lang-tile--home" aria-hidden="true">${icon('grid', 14)}</span>
        <span class="row-main"><span class="row-title">All recipes</span><span class="row-meta">${state.recipes.length} runnable agents</span></span>
      </button>`;
    if (!list.length) {
      el.innerHTML = home + `<div class="aq-page-state"><span class="ps-icon">${icon('search', 18)}</span><h2>No recipes match</h2><p>Try a different search term.</p></div>`;
      return;
    }
    el.innerHTML =
      home +
      groupByUseCase(list)
        .map(([uc, items]) => {
          const rows = items
            .map((r) => {
              const m = r.manifest || {};
              return `<button type="button" class="rail-item" data-id="${esc(r.id)}" aria-current="${r.id === state.selectedId}">
              <span class="lang-tile" aria-hidden="true">${LANG_TILE[m.language] || '··'}</span>
              <span class="row-main">
                <span class="row-title-line"><span class="row-title" title="${esc(m.title || r.id)}">${esc(titleOf(r))}</span>${
                  tierOf(r) === 'official' ? '<span class="official-tag">Official</span>' : ''
                }</span>
                <span class="row-meta">${esc(fwLabel(m.framework))} · ${esc(LANG_SHORT[m.language] || m.language || '')}</span>
              </span>
            </button>`;
            })
            .join('');
          return `<section class="rail-group" aria-label="${esc(label('use_cases', uc))}">
          <div class="rail-group-head"><span class="eyebrow">${esc(label('use_cases', uc))}</span><span class="rail-group-count">${items.length}</span></div>
          ${rows}
        </section>`;
        })
        .join('');
  }

  // ───────── home ─────────
  function renderHome() {
    const view = $('#view');
    const lang = state.homeLang;
    const list = state.recipes.filter((r) => matches(r) && (lang === 'all' || r.manifest?.language === lang));
    const langs = ['all', ...new Set(state.recipes.map((r) => r.manifest?.language).filter(Boolean))];
    const card = (r) => {
      const m = r.manifest || {};
      return `<button type="button" class="recipe-card" data-id="${esc(r.id)}">
        <span class="card-top"><span class="lang-tile" aria-hidden="true">${LANG_TILE[m.language] || '··'}</span>
          <span class="card-fw">${esc(fwLabel(m.framework))}<span class="muted"> · ${esc(LANG_SHORT[m.language] || '')}</span></span>
          ${tierOf(r) === 'official' ? '<span class="official-tag">Official</span>' : ''}</span>
        <span class="card-title">${esc(titleOf(r))}</span>
        <span class="card-summary">${esc(m.summary || '')}</span>
        <span class="card-outcomes">${outcomeMini(m)}</span>
      </button>`;
    };
    view.innerHTML = `<div class="home">
      <section class="home-hero">
        <h1>Agents that ask before they act</h1>
        <p>Each recipe is a complete agent wired to ArmorIQ. Every tool call it makes is checked against a policy first. Pick one, read the guide, and run it right here with no keys or accounts.</p>
      </section>
      <section class="legend" aria-label="What a policy can decide">
        <div class="legend-item"><span class="legend-icon legend-icon--good">${icon('check', 16)}</span><div><strong>Allow</strong><span>The call runs right away.</span></div></div>
        <div class="legend-item"><span class="legend-icon legend-icon--warn">${icon('pause', 16)}</span><div><strong>Hold</strong><span>It waits until a person approves.</span></div></div>
        <div class="legend-item"><span class="legend-icon legend-icon--bad">${icon('block', 16)}</span><div><strong>Block</strong><span>It never runs, whatever the prompt says.</span></div></div>
      </section>
      <div class="home-toolbar">
        <div class="aq-segmented" role="radiogroup" aria-label="Language">
          ${langs.map((l) => `<button type="button" role="radio" data-lang="${l}" aria-checked="${lang === l}">${l === 'all' ? 'All languages' : esc(LANG_SHORT[l] || l)}</button>`).join('')}
        </div>
        <span class="muted t-xs">${list.length} recipe${list.length === 1 ? '' : 's'}</span>
      </div>
      ${
        list.length
          ? groupByUseCase(list)
              .map(([uc, items]) => `<section class="home-group">
          <div class="home-group-head"><h2>${esc(label('use_cases', uc))}</h2><p>${esc(state.taxonomy?.use_cases?.[uc]?.description || '')}</p></div>
          <div class="card-grid">${items.map(card).join('')}</div>
        </section>`)
              .join('')
          : `<div class="aq-page-state"><span class="ps-icon">${icon('search', 18)}</span><h2>No recipes match</h2><p>Try a different search term or language.</p></div>`
      }
    </div>`;
  }

  function goHome({ push = true } = {}) {
    state.selectedId = null;
    state.detail = null;
    if (push) history.replaceState(null, '', location.pathname);
    renderRail();
    renderHome();
    $('#main').scrollTop = 0;
  }

  // ───────── recipe view ─────────
  const TABS = [['overview', 'Guide'], ['run', 'Try it'], ['policy', 'Policy'], ['files', 'Code']];

  function renderRecipe() {
    const view = $('#view');
    const d = state.detail;
    if (!d) return renderHome();
    const m = d.manifest || {};
    const outcomes = (m.demonstrates || [])
      .map((o) => {
        const v = OUTCOME[o] || { tone: 'neutral', icon: 'info' };
        return badge(v.tone, v.icon, label('outcomes', o));
      })
      .join('');
    view.innerHTML = `<article class="recipe">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#" data-home>All recipes</a>${icon('chevron', 12)}<span>${esc(label('use_cases', m.use_case || ''))}</span></nav>
      <div class="recipe-head">
        <div class="recipe-head-text">
          <h1 class="recipe-title">${esc(titleOf(d))}</h1>
          <p class="recipe-summary">${esc(m.summary || '')}</p>
        </div>
        <button type="button" class="aq-button aq-button--primary" id="btn-try">${icon('play', 14)}Try it offline</button>
      </div>
      <dl class="facts">
        <div><dt>Runs on</dt><dd>${esc(fwLabel(m.framework))} · ${esc(LANG_SHORT[m.language] || m.language || '')}</dd></div>
        <div><dt>Shows</dt><dd class="facts-badges">${outcomes || '<span class="muted">None listed</span>'}</dd></div>
        <div><dt>Tier</dt><dd>${tierOf(d) === 'official' ? '<span class="official-tag">Official</span> maintained by ArmorIQ' : 'Community'}</dd></div>
      </dl>
      <div class="aq-tabs" role="tablist" aria-label="Recipe sections">
        ${TABS.map(([k, t]) => `<button type="button" role="tab" class="aq-tab" id="tab-${k}" data-tab="${k}" aria-selected="${state.tab === k}" aria-controls="panel" tabindex="${state.tab === k ? 0 : -1}">${t}</button>`).join('')}
      </div>
      <div id="panel" class="tab-panel" role="tabpanel" tabindex="0"></div>
    </article>`;
    renderTab();
  }

  function renderTab() {
    $$tabs().forEach((b) => {
      const sel = b.dataset.tab === state.tab;
      b.setAttribute('aria-selected', sel);
      b.tabIndex = sel ? 0 : -1;
    });
    $('#panel').setAttribute('aria-labelledby', 'tab-' + state.tab);
    // One orange call to action per view: the Try it tab has its own Run button.
    if ($('#btn-try')) $('#btn-try').hidden = state.tab === 'run';
    if (state.tab === 'overview') renderOverview();
    if (state.tab === 'files') renderFiles();
    if (state.tab === 'policy') renderPolicy();
    if (state.tab === 'run') renderRun();
  }
  const $$tabs = () => [...document.querySelectorAll('.aq-tab')];

  function renderOverview() {
    const readme = state.detail.readme;
    const panel = $('#panel');
    if (!readme) {
      panel.innerHTML = `<div class="aq-page-state"><span class="ps-icon">${icon('file', 18)}</span><h2>No README</h2><p>This recipe has no README.md yet.</p></div>`;
      return;
    }
    // The page header already shows the title, so drop the README's own first heading.
    const body = readme.replace(/^\s*# [^\n]*\n/, '');
    const html = window.marked ? window.marked.parse(body) : `<pre>${esc(body)}</pre>`;
    panel.innerHTML = `<div class="markdown-body">${html}</div>`;
  }

  // Files
  function renderFiles() {
    const files = state.detail.files;
    const panel = $('#panel');
    if (!files.length) {
      panel.innerHTML = `<div class="aq-page-state"><span class="ps-icon">${icon('folder', 18)}</span><h2>No files</h2></div>`;
      return;
    }
    if (!state.file || !files.includes(state.file)) {
      state.file = files.find((f) => /^(src\/)?(index|agent|main)\.(ts|js|py)$/.test(f) || /^(demo)\.(js|py)$/.test(f)) || files[0];
    }
    const seen = new Set();
    const items = [];
    for (const f of files) {
      const parts = f.split('/');
      parts.slice(0, -1).forEach((_, i) => {
        const dir = parts.slice(0, i + 1).join('/');
        if (!seen.has(dir)) {
          seen.add(dir);
          items.push(`<div class="tree-item tree-dir" style="padding-left:${0.5 + i * 0.875}rem">${icon('folder', 13)}<span class="name">${esc(parts[i])}</span></div>`);
        }
      });
      items.push(`<button type="button" class="tree-item" data-file="${esc(f)}" aria-current="${f === state.file}" style="padding-left:${0.5 + (parts.length - 1) * 0.875}rem">${icon('file', 13)}<span class="name">${esc(parts[parts.length - 1])}</span></button>`);
    }
    panel.innerHTML = `<div class="files">
      <div class="tree" role="list" aria-label="Recipe files">${items.join('')}</div>
      <div class="code-pane"><div class="code-name" id="code-name"></div><pre class="code mono" id="code" tabindex="0"></pre></div>
    </div>`;
    loadFile(state.file);
  }
  async function loadFile(f) {
    state.file = f;
    document.querySelectorAll('.tree-item[data-file]').forEach((b) => b.setAttribute('aria-current', b.dataset.file === f));
    const name = $('#code-name');
    const code = $('#code');
    if (!name || !code) return;
    name.textContent = f;
    const id = state.selectedId;
    const res = await fetch(`/api/file/${encodeURI(id)}?file=${encodeURIComponent(f)}`);
    const text = await res.text();
    if (state.selectedId === id && state.file === f && $('#code')) $('#code').textContent = text;
  }

  // Policy
  async function renderPolicy() {
    const panel = $('#panel');
    const id = state.selectedId;
    if (!state.policy || state.policy.id !== id) {
      panel.innerHTML = `<div class="aq-page-state aq-page-state--loading"><span class="ps-icon">${icon('refresh', 18)}</span><h2>Loading policy</h2></div>`;
      try {
        const res = await fetch(`/api/policy/${encodeURI(id)}`);
        state.policy = await res.json();
      } catch (e) {
        state.policy = { id, policies: [] };
      }
      if (state.selectedId !== id || state.tab !== 'policy') return;
    }
    const policies = state.policy.policies || [];
    if (!policies.length) {
      panel.innerHTML = `<div class="aq-page-state"><span class="ps-icon">${icon('shield', 18)}</span><h2>No policy file</h2><p>This recipe does not ship a policy*.yaml file.</p></div>`;
      return;
    }
    panel.innerHTML = policies
      .map((p) => {
        if (p.error) {
          return `<section class="policy"><div class="aq-banner aq-banner--bad">${icon('alert', 16)}<div class="banner-body"><code>${esc(p.file)}</code> could not be parsed: ${esc(p.error)}</div></div></section>`;
        }
        const scope = p.scope ? [p.scope.target_type, p.scope.target].filter(Boolean).join(' · ') : '';
        const rows = p.rules
          .map((r) => {
            const a = ACTION[r.action] || { tone: 'neutral', icon: 'info', label: r.action || 'unknown' };
            return `<tr><td class="tool">${esc(r.tool)}</td><td>${badge(a.tone, a.icon, a.label)}</td><td class="extra">${r.extra ? esc(JSON.stringify(r.extra)) : ''}</td></tr>`;
          })
          .join('');
        const def = ACTION[p.default_action] || { tone: 'neutral', icon: 'info', label: p.default_action || 'unset' };
        return `<section class="policy">
          <div class="policy-head">
            <div class="aq-section-header"><span class="sh-icon">${icon('shield', 14)}</span><h3>${esc(p.name || p.file)}</h3><span class="sh-count">${p.rules.length} rules</span></div>
            <div class="muted t-xs"><code>${esc(p.file)}</code>${p.version ? ' · ' + esc(p.version) : ''}${scope ? ' · ' + esc(scope) : ''}</div>
          </div>
          <div class="aq-table-wrap"><table class="aq-table">
            <thead><tr><th scope="col">Tool</th><th scope="col">Action</th><th scope="col">Conditions</th></tr></thead>
            <tbody>${rows}
              <tr><td class="tool muted">default_action</td><td>${badge(def.tone, def.icon, def.label)}</td><td class="extra">applies to any tool not listed</td></tr>
            </tbody></table></div>
        </section>`;
      })
      .join('');
  }

  // ───────── run: log contract parser ─────────
  const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
  function parseLog(text) {
    const items = [];
    const byTool = new Map(); // tool -> last check item
    let pendingInjection = null;
    for (const raw of text.replace(ANSI, '').split('\n')) {
      const line = raw.trim();
      const at = line.indexOf('[armoriq]');
      if (at < 0) continue;
      const body = line.slice(at + '[armoriq]'.length).trim();
      let m;
      if ((m = body.match(/^plan:\s*(.*?)(?:\s*->\s*(.*))?$/))) {
        items.push({ type: 'plan', goal: m[1], tools: m[2] ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : [] });
      } else if ((m = body.match(/^check\s+(\S+):\s*(ALLOWED|HELD|BLOCKED)\s*(?:\((.*)\))?\s*$/))) {
        const it = { type: 'check', tool: m[1], status: m[2], reason: m[3] || '', args: null, hold: null, report: null, injection: pendingInjection };
        if (/prompt injection/i.test(it.reason)) it.injection = it.injection || 'prompt injection';
        pendingInjection = null;
        items.push(it);
        byTool.set(it.tool, it);
      } else if ((m = body.match(/^args\s+(\S+):\s*(.*)$/))) {
        const it = byTool.get(m[1]);
        if (it) {
          try { it.args = JSON.parse(m[2]); } catch { it.args = m[2]; }
        }
      } else if ((m = body.match(/^hold\s+(\S+):\s*(APPROVED|REJECTED)/))) {
        const it = byTool.get(m[1]);
        if (it) it.hold = m[2];
      } else if ((m = body.match(/^report\s+(\S+):\s*(.*)$/))) {
        const it = byTool.get(m[1]);
        if (it) it.report = m[2];
      } else if ((m = body.match(/^injection:\s*(.*)$/))) {
        pendingInjection = m[1] || 'prompt injection';
      }
    }
    return items;
  }
  const splitTool = (t) => {
    const i = t.indexOf('__');
    return i > 0 ? { mcp: t.slice(0, i), name: t.slice(i + 2) } : { mcp: '', name: t };
  };

  function argsGrid(args) {
    if (args == null) return '';
    const entries = typeof args === 'object' && !Array.isArray(args) ? Object.entries(args) : [['value', args]];
    if (!entries.length) return '';
    const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    return `<div class="iap-section"><div class="eyebrow">Arguments</div><dl>${entries
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(fmt(v))}</dd></div>`)
      .join('')}</dl></div>`;
  }

  function heldCard(it) {
    const { mcp, name } = splitTool(it.tool);
    let ledger;
    if (it.hold === 'APPROVED') ledger = `${icon('check', 14, 'tl-icon--good')}<span class="verdict-good">Approved (offline)</span><span class="muted">human approval simulated by OFFLINE_APPROVAL</span>`;
    else if (it.hold === 'REJECTED') ledger = `${icon('x', 14, 'tl-icon--bad')}<span class="verdict-bad">Rejected (offline)</span><span class="muted">call was not made</span>`;
    else ledger = `${icon('pause', 14)}<span class="verdict-warn">Awaiting approval</span>`;
    return `<section class="aq-iap tl-enter" aria-label="Held call ${esc(name)}">
      <header>
        <span class="iap-glyph">${icon('pause', 16)}</span>
        <div class="iap-title">
          ${badge('warn', 'pause', 'Held')}
          <span>wants to call</span><code class="tool">${esc(name)}</code>
          ${mcp ? `<span>on</span><span class="aq-chip">${esc(mcp)}</span>` : ''}
          ${it.injection ? badge('bad', 'alert', 'Prompt injection') : ''}
        </div>
      </header>
      ${argsGrid(it.args)}
      <div class="iap-section"><div class="iap-line">${icon('shield', 14)}<span class="iap-reason">${esc(it.reason || 'held by policy')}</span></div></div>
      <div class="iap-section"><div class="iap-line">${ledger}</div></div>
    </section>`;
  }

  function timelineHtml(items) {
    const out = [];
    let rows = [];
    const flush = () => {
      if (rows.length) out.push(`<div class="timeline-rows" role="list">${rows.join('')}</div>`);
      rows = [];
    };
    for (const it of items) {
      if (it.type === 'plan') {
        rows.push(`<div class="aq-row tl-enter" role="listitem"><span class="tl-icon">${icon('clipboard', 14)}</span><span class="row-main"><span class="row-title">Plan: ${esc(it.goal)}</span>${it.tools.length ? `<span class="tl-reason mono">${esc(it.tools.join(', '))}</span>` : ''}</span>${badge('neutral', 'scroll', 'Plan')}</div>`);
      } else if (it.status === 'HELD') {
        flush();
        out.push(heldCard(it));
      } else {
        const c = CHECK[it.status];
        const { mcp, name } = splitTool(it.tool);
        rows.push(`<div class="aq-row tl-enter" role="listitem"><span class="tl-icon tl-icon--${c.tone}">${icon(c.icon, 14)}</span>
          <span class="row-main"><span><span class="tl-tool">${esc(name)}</span>${mcp ? ` <span class="tl-mcp">${esc(mcp)}</span>` : ''}</span>
          ${it.reason ? `<span class="tl-reason">${esc(it.reason)}</span>` : ''}
          ${it.report ? `<span class="tl-reason">reported: ${esc(it.report)}</span>` : ''}
          ${it.injection && it.injection !== 'prompt injection' ? `<span class="tl-reason">${esc(it.injection)}</span>` : ''}</span>
          <span class="tl-badges">${it.injection ? badge('bad', 'alert', 'Prompt injection') : ''}${badge(c.tone, c.icon, c.label)}</span></div>`);
      }
    }
    flush();
    return out.join('');
  }

  const getRun = (id) => (state.runs[id] ||= { log: '', running: false, done: false, code: null, problem: null, ran: false });

  function renderRun() {
    const panel = $('#panel');
    const id = state.selectedId;
    const run = getRun(id);
    const items = parseLog(run.log);
    const counts = { ALLOWED: 0, HELD: 0, BLOCKED: 0 };
    items.forEach((i) => i.type === 'check' && counts[i.status]++);

    // Build the skeleton once per render; live updates only touch the dynamic regions.
    panel.innerHTML = `
      <div class="run-bar">
        <button type="button" id="btn-run" class="aq-button aq-button--primary">${icon('play', 14)}Run offline</button>
        <div class="field"><span class="muted t-xs" id="approval-label">Held calls</span>
          <div class="aq-segmented" role="radiogroup" aria-labelledby="approval-label">
            <button type="button" role="radio" data-approval="approve" aria-checked="${state.approval === 'approve'}">${icon('check', 12)}Approve</button>
            <button type="button" role="radio" data-approval="reject" aria-checked="${state.approval === 'reject'}">${icon('x', 12)}Reject</button>
          </div></div>
        <div class="aq-stats" id="stats" role="status" aria-label="Call counts"></div>
      </div>
      <div class="run-status" id="run-status"></div>
      <div class="timeline" id="timeline" aria-live="polite"></div>
      <details class="aq-collapsible" id="raw-details"><summary>${icon('chevron', 14, 'chev')}Raw log</summary><pre class="rawlog mono" id="rawlog"></pre></details>`;
    updateRun();
  }

  function updateRun() {
    if (state.tab !== 'run') return;
    const id = state.selectedId;
    const run = getRun(id);
    const stats = $('#stats');
    if (!stats) return;
    const items = parseLog(run.log);
    const counts = { ALLOWED: 0, HELD: 0, BLOCKED: 0 };
    items.forEach((i) => i.type === 'check' && counts[i.status]++);
    const stat = (tone, ic, name, n) => `<div class="aq-stat aq-stat--${tone}"><span class="aq-stat-label">${icon(ic, 12)}${name}</span><span class="aq-stat-value">${n}</span></div>`;
    stats.innerHTML = stat('good', 'check', 'Allowed', counts.ALLOWED) + stat('warn', 'pause', 'Held', counts.HELD) + stat('bad', 'block', 'Blocked', counts.BLOCKED);

    const btn = $('#btn-run');
    btn.disabled = run.running;
    btn.innerHTML = run.running ? `${icon('refresh', 14, 'spin')}Running` : `${icon('play', 14)}Run offline`;

    let status = '';
    const banner = (tone, ic, html) => `<div class="aq-banner aq-banner--${tone}" role="${tone === 'bad' ? 'alert' : 'status'}">${icon(ic, 16)}<div class="banner-body">${html}</div></div>`;
    if (run.problem) {
      const ic = run.problem.tone === 'warn' ? 'alert' : run.problem.tone === 'bad' ? 'alert' : 'info';
      status += banner(run.problem.tone, ic, esc(run.problem.text).replace(/`([^`]+)`/g, '<code>$1</code>'));
    }
    if (run.done && run.code != null && run.code !== 0) {
      status += banner('bad', 'alert', `The run exited with code <strong>${run.code}</strong>. Check the raw log below.`);
    }
    if (run.done && run.code === 0) {
      status += `<div>${badge('good', 'check', 'Finished with exit code 0')}</div>`;
    }
    $('#run-status').innerHTML = status;

    const tl = $('#timeline');
    if (items.length) {
      // Keep scroll position; re-render is cheap for demo-sized logs.
      tl.innerHTML = timelineHtml(items);
    } else if (run.ran && !run.running && !run.problem) {
      tl.innerHTML = `<div class="empty-timeline">No <code>[armoriq]</code> lines in the output. The raw log below shows what the recipe printed.</div>`;
    } else if (!run.ran) {
      tl.innerHTML = `<div class="empty-timeline">Run offline to see each tool call as allowed, held, or blocked. No network or API keys needed.</div>`;
    } else {
      tl.innerHTML = '';
    }
    const raw = $('#rawlog');
    raw.textContent = run.log || 'Nothing run yet.';
  }

  function startRun() {
    const id = state.selectedId;
    if (!id) return;
    if (state.es) state.es.close();
    const run = (state.runs[id] = { log: '', running: true, done: false, code: null, problem: null, ran: true });
    updateRun();
    const es = new EventSource(`/api/run/${encodeURI(id)}?approval=${state.approval}`);
    state.es = es;
    es.addEventListener('log', (e) => {
      run.log += JSON.parse(e.data).text;
      if (state.selectedId === id) updateRun();
    });
    es.addEventListener('problem', (e) => {
      run.problem = JSON.parse(e.data);
      if (state.selectedId === id) updateRun();
    });
    es.addEventListener('done', (e) => {
      run.running = false;
      run.done = true;
      run.code = JSON.parse(e.data).code;
      es.close();
      if (state.selectedId === id) updateRun();
    });
    es.onerror = () => {
      if (run.running) {
        run.running = false;
        run.done = true;
        run.problem = run.problem || { tone: 'bad', text: 'Lost connection to the server.' };
        es.close();
        if (state.selectedId === id) updateRun();
      }
    };
  }

  // ───────── selection ─────────
  async function selectRecipe(id, { push = true } = {}) {
    state.selectedId = id;
    state.file = null;
    state.policy = null;
    state.detail = null;
    const seq = ++state.detailSeq;
    renderRail();
    $('#view').innerHTML = `<div class="aq-page-state aq-page-state--loading"><span class="ps-icon">${icon('refresh', 18, 'spin')}</span><h2>Loading</h2></div>`;
    try {
      const res = await fetch('/api/recipe/' + encodeURI(id));
      const data = await res.json();
      if (seq !== state.detailSeq) return;
      state.detail = data.error ? null : data;
    } catch {
      state.detail = null;
    }
    if (push) history.replaceState(null, '', '#' + encodeURI(id) + (state.tab !== 'overview' ? '/' + state.tab : ''));
    renderRecipe();
    $('#main').scrollTop = 0;
  }

  // ───────── events ─────────
  function bind() {
    $('#btn-theme').addEventListener('click', () =>
      setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
    );
    $('#btn-checks').addEventListener('click', runChecks);
    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value;
      renderRail();
      if (!state.selectedId) renderHome();
    });
    $('#brand-home').addEventListener('click', (e) => {
      e.preventDefault();
      goHome();
    });
    $('#count').addEventListener('click', (e) => {
      if (e.target.id !== 'clear-filters') return;
      state.query = '';
      $('#search').value = '';
      renderRail();
      if (!state.selectedId) renderHome();
    });
    $('#rail-list').addEventListener('click', (e) => {
      if (e.target.closest('[data-home]')) return goHome();
      const b = e.target.closest('[data-id]');
      if (b) selectRecipe(b.dataset.id);
    });
    $('#view').addEventListener('click', (e) => {
      if (e.target.closest('[data-home]')) {
        e.preventDefault();
        return goHome();
      }
      const card = e.target.closest('.recipe-card');
      if (card) {
        state.tab = 'overview';
        return selectRecipe(card.dataset.id);
      }
      const lang = e.target.closest('button[data-lang]');
      if (lang) {
        state.homeLang = lang.dataset.lang;
        return renderHome();
      }
      if (e.target.closest('#btn-try')) {
        state.tab = 'run';
        history.replaceState(null, '', '#' + encodeURI(state.selectedId) + '/run');
        renderTab();
        return startRun();
      }
      const tab = e.target.closest('.aq-tab');
      if (tab) {
        state.tab = tab.dataset.tab;
        history.replaceState(null, '', '#' + encodeURI(state.selectedId) + (state.tab !== 'overview' ? '/' + state.tab : ''));
        return renderTab();
      }
      const f = e.target.closest('button[data-file]');
      if (f) return loadFile(f.dataset.file);
      const seg = e.target.closest('button[data-approval]');
      if (seg) {
        state.approval = seg.dataset.approval;
        document.querySelectorAll('button[data-approval]').forEach((b) => b.setAttribute('aria-checked', b === seg));
        return;
      }
      if (e.target.closest('#btn-run')) startRun();
    });
    $('#view').addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('aq-tab') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const tabs = $$tabs();
      const i = tabs.indexOf(e.target);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
  }

  async function init() {
    document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon, 14)));
    renderThemeButton();
    renderChecks();
    bind();
    try {
      const res = await fetch('/api/recipes');
      const data = await res.json();
      state.recipes = data.recipes;
      state.taxonomy = data.taxonomy;
    } catch (e) {
      $('#rail-list').innerHTML = `<div class="aq-page-state aq-page-state--error"><span class="ps-icon">${icon('alert', 18)}</span><h2>Could not load recipes</h2><p>${esc(e)}</p></div>`;
      return;
    }
    renderRail();
    const hash = decodeURIComponent(location.hash.slice(1));
    let startId = null;
    for (const r of state.recipes) {
      if (hash === r.id || hash.startsWith(r.id + '/')) {
        startId = r.id;
        const t = hash.slice(r.id.length + 1);
        if (TABS.some(([k]) => k === t)) state.tab = t;
      }
    }
    if (startId) selectRecipe(startId);
    else goHome({ push: false });
    runChecks();
  }

  window.addEventListener('DOMContentLoaded', init);
})();

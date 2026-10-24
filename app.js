/* Story Board – User-Story-Übersicht ohne Backend.
   Alle Daten liegen im localStorage dieses Browsers. */
(() => {
  'use strict';

  const KEY = 'storyboard.v1';
  const SESSION_KEY = 'storyboard.unlocked';
  const PRIO = {
    must:   { label: 'Must',   rank: 0, color: 'var(--must)' },
    should: { label: 'Should', rank: 1, color: 'var(--should)' },
    could:  { label: 'Could',  rank: 2, color: 'var(--could)' },
    wont:   { label: "Won't",  rank: 3, color: 'var(--wont)' },
  };
  const SWATCHES = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#111827'];

  const $ = (s, el = document) => el.querySelector(s);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Daten ----------
  const defaults = () => {
    const cols = [
      { id: uid(), name: 'Backlog' },
      { id: uid(), name: 'Bereit' },
      { id: uid(), name: 'In Arbeit' },
      { id: uid(), name: 'Review' },
      { id: uid(), name: 'Fertig' },
    ];
    const now = Date.now();
    const s = (title, role, want, benefit, priority, points, epic, col, criteria = []) => ({
      id: uid(), title, role, want, benefit, priority, points, epic, column: cols[col].id,
      criteria, created: now - Math.random() * 1e8,
    });
    return {
      settings: { appName: 'Story Board', color: '#4f46e5', logo: '', pwHash: '' },
      columns: cols,
      stories: [
        s('Konto anlegen', 'neue Nutzerin', 'mich mit E-Mail und Passwort registrieren', 'ich das Produkt nutzen kann', 'must', 3, 'Onboarding', 0, ['Bestätigungsmail wird versendet', 'Passwort mind. 8 Zeichen']),
        s('Passwort zurücksetzen', 'registrierter Nutzer', 'mein Passwort per E-Mail zurücksetzen', 'ich wieder Zugang bekomme', 'should', 2, 'Onboarding', 1, ['Link ist 24 h gültig']),
        s('Dashboard-Übersicht', 'Teamleiterin', 'die wichtigsten Kennzahlen auf einen Blick sehen', 'ich schnell entscheiden kann', 'must', 8, 'Reporting', 2),
        s('Export als CSV', 'Analyst', 'Daten als CSV exportieren', 'ich sie in Excel weiterverarbeiten kann', 'could', 3, 'Reporting', 0),
        s('Dunkelmodus', 'Nutzer', 'einen dunklen Modus aktivieren', 'die App abends angenehmer ist', 'wont', 2, 'UI', 0),
        s('Profilbild hochladen', 'Nutzerin', 'ein Profilbild hochladen', 'mein Team mich erkennt', 'could', 2, 'Profil', 4),
      ],
    };
  };

  let state;
  const load = () => {
    try { state = JSON.parse(localStorage.getItem(KEY)); } catch { state = null; }
    if (!state || !Array.isArray(state.columns) || !Array.isArray(state.stories)) state = defaults();
    state.settings = { ...defaults().settings, ...state.settings };
  };
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch { toast('Speichern fehlgeschlagen – evtl. ist das Logo zu groß.'); }
  };

  // ---------- Passwort ----------
  async function hash(pw) {
    const data = new TextEncoder().encode('storyboard:' + pw);
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381; for (const b of data) h = ((h << 5) + h + b) | 0; // Fallback ohne WebCrypto
    return 'djb2-' + (h >>> 0).toString(16);
  }

  function showLock() {
    const firstRun = !state.settings.pwHash;
    $('#app').hidden = true;
    $('#lock').hidden = false;
    $('#lockTitle').textContent = state.settings.appName;
    $('#lockHint').textContent = firstRun ? 'Lege ein Passwort für dieses Board fest.' : 'Bitte Passwort eingeben';
    $('#lockPw2').hidden = !firstRun;
    $('#lockPw2').required = firstRun;
    $('#lockPw').autocomplete = firstRun ? 'new-password' : 'current-password';
    $('#lockBtn').textContent = firstRun ? 'Passwort festlegen' : 'Entsperren';
    $('#lockError').hidden = true;
    $('#lockPw').value = $('#lockPw2').value = '';
    setTimeout(() => $('#lockPw').focus(), 50);
  }

  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#lockPw').value;
    const err = (m) => { $('#lockError').textContent = m; $('#lockError').hidden = false; };
    if (!state.settings.pwHash) {
      if (pw.length < 4) return err('Mindestens 4 Zeichen.');
      if (pw !== $('#lockPw2').value) return err('Passwörter stimmen nicht überein.');
      state.settings.pwHash = await hash(pw);
      save();
    } else if (await hash(pw) !== state.settings.pwHash) {
      $('#lockPw').value = '';
      return err('Falsches Passwort.');
    }
    sessionStorage.setItem(SESSION_KEY, state.settings.pwHash);
    unlock();
  });

  function unlock() {
    $('#lock').hidden = true;
    $('#app').hidden = false;
    render();
  }

  $('#lockNowBtn').addEventListener('click', () => { sessionStorage.removeItem(SESSION_KEY); showLock(); });

  // ---------- Branding ----------
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.45 ? '#111827' : '#ffffff';
  }
  function logoHTML(s) {
    return s.logo ? `<img src="${esc(s.logo)}" alt="">` : esc((s.appName || '?').trim().charAt(0).toUpperCase());
  }
  function applyBranding(s = state.settings) {
    const root = document.documentElement.style;
    root.setProperty('--primary', s.color);
    root.setProperty('--primary-ink', inkFor(s.color));
    $('meta[name=theme-color]').content = s.color;
    document.title = s.appName;
    $('#appName').textContent = s.appName;
    for (const el of [$('#logo'), $('#lockLogo')]) el.innerHTML = logoHTML(s);
  }

  // ---------- Rendering ----------
  let activeCol = 0;
  const ui = { search: '', sort: 'manual', epic: '' };

  function visibleStories(colId) {
    const q = ui.search.toLowerCase();
    let list = state.stories.filter((s) => s.column === colId &&
      (!ui.epic || s.epic === ui.epic) &&
      (!q || [s.title, s.role, s.want, s.benefit, s.epic, ...(s.criteria || [])].join(' ').toLowerCase().includes(q)));
    const by = {
      priority: (a, b) => PRIO[a.priority].rank - PRIO[b.priority].rank || (b.points || 0) - (a.points || 0),
      points: (a, b) => (b.points || 0) - (a.points || 0),
      epic: (a, b) => (a.epic || '~').localeCompare(b.epic || '~', 'de') || PRIO[a.priority].rank - PRIO[b.priority].rank,
      newest: (a, b) => b.created - a.created,
      title: (a, b) => a.title.localeCompare(b.title, 'de'),
    }[ui.sort];
    if (by) list = [...list].sort(by);
    return list;
  }

  function cardHTML(s, ci, idx, len) {
    const p = PRIO[s.priority] || PRIO.could;
    const sentence = (s.role || s.want || s.benefit)
      ? `<p class="sentence">Als <b>${esc(s.role || '…')}</b> möchte ich <b>${esc(s.want || '…')}</b>${s.benefit ? `, damit ${esc(s.benefit)}` : ''}.</p>` : '';
    const ac = (s.criteria || []).length;
    const manual = ui.sort === 'manual';
    return `<article class="card" draggable="true" data-id="${s.id}" style="--prio:${p.color}">
      <h4>${esc(s.title)}</h4>${sentence}
      <div class="meta">
        <span class="chip prio">${p.label}</span>
        ${s.epic ? `<span class="chip epic">${esc(s.epic)}</span>` : ''}
        ${ac ? `<span class="chip ac">✓ ${ac} AK</span>` : ''}
        ${s.points ? `<span class="chip pts">${s.points} SP</span>` : ''}
      </div>
      <div class="card-move">
        ${manual ? `<button data-move="up" ${idx === 0 ? 'disabled' : ''} aria-label="Nach oben">↑</button>
        <button data-move="down" ${idx === len - 1 ? 'disabled' : ''} aria-label="Nach unten">↓</button>` : ''}
        <button data-move="left" ${ci === 0 ? 'disabled' : ''} aria-label="Spalte zurück">←</button>
        <button data-move="right" ${ci === state.columns.length - 1 ? 'disabled' : ''} aria-label="Spalte vor">→</button>
      </div>
    </article>`;
  }

  function render() {
    applyBranding();
    activeCol = Math.min(activeCol, state.columns.length - 1);
    const board = $('#board');
    const scrollPos = board.scrollLeft;

    board.innerHTML = state.columns.map((c, ci) => {
      const list = visibleStories(c.id);
      const pts = list.reduce((a, s) => a + (+s.points || 0), 0);
      return `<section class="column" data-col="${c.id}">
        <div class="col-head"><span>${esc(c.name)} ${pts ? `<span class="col-points">· ${pts} SP</span>` : ''}</span><span class="count">${list.length}</span></div>
        ${list.length ? list.map((s, i) => cardHTML(s, ci, i, list.length)).join('') : '<div class="empty">Keine Stories</div>'}
      </section>`;
    }).join('');
    board.scrollLeft = scrollPos;

    $('#tabs').innerHTML = state.columns.map((c, i) =>
      `<button class="tab ${i === activeCol ? 'active' : ''}" data-i="${i}">${esc(c.name)}<span class="count">${visibleStories(c.id).length}</span></button>`).join('');

    const epics = [...new Set(state.stories.map((s) => s.epic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    $('#epicFilter').innerHTML = '<option value="">Alle Epics</option>' + epics.map((e) => `<option ${e === ui.epic ? 'selected' : ''}>${esc(e)}</option>`).join('');
    $('#epicList').innerHTML = epics.map((e) => `<option value="${esc(e)}">`).join('');
  }

  // Tabs ↔ horizontales Scrollen (Mobil)
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    activeCol = +t.dataset.i;
    const col = $('#board').children[activeCol];
    $('#board').scrollTo({ left: col.offsetLeft - 16, behavior: 'smooth' });
    markTab();
  });
  let scrollT;
  $('#board').addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const b = $('#board'); const w = b.children[0]?.offsetWidth || 1;
      activeCol = Math.round(b.scrollLeft / (w + 12));
      markTab();
    }, 80);
  });
  function markTab() {
    [...$('#tabs').children].forEach((t, i) => {
      t.classList.toggle('active', i === activeCol);
      if (i === activeCol) t.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  }

  $('#search').addEventListener('input', (e) => { ui.search = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#epicFilter').addEventListener('change', (e) => { ui.epic = e.target.value; render(); });

  // ---------- Verschieben ----------
  function moveStory(id, toColId, beforeId = null) {
    const i = state.stories.findIndex((s) => s.id === id);
    const [s] = state.stories.splice(i, 1);
    s.column = toColId;
    let at = beforeId ? state.stories.findIndex((x) => x.id === beforeId) : -1;
    if (at < 0) { // ans Ende der Zielspalte
      at = state.stories.length;
      for (let k = state.stories.length - 1; k >= 0; k--) if (state.stories[k].column === toColId) { at = k + 1; break; }
    }
    state.stories.splice(at, 0, s);
    save(); render();
  }

  $('#board').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (!btn) return openStory(id);
    e.stopPropagation();
    const s = state.stories.find((x) => x.id === id);
    const ci = state.columns.findIndex((c) => c.id === s.column);
    const dir = btn.dataset.move;
    if (dir === 'left' || dir === 'right') {
      const target = state.columns[ci + (dir === 'left' ? -1 : 1)];
      if (target) moveStory(id, target.id);
    } else {
      const list = visibleStories(s.column);
      const idx = list.findIndex((x) => x.id === id);
      if (dir === 'up' && idx > 0) moveStory(id, s.column, list[idx - 1].id);
      if (dir === 'down' && idx < list.length - 1) moveStory(id, s.column, list[idx + 2]?.id || null);
    }
  });

  // Drag & Drop (Desktop)
  let dragId = null;
  $('#board').addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    dragId = c.dataset.id; c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  $('#board').addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  $('#board').addEventListener('dragover', (e) => {
    const col = e.target.closest('.column'); if (!col || !dragId) return;
    e.preventDefault();
    document.querySelectorAll('.column.drop').forEach((el) => el !== col && el.classList.remove('drop'));
    col.classList.add('drop');
  });
  $('#board').addEventListener('drop', (e) => {
    const col = e.target.closest('.column'); if (!col || !dragId) return;
    e.preventDefault();
    let before = null;
    if (ui.sort === 'manual') {
      const cards = [...col.querySelectorAll('.card:not(.dragging)')];
      before = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2)?.dataset.id || null;
    }
    moveStory(dragId, col.dataset.col, before);
  });

  // ---------- Story-Dialog ----------
  const storyDlg = $('#storyDlg');
  let editingId = null;

  function openStory(id = null) {
    editingId = id;
    const f = $('#storyForm');
    const s = id ? state.stories.find((x) => x.id === id)
      : { title: '', role: '', want: '', benefit: '', criteria: [], priority: 'could', points: '', epic: ui.epic, column: state.columns[activeCol]?.id };
    $('#storyDlgTitle').textContent = id ? 'Story bearbeiten' : 'Neue Story';
    $('#deleteStoryBtn').hidden = !id;
    $('#columnSelect').innerHTML = state.columns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    for (const k of ['title', 'role', 'want', 'benefit', 'priority', 'epic', 'column']) f.elements[k].value = s[k] ?? '';
    f.elements.points.value = s.points ? String(s.points) : '';
    f.elements.criteria.value = (s.criteria || []).join('\n');
    storyDlg.showModal();
  }
  $('#addBtn').addEventListener('click', () => openStory());

  storyDlg.addEventListener('close', () => {
    if (storyDlg.returnValue !== 'save') return;
    const f = $('#storyForm').elements;
    const data = {
      title: f.title.value.trim(), role: f.role.value.trim(), want: f.want.value.trim(), benefit: f.benefit.value.trim(),
      criteria: f.criteria.value.split('\n').map((l) => l.trim()).filter(Boolean),
      priority: f.priority.value, points: f.points.value ? +f.points.value : '', epic: f.epic.value.trim(),
    };
    if (!data.title) return;
    if (editingId) {
      const s = state.stories.find((x) => x.id === editingId);
      Object.assign(s, data);
      if (s.column !== f.column.value) return moveStory(s.id, f.column.value);
      save();
    } else {
      state.stories.push({ id: uid(), created: Date.now(), column: f.column.value, ...data });
      save();
      toast('Story angelegt');
    }
    render();
  });
  $('#deleteStoryBtn').addEventListener('click', () => {
    if (!confirm('Diese Story wirklich löschen?')) return;
    state.stories = state.stories.filter((s) => s.id !== editingId);
    save(); storyDlg.close('deleted'); render(); toast('Story gelöscht');
  });

  // ---------- Einstellungen ----------
  const setDlg = $('#settingsDlg');
  let draft = null; // Vorschau für Farbe/Logo/Name

  $('#swatches').innerHTML = SWATCHES.map((c) => `<button type="button" class="swatch" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('');

  function previewDraft() {
    applyBranding(draft);
    $('#logoPreview').innerHTML = logoHTML(draft);
  }

  $('#settingsBtn').addEventListener('click', () => {
    draft = { ...state.settings };
    const f = $('#settingsForm').elements;
    f.appName.value = draft.appName;
    f.color.value = draft.color;
    f.columns.value = state.columns.map((c) => c.name).join('\n');
    f.newPw.value = '';
    previewDraft();
    setDlg.showModal();
  });

  const sf = $('#settingsForm').elements;
  sf.color.addEventListener('input', (e) => { draft.color = e.target.value; previewDraft(); });
  sf.appName.addEventListener('input', (e) => { draft.appName = e.target.value || 'Story Board'; previewDraft(); });
  $('#swatches').addEventListener('click', (e) => {
    const c = e.target.dataset.c; if (!c) return;
    draft.color = c; sf.color.value = c; previewDraft();
  });

  $('#logoInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { // auf 256 px verkleinern, damit es in den Speicher passt
      const max = 256, r = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      draft.logo = cv.toDataURL('image/png');
      URL.revokeObjectURL(url); previewDraft();
    };
    img.onerror = () => toast('Bild konnte nicht gelesen werden.');
    img.src = url;
  });
  $('#logoReset').addEventListener('click', () => { draft.logo = ''; previewDraft(); });

  setDlg.addEventListener('close', async () => {
    if (setDlg.returnValue !== 'save') { applyBranding(); return; }
    const f = $('#settingsForm').elements;
    // Spalten abgleichen (nach Name, damit IDs erhalten bleiben)
    const names = f.columns.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (names.length) {
      const old = [...state.columns];
      state.columns = names.map((n, i) => old.find((c) => c.name === n) || (old[i] && !names.includes(old[i].name) ? { ...old[i], name: n } : { id: uid(), name: n }));
      const ids = new Set(state.columns.map((c) => c.id));
      state.stories.forEach((s) => { if (!ids.has(s.column)) s.column = state.columns[0].id; });
    }
    if (f.newPw.value) {
      if (f.newPw.value.length < 4) toast('Passwort zu kurz – nicht geändert.');
      else { draft.pwHash = await hash(f.newPw.value); sessionStorage.setItem(SESSION_KEY, draft.pwHash); toast('Passwort geändert'); }
    }
    state.settings = { ...draft };
    save(); render();
  });

  $('#exportBtn').addEventListener('click', () => {
    const data = { ...state, settings: { ...state.settings, pwHash: undefined } };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.settings.appName || 'storyboard').replace(/\W+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.columns) || !Array.isArray(data.stories)) throw new Error();
      if (!confirm('Aktuelle Daten durch den Import ersetzen?')) return;
      const pwHash = state.settings.pwHash;
      state = { ...data, settings: { ...defaults().settings, ...data.settings, pwHash } };
      save(); setDlg.close('imported'); render(); toast('Import erfolgreich');
    } catch { toast('Ungültige Datei'); }
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Wirklich alle Stories, Einstellungen und das Passwort löschen?')) return;
    localStorage.removeItem(KEY); sessionStorage.removeItem(SESSION_KEY);
    location.reload();
  });

  // ---------- Toast ----------
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------- Start ----------
  load();
  applyBranding();
  if (state.settings.pwHash && sessionStorage.getItem(SESSION_KEY) === state.settings.pwHash) unlock();
  else showLock();
})();

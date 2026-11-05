// The lead board (Asana S3.2): every lead in the team list with its
// follow-up, filters and metric tiles. Opened from the capture app at
// leads/, at the same address, so it shares the app's sign-in. Contact
// details stay as captured; only the follow-up is edited here.

import { getSettings, isConfigured, getState, setState } from '../js/settings.js';
import * as auth from '../js/auth.js';
import { SupabaseStore, teamLeadFromRow, StoreError, NOT_ON_TEAM, NEEDS_DB_UPDATE } from '../js/store.js';
import { withInitialContact, filterLeads, metrics, POTENTIALS, STATUSES } from '../js/followup.js';
import { SOURCE_LABELS, displayName } from '../js/fields.js';
import { teamWorkbook, shareOrDownload } from '../js/exporters.js';
import { XLSX_TYPE } from '../js/xlsx.js';
import { localDay } from '../js/events.js';

const board = document.getElementById('board');
const drawer = document.getElementById('lead');
const PHOTO_LINK_DAYS = 7;
const FILTERS = 'boardFilters';
const NO_FILTERS = { event: '', person: '', potential: '', status: '', q: '' };

// Short labels for the table; the full ones are in the details and filters.
const SHORT = {
  'Initial Email Sent': 'Email 1',
  'Second Email Sent': 'Email 2',
  'Email Conversation Started': 'Conversation',
  'Call Booked': 'Call booked',
  'Signed up for Newsletter': 'Newsletter',
  'Moved to BD Pipeline': 'BD pipeline',
  'Not Interested/No Response': 'Not interested',
};
const RANK = { High: 0, Medium: 1, Low: 2, '': 3 };

const state = {
  store: null,
  leads: [],
  people: new Map(), // user ID -> name
  ready: true, // false: the database lacks the follow-up columns
  loaded: false,
  filters: { ...NO_FILTERS, ...getState(FILTERS, {}) },
  sort: { key: 'createdAt', dir: -1 },
  openId: null,
  photos: new Map(), // card photo path -> link
  saving: Promise.resolve(),
  pending: 0,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function toast(message, timeout = 3500) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  if (timeout) toast.timer = setTimeout(() => el.classList.remove('show'), timeout);
}

const personName = (id) => (id ? state.people.get(id) ?? 'Someone no longer on the team' : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const webLink = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

// ---------- loading ----------

async function start() {
  const s = getSettings();
  if (!isConfigured(s)) return notice('info', 'InfoCapture is not connected on this device yet. <a href="../#/settings">Open the app\'s settings</a>.');
  await auth.initAuth(s);
  state.store = new SupabaseStore(auth.getClient());
  if (!auth.getAccount()) return showSignIn();
  await load();
}

async function load({ quiet = false } = {}) {
  if (!navigator.onLine) return notice('warn', 'No connection. The lead board needs signal; captures keep working in the app.', true);
  if (!quiet && !state.loaded) board.innerHTML = `<p class="boot">${icon('refresh', 'spin small')} Loading the team's leads...</p>`;
  try {
    if (!(await auth.isTeamMember())) return notice('danger', esc(NOT_ON_TEAM));
    const [rows, people] = await Promise.all([
      state.store.listAll(),
      state.store.teamList().catch((err) => {
        if (err.message !== NEEDS_DB_UPDATE) throw err;
        return null;
      }),
    ]);
    state.ready = people !== null;
    state.people = people ?? new Map();
    state.leads = withInitialContact(rows.map(teamLeadFromRow), state.people);
    state.loaded = true;
  } catch (err) {
    if (err instanceof auth.AuthRequiredError) return showSignIn('Your sign-in has expired. Sign in again.');
    if (err instanceof auth.NetworkError) return notice('warn', 'No connection. The lead board needs signal.', true);
    console.error(err);
    return notice('danger', esc(err.message || String(err)), true);
  }
  document.getElementById('bar-actions').hidden = false;
  render();
  if (state.openId) renderDrawer();
}

function notice(tone, html, retry = false) {
  board.innerHTML = `<div class="banner ${tone}">${icon(tone === 'info' ? 'cloud-off' : 'alert')}<div>${html}</div>${retry ? '<button type="button" class="btn small ghost" data-action="refresh">Try again</button>' : ''}</div>`;
}

function showSignIn(message = '') {
  document.getElementById('bar-actions').hidden = true;
  board.innerHTML = `
    <form class="card sign-in-card" id="sign-in-form">
      <h2>Sign in to see the team's leads</h2>
      ${message ? `<p class="hint">${esc(message)}</p>` : ''}
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="btn primary">Sign in</button>
      <div id="sign-in-result"></div>
      <p class="hint">The same login as the InfoCapture app.</p>
    </form>`;
  board.querySelector('#sign-in-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password } = Object.fromEntries(new FormData(e.target));
    const out = board.querySelector('#sign-in-result');
    out.innerHTML = `<p class="muted">${icon('refresh', 'spin small')} Signing in...</p>`;
    try {
      await auth.signIn(email, password);
    } catch (err) {
      out.innerHTML = `<p class="bad-text">${icon('alert', 'small')} ${esc(err.message)}</p>`;
      return;
    }
    await load();
  });
}

// ---------- the board ----------

function shownLeads() {
  const { key, dir } = state.sort;
  const value = (l) => {
    if (key === 'name') return displayName(l).toLowerCase();
    if (key === 'potential') return RANK[l.potential] ?? 3;
    if (key === 'followUpBy') return personName(l.followUpBy).toLowerCase() || '\uffff';
    if (key === 'initialContact') return l.initialContact.toLowerCase() || '\uffff';
    return String(l[key] ?? '').toLowerCase();
  };
  return filterLeads(state.leads, state.filters).sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

function render() {
  if (!board.querySelector('#filters')) {
    board.innerHTML = `
      ${state.ready ? '' : `<div class="banner warn">${icon('alert')}<div>${esc(NEEDS_DB_UPDATE)} Until then the follow-up fields cannot be saved.</div></div>`}
      <section id="filters" class="filters" aria-label="Filters"></section>
      <section id="tiles" class="tiles" aria-label="Metrics"></section>
      <p class="tiles-note">The numbers count the leads shown. Each one counts leads with that status ticked.</p>
      <section id="table" aria-label="Leads"></section>`;
  }
  renderFilters();
  renderResults();
}

function renderFilters() {
  const f = state.filters;
  const events = [...new Set(state.leads.map((l) => l.event).filter(Boolean).concat(f.event ? [f.event] : []))].sort();
  const people = [...state.people].sort((a, b) => a[1].localeCompare(b[1]));
  const select = (name, label, options) => `<label><span>${label}</span><select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${v === f[name] ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const any = Object.keys(NO_FILTERS).some((k) => f[k]);
  board.querySelector('#filters').innerHTML = `
    ${select('event', 'Event', [['', 'All events'], ...events.map((e) => [e, e])])}
    ${select('person', 'Follow-up', [['', 'Anyone'], ['-', 'Not assigned'], ...people])}
    ${select('potential', 'Potential', [['', 'Any'], ...POTENTIALS.map((p) => [p, p]), ['-', 'Not set']])}
    ${select('status', 'Status', [['', 'Any'], ...STATUSES.map((s) => [s, s]), ['-', 'No status yet']])}
    <label class="search-filter"><span>Search</span><input type="search" name="q" value="${esc(f.q)}" placeholder="Name, organization, notes..." autocomplete="off"></label>
    ${any ? '<button type="button" class="link-btn" data-action="clear-filters">Clear filters</button>' : ''}`;
}

function renderResults() {
  const shown = shownLeads();
  const m = metrics(shown);
  const perEvent = state.filters.event
    ? `<span class="sub">${esc(state.filters.event)}</span>`
    : `<ul class="per-event">${m.perEvent.map(([e, n]) => `<li><span>${esc(e)}</span><b>${n}</b></li>`).join('')}</ul>`;
  board.querySelector('#tiles').innerHTML = `
    <div class="tile total" data-metric="total"><span class="label">Leads captured</span><span class="num">${m.total}</span>${m.total ? perEvent : ''}</div>
    ${m.tiles.map((t) => `<div class="tile" data-metric="${t.key}"><span class="label">${esc(t.label)}</span><span class="num">${t.count}</span><span class="sub">${t.pct}% of leads</span></div>`).join('')}`;
  board.querySelector('#table').innerHTML = tableHtml(shown);
}

const COLUMNS = [
  { key: 'event', label: 'Event' },
  { key: 'name', label: 'Name' },
  { key: 'company', label: 'Organization' },
  { key: 'email', label: 'Email' },
  { key: 'tags', label: 'Tags', fixed: true },
  { key: 'initialContact', label: 'Initial Contact' },
  { key: 'potential', label: 'Potential' },
  { key: 'followUpStatus', label: 'Status', fixed: true },
  { key: 'followUpBy', label: 'Follow-up' },
];

function tableHtml(shown) {
  if (!state.leads.length) return '<div class="empty-board">No leads in the team list yet. Captures from the app show up here.</div>';
  if (!shown.length) return '<div class="empty-board">No leads match these filters.</div>';
  const { key, dir } = state.sort;
  const head = COLUMNS.map((c) => {
    if (c.fixed) return `<th scope="col">${c.label}</th>`;
    const on = key === c.key;
    return `<th scope="col"${on ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-action="sort" data-key="${c.key}">${c.label}${on ? `<span class="dir">${dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`;
  }).join('');
  const row = (l) => {
    const cell = (k, label, html) => `<td data-col="${k}"${label && html ? ` data-label="${label}"` : ''}>${html}</td>`;
    const name = displayName(l) || 'No name';
    return `<tr data-action="open" data-id="${esc(l.id)}">
      ${cell('event', 'Event', esc(l.event))}
      ${cell('name', '', `<button type="button" class="name-btn" data-action="open" data-id="${esc(l.id)}">${esc(name)}</button>${l.title ? `<small>${esc(l.title)}</small>` : ''}`)}
      ${cell('company', 'Organization', esc(l.company))}
      <td data-col="email" class="email">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}</td>
      ${cell('tags', 'Tags', l.tags?.length ? `<span class="chips">${l.tags.map((t) => `<span class="mini">${esc(t)}</span>`).join('')}</span>` : '')}
      ${cell('initialContact', 'Initial contact', `${esc(l.initialContact)}${l.otherCaptures.length ? `<small>Captured ${l.otherCaptures.length + 1} times</small>` : ''}`)}
      ${cell('potential', '', l.potential ? `<span class="pot ${esc(l.potential)}">${esc(l.potential)}</span>` : '')}
      ${cell('followUpStatus', 'Status', l.followUpStatus.length ? `<span class="chips">${l.followUpStatus.map((s) => `<span class="mini" title="${esc(s)}">${esc(SHORT[s] ?? s)}</span>`).join('')}</span>` : '')}
      ${cell('followUpBy', 'Follow-up', esc(personName(l.followUpBy)))}
    </tr>`;
  };
  return `<div class="table-wrap"><table class="leads-table"><thead><tr>${head}</tr></thead><tbody>${shown.map(row).join('')}</tbody></table></div>`;
}

// ---------- one lead ----------

function openLead(id) {
  state.openId = id;
  renderDrawer();
  if (!drawer.open) drawer.showModal();
}

function renderDrawer() {
  const l = state.leads.find((x) => x.id === state.openId);
  if (!l) {
    drawer.close();
    return;
  }
  const disabled = state.ready ? '' : ' disabled';
  const people = [...state.people].sort((a, b) => a[1].localeCompare(b[1]));
  if (l.followUpBy && !state.people.has(l.followUpBy)) people.push([l.followUpBy, personName(l.followUpBy)]);
  const detail = (label, html) => (html ? `<dt>${label}</dt><dd>${html}</dd>` : '');
  const sub = [l.title, l.company].filter(Boolean).join(' · ');
  drawer.innerHTML = `
    <header class="drawer-head">
      <div><h2>${esc(displayName(l) || 'No name')}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('x')}</button>
    </header>
    <div class="drawer-body">
      <section class="card" aria-label="Follow-up">
        <h3>Follow-up</h3>
        <div class="field"><span>Potential</span><div class="seg">${POTENTIALS.map((p) => `<button type="button" class="chip${l.potential === p ? ' on' : ''}" data-action="potential" data-value="${p}" aria-pressed="${l.potential === p}"${disabled}>${p}</button>`).join('')}</div></div>
        <fieldset class="statuses"><legend>Status</legend>
          ${STATUSES.map((s) => `<label class="check"><input type="checkbox" data-status="${esc(s)}"${l.followUpStatus.includes(s) ? ' checked' : ''}${disabled}><span>${esc(s)}</span></label>`).join('')}
        </fieldset>
        <label class="field"><span>Follow-up person</span><select data-field="followUpBy"${disabled}><option value="">Not assigned</option>${people.map(([id, n]) => `<option value="${esc(id)}"${id === l.followUpBy ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <p class="save-state" id="save-state" aria-live="polite"></p>
      </section>
      <div id="lead-photo">${photoHtml(l)}</div>
      <section class="card" aria-label="Contact details">
        <h3>Contact</h3>
        <dl class="details">
          ${detail('Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '')}
          ${detail('Phone', l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '')}
          ${detail('Other phone', l.phoneAlt ? `<a href="tel:${esc(l.phoneAlt)}">${esc(l.phoneAlt)}</a>` : '')}
          ${detail('Website', l.website ? `<a href="${esc(webLink(l.website))}" target="_blank" rel="noopener">${esc(l.website)}</a>` : '')}
          ${detail('LinkedIn', l.linkedin ? `<a href="${esc(webLink(l.linkedin))}" target="_blank" rel="noopener">${esc(l.linkedin)}</a>` : '')}
          ${detail('Address', esc(l.address))}
          ${detail('Other info', esc(l.other))}
          ${detail('Tags', esc((l.tags ?? []).join(', ')))}
          ${detail('Notes', esc(l.notes))}
          ${detail('Event', esc(l.event))}
          ${detail('Initial contact', esc(l.initialContact))}
          ${detail('Captured', esc([when(l.createdAt), l.capturedByName && `by ${l.capturedByName}`].filter(Boolean).join(' ')))}
          ${detail('Also captured', l.otherCaptures.map((c) => `<button type="button" class="link-btn" data-action="open" data-id="${esc(c.id)}">${esc([c.who || 'Someone', when(c.at)].join(', '))}</button>`).join('<br>'))}
          ${detail('Source', esc(SOURCE_LABELS[l.source] ?? l.source))}
          ${detail('QR data', l.qrRaw ? `<code>${esc(l.qrRaw)}</code>` : '')}
        </dl>
        <p class="hint">Contact details are as captured; they are changed in the app on the phone that captured them.</p>
      </section>
    </div>`;
  if (l.cardPhotoPath && !state.photos.has(l.cardPhotoPath)) loadPhoto(l.cardPhotoPath);
}

function photoHtml(l) {
  const url = l.cardPhotoPath && state.photos.get(l.cardPhotoPath);
  return url ? `<a class="card-photo" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Card photo"></a>` : '';
}

async function loadPhoto(path) {
  try {
    const url = (await state.store.signedUrls([path], 3600)).get(path);
    if (!url) return;
    state.photos.set(path, url);
    const l = state.leads.find((x) => x.id === state.openId);
    if (l?.cardPhotoPath === path) drawer.querySelector('#lead-photo').innerHTML = photoHtml(l);
  } catch {
    // no photo link: the details show without it
  }
}

// Saves run one after another, so a quick run of ticks lands in order.
function saveFollowUp(patch) {
  const l = state.leads.find((x) => x.id === state.openId);
  if (!l || !state.ready) return;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, l[k]]));
  Object.assign(l, patch);
  renderResults();
  renderDrawer();
  setSaveState('Saving...');
  state.pending += 1;
  state.saving = state.saving.then(async () => {
    try {
      await state.store.updateFollowUp(l.id, patch);
      setSaveState('Saved');
    } catch (err) {
      Object.assign(l, before);
      renderResults();
      if (state.openId === l.id) renderDrawer();
      const message = err instanceof auth.NetworkError ? 'No connection: not saved. Try again when you have signal.' : `Not saved: ${err.message}`;
      setSaveState(message, true);
      toast(message, 6000);
    } finally {
      state.pending -= 1;
    }
  });
}

function setSaveState(text, bad = false) {
  const el = drawer.querySelector('#save-state');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

async function download(btn) {
  const shown = shownLeads();
  if (!shown.length) return toast('No leads to put in a spreadsheet.');
  btn.disabled = true;
  toast('Building the spreadsheet...', 0);
  try {
    const paths = shown.map((l) => l.cardPhotoPath).filter(Boolean);
    const links = paths.length ? await state.store.signedUrls(paths, PHOTO_LINK_DAYS * 86400) : new Map();
    const label = state.filters.event ? `${state.filters.event.replace(/[^\w\s-]/g, '').trim()} ` : '';
    const result = await shareOrDownload(`InfoCapture leads ${label}${localDay()}.xlsx`, teamWorkbook(shown, links, state.people), XLSX_TYPE);
    toast(result === 'cancelled' ? 'Cancelled' : `Spreadsheet ready: ${shown.length} lead${shown.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err instanceof StoreError || err instanceof auth.NetworkError ? err.message : 'Could not build the spreadsheet.');
  } finally {
    btn.disabled = false;
  }
}

// ---------- events ----------

const actions = {
  open: (el) => openLead(el.dataset.id),
  close: () => drawer.close(),
  refresh: () => load(),
  download: (el) => download(el),
  sort(el) {
    const { key } = el.dataset;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
    renderResults();
  },
  'clear-filters'() {
    state.filters = { ...NO_FILTERS };
    setState(FILTERS, null);
    render();
  },
  potential(el) {
    const l = state.leads.find((x) => x.id === state.openId);
    saveFollowUp({ potential: l?.potential === el.dataset.value ? '' : el.dataset.value });
  },
};

document.addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // email and web links open as links
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  Promise.resolve(actions[el.dataset.action]?.(el)).catch((err) => toast(err.message || 'Something went wrong'));
});

board.addEventListener('input', (e) => {
  const { name, value } = e.target;
  if (!(name in NO_FILTERS)) return;
  state.filters[name] = value;
  setState(FILTERS, state.filters);
  if (e.target.tagName === 'SELECT') renderFilters();
  renderResults();
});

drawer.addEventListener('change', (e) => {
  const l = state.leads.find((x) => x.id === state.openId);
  if (!l) return;
  if (e.target.dataset.status) {
    const set = new Set(l.followUpStatus);
    if (e.target.checked) set.add(e.target.dataset.status);
    else set.delete(e.target.dataset.status);
    saveFollowUp({ followUpStatus: STATUSES.filter((s) => set.has(s)) });
  } else if (e.target.dataset.field) {
    saveFollowUp({ [e.target.dataset.field]: e.target.value });
  }
});

// A tap on the dimmed backdrop closes the details.
drawer.addEventListener('click', (e) => {
  if (e.target === drawer) drawer.close();
});
drawer.addEventListener('close', () => {
  state.openId = null;
});

// Back on the board after a while: pick up the team's changes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.loaded && !state.pending) load({ quiet: true });
});

start().catch((err) => {
  console.error(err);
  notice('danger', esc(err.message || String(err)), true);
});

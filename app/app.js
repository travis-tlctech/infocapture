import * as db from './js/db.js';
import { getSettings, saveSettings, isConfigured, getState, setState, DEFAULT_TAGS } from './js/settings.js';
import * as auth from './js/auth.js';
import { Syncer, needsSync } from './js/sync.js';
import { NOT_ON_TEAM, fromRow } from './js/store.js';
import { CONTACT_FIELDS, SOURCE_LABELS, emptyContact, displayName, applyReading } from './js/fields.js';
import { parseQr, worthAskingCardReader, encodeSetup, decodeSetup } from './js/parsers.js';
import { QrScanner, decodeQrFromFile } from './js/scanner.js';
import { prepareImage } from './js/image.js';
import { readCardPhoto, readQrText, pingCardReader } from './js/cardreader.js';
import { toCsv, toVCard, teamWorkbook, shareOrDownload } from './js/exporters.js';
import { XLSX_TYPE } from './js/xlsx.js';

const app = document.getElementById('app');
const syncer = new Syncer();
const ui = { view: null, scanner: null, form: null, search: '', objectUrls: [], stack: [], replacing: false };

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const now = () => new Date().toISOString();
const isOnline = () => navigator.onLine;
const PHOTO_LINK_DAYS = 7; // how long card photo links in a downloaded spreadsheet keep working

function toast(message, { action, onAction, timeout = 3500 } = {}) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.classList.add('show');
  el.querySelector('button')?.addEventListener('click', () => {
    el.classList.remove('show');
    onAction?.();
  });
  clearTimeout(toast.timer);
  if (timeout) toast.timer = setTimeout(() => el.classList.remove('show'), timeout);
}

function timeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function trackUrl(url) {
  ui.objectUrls.push(url);
  return url;
}

function releaseUrls() {
  ui.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  ui.objectUrls = [];
}

function go(hash, { replace = false } = {}) {
  if ((location.hash || '#/') === hash) return route();
  ui.replacing = replace;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

// In-app back: step back through history only when the previous entry is
// one of ours, so the button never leaves the app.
function goBack() {
  if (ui.stack.length > 1) history.back();
  else go('#/', { replace: true });
}

function trackHistory(hash) {
  const st = ui.stack;
  if (ui.replacing && st.length) st[st.length - 1] = hash;
  else if (st[st.length - 2] === hash) st.pop();
  else if (st[st.length - 1] !== hash) st.push(hash);
  ui.replacing = false;
}

// ---------- records ----------

function newRecord(source, fields = {}) {
  const s = getSettings();
  const t = now();
  return {
    id: uuid(),
    createdAt: t,
    updatedAt: t,
    source,
    event: s.event,
    capturedBy: s.capturedBy || auth.getAccount()?.name || '',
    ...emptyContact(),
    ...fields,
    tags: [],
    notes: '',
    qrRaw: '',
    cardPhotoPath: '',
    hasImage: false,
    parseStatus: 'none',
    isDraft: true,
    syncStatus: 'pending',
  };
}

// Marks a content change. Saved records go back in the sync queue.
function touch(rec) {
  rec.updatedAt = now();
  if (!rec.isDraft) rec.syncStatus = 'pending';
  return rec;
}

function findDuplicate(rec, all) {
  const email = (rec.email || '').trim().toLowerCase();
  return all.find(
    (r) => r.id !== rec.id && !r.deleted && ((email && (r.email || '').trim().toLowerCase() === email) || (rec.qrRaw && r.qrRaw === rec.qrRaw)),
  );
}

// ---------- routing ----------

async function route() {
  const hash = location.hash || '#/';
  trackHistory(hash);
  await leaveView();
  if (hash.startsWith('#/scan')) return renderScan();
  if (hash.startsWith('#/c/')) return renderForm(decodeURIComponent(hash.slice(4)));
  if (hash.startsWith('#/settings')) return renderSettings();
  return renderHome();
}

async function leaveView() {
  if (ui.scanner) {
    ui.scanner.stop();
    ui.scanner = null;
  }
  if (ui.form) await closeForm();
  releaseUrls();
  window.scrollTo(0, 0);
}

// ---------- home ----------

function syncPill() {
  const { state, pending } = syncer.status;
  const map = {
    idle: pending ? [`${pending} to send`, 'cloud-up', 'warn'] : ['Synced', 'check', 'ok'],
    syncing: ['Syncing', 'refresh', 'busy'],
    offline: [`${pending} offline`, 'cloud-off', 'warn'],
    'signed-out': ['Sign in', 'cloud-off', 'warn'],
    'needs-auth': ['Sign in', 'alert', 'warn'],
    'not-configured': [pending ? `${pending} on phone` : 'Not set up', 'cloud-off', 'muted'],
    error: ['Sync issue', 'alert', 'danger'],
  };
  const [label, ic, tone] = map[state] ?? map.idle;
  return `<button type="button" class="sync-pill ${tone}" data-action="sync" aria-label="Sync status: ${esc(label)}">${icon(ic, state === 'syncing' ? 'spin' : '')}<span>${esc(label)}</span></button>`;
}

function banners() {
  const s = getSettings();
  const st = syncer.status;
  const out = [];
  if (!isConfigured(s)) {
    out.push(`<div class="banner info">${icon('cloud-off')}<div><strong>Not connected yet.</strong> Captures stay on this phone until it is set up. <a href="#/settings">Open settings</a></div></div>`);
  } else if (st.state === 'signed-out' || (!auth.getAccount() && auth.isAuthReady())) {
    out.push(`<div class="banner info">${icon('cloud-off')}<div>Sign in so your contacts reach the team list.</div><button type="button" class="btn small" data-action="sign-in">Sign in</button></div>`);
  } else if (st.state === 'needs-auth') {
    out.push(`<div class="banner warn">${icon('alert')}<div>${esc(st.message)}</div><button type="button" class="btn small" data-action="sign-in">Sign in</button></div>`);
  } else if (st.state === 'error') {
    out.push(`<div class="banner danger">${icon('alert')}<div>${esc(st.message)}</div><button type="button" class="btn small ghost" data-action="sync">Retry</button></div>`);
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (ios && !standalone && !getState('installHintDismissed')) {
    out.push(`<div class="banner tip">${icon('download')}<div><strong>Add to Home Screen</strong> for a full-screen app that keeps your captures safe: tap Share, then "Add to Home Screen".</div><button type="button" class="icon-btn" data-action="dismiss-install" aria-label="Dismiss">${icon('x')}</button></div>`);
  }
  return out.join('');
}

async function renderHome() {
  ui.view = 'home';
  const s = getSettings();
  const records = (await db.listRecords()).filter((r) => !r.deleted);
  const drafts = records.filter((r) => r.isDraft).length;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>InfoCapture</span></div>
      <div class="topbar-actions">
        <span id="sync-pill">${syncPill()}</span>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${icon('sliders')}</a>
      </div>
    </header>
    <main class="page home">
      <button type="button" class="event-chip" data-action="edit-event">${icon('pin')}<span>${s.event ? esc(s.event) : 'Set the event you are at'}</span>${icon('pencil', 'small')}</button>
      <div id="banners">${banners()}</div>
      <section class="capture" aria-label="Capture a contact">
        <button type="button" class="capture-main" data-action="card">${icon('card', 'big')}<span><strong>Snap card</strong><small>Business card or badge photo</small></span></button>
        <div class="capture-row">
          <button type="button" class="capture-btn" data-action="scan">${icon('qr', 'big')}<strong>Scan QR</strong><small>Badge QR code</small></button>
          <button type="button" class="capture-btn" data-action="manual">${icon('pencil', 'big')}<strong>Type it in</strong><small>No card? No problem</small></button>
        </div>
        <button type="button" class="link-btn" data-action="card-library">${icon('image', 'small')} Use a photo you already took</button>
      </section>
      <section class="list-section" aria-label="Captured contacts">
        <div class="list-head">
          <h2>Captured <span class="count">${records.length}</span>${drafts ? `<span class="draft-count">${drafts} unsaved</span>` : ''}</h2>
          ${records.length > 4 ? `<label class="search">${icon('search', 'small')}<input type="search" id="search" placeholder="Search" value="${esc(ui.search)}" aria-label="Search contacts"></label>` : ''}
        </div>
        <div id="list">${listHtml(records)}</div>
      </section>
    </main>`;
  app.querySelector('#search')?.addEventListener('input', async (e) => {
    ui.search = e.target.value;
    const all = (await db.listRecords()).filter((r) => !r.deleted);
    app.querySelector('#list').innerHTML = listHtml(all);
  });
}

function listHtml(records) {
  const q = ui.search.trim().toLowerCase();
  const shown = q
    ? records.filter((r) => [displayName(r), r.company, r.title, r.email, r.notes, r.event, (r.tags || []).join(' ')].join(' ').toLowerCase().includes(q))
    : records;
  if (!records.length) {
    return `<div class="empty">${icon('card', 'big')}<p>No contacts yet. Scan a badge or snap a card to get started.</p></div>`;
  }
  if (!shown.length) return `<div class="empty"><p>No matches for "${esc(ui.search)}".</p></div>`;
  let lastDay = '';
  return shown
    .map((r) => {
      const day = dayLabel(r.createdAt);
      const header = day !== lastDay ? `<h3 class="day">${esc(day)}</h3>` : '';
      lastDay = day;
      const name = displayName(r) || {
        reading: 'Reading card...',
        pending: 'Card photo (read when online)',
        failed: 'Card photo (add the name)',
      }[r.parseStatus] || 'No name yet';
      const sub = [r.title, r.company].filter(Boolean).join(' · ');
      let status;
      if (r.isDraft) status = `<span class="status draft">Unsaved</span>`;
      else if (r.syncStatus === 'synced') status = `<span class="status ok" title="In the team list">${icon('check', 'small')}</span>`;
      else if (r.syncError) status = `<span class="status danger" title="${esc(r.syncError)}">${icon('alert', 'small')}</span>`;
      else status = `<span class="status warn" title="Waiting to sync">${icon('cloud-up', 'small')}</span>`;
      const tags = (r.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      return `${header}<button type="button" class="item" data-action="open" data-id="${esc(r.id)}">
        <span class="avatar src-${esc(r.source)}">${icon(r.source === 'qr' ? 'qr' : r.source === 'card' ? 'card' : 'pencil', 'small')}</span>
        <span class="item-main"><span class="item-name">${esc(name)}</span>${sub ? `<span class="item-sub">${esc(sub)}</span>` : ''}${tags || r.notes ? `<span class="item-meta">${tags}${r.notes ? `<span class="note-snip">${esc(r.notes.slice(0, 60))}</span>` : ''}</span>` : ''}</span>
        <span class="item-side"><span class="time">${esc(timeLabel(r.createdAt))}</span>${status}</span>
      </button>`;
    })
    .join('');
}

function refreshHomeChrome() {
  if (ui.view !== 'home') return;
  const pill = app.querySelector('#sync-pill');
  if (pill) pill.innerHTML = syncPill();
  const b = app.querySelector('#banners');
  if (b) b.innerHTML = banners();
}

// ---------- scanning ----------

async function renderScan() {
  ui.view = 'scan';
  app.innerHTML = `
    <section class="scan" aria-label="QR scanner">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <header class="scan-top">
        <button type="button" class="icon-btn on-dark" data-action="close-scan" aria-label="Close scanner">${icon('x')}</button>
        <button type="button" class="icon-btn on-dark" data-action="torch" aria-label="Flashlight" hidden>${icon('flash')}</button>
      </header>
      <p class="scan-hint" id="scan-hint">Point at the QR code on the badge</p>
      <footer class="scan-bottom">
        <button type="button" class="btn ghost on-dark" data-action="qr-photo">${icon('image', 'small')} Scan from a photo</button>
        <button type="button" class="btn ghost on-dark" data-action="manual">${icon('pencil', 'small')} Type it in</button>
      </footer>
    </section>`;
  const video = app.querySelector('#scan-video');
  const scanner = new QrScanner(video, (text) => handleQrText(text));
  scanner.onEnded = () => offerCameraTap(scanner);
  ui.scanner = scanner;
  try {
    const playing = await scanner.start();
    if (ui.scanner !== scanner) return scanner.stop(); // left the view while starting
    if (scanner.torchSupported()) app.querySelector('[data-action="torch"]').hidden = false;
    // Some iPhones show the camera only after a tap; offer one if no
    // picture arrives.
    if (!playing || !(await scanner.waitForPicture(3000))) offerCameraTap(scanner);
  } catch (err) {
    if (ui.scanner !== scanner) return;
    ui.scanner = null;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    app.querySelector('#scan-hint').innerHTML = denied
      ? 'Camera access is blocked. Allow the camera for this site in your browser settings, or scan from a photo.'
      : esc(err?.message || 'Could not start the camera.');
    app.querySelector('.scan').classList.add('failed');
  }
}

function offerCameraTap(scanner) {
  // No stream: the scanner already read a code and closed the camera.
  if (ui.scanner !== scanner || !scanner.stream || app.querySelector('.camera-tap')) return;
  app.querySelector('.scan')?.insertAdjacentHTML('beforeend', `<button type="button" class="btn primary camera-tap" data-action="camera-tap">Tap to start the camera</button>`);
}

async function handleQrText(text) {
  navigator.vibrate?.(40);
  const setup = decodeSetup(text);
  if (setup) return applySetup(setup);

  const parsed = parseQr(text);
  const rec = newRecord('qr', parsed.fields);
  rec.qrRaw = text;
  rec.qrKind = parsed.kind;
  rec.qrUrl = parsed.url;
  const s = getSettings();
  const ask = worthAskingCardReader(parsed, text) && s.cardReaderUrl && isOnline() && auth.getAccount();
  if (ask) rec.parseStatus = 'reading';
  await db.putRecord(rec);
  go(`#/c/${rec.id}`, { replace: true });
  if (ask) readQrInBackground(rec.id, text);
}

async function readQrInBackground(id, text) {
  const s = getSettings();
  try {
    const reading = await readQrText(s.cardReaderUrl, await auth.getAccessToken(), text);
    await applyReaderFields(id, reading);
  } catch (err) {
    await db.updateRecord(id, (r) => {
      r.parseStatus = 'none';
    });
    refreshFormStatus(id);
  }
}

// ---------- card photos ----------

function pickCardPhoto(fromLibrary = false) {
  const input = document.getElementById(fromLibrary ? 'photo-input' : 'card-input');
  input.value = '';
  input.click();
}

async function handleCardFile(file) {
  if (!file) return;
  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch {
    toast('Could not open that photo. If it came from the photo library, take it again with Snap card.');
    return;
  }
  const s = getSettings();
  const rec = newRecord('card');
  rec.hasImage = true;
  const canRead = s.cardReaderUrl && auth.getAccount();
  rec.parseStatus = !s.cardReaderUrl ? 'none' : canRead && isOnline() ? 'reading' : 'pending';
  await db.putImage(rec.id, prepared.blob);
  await db.putRecord(rec);
  go(`#/c/${rec.id}`);
  if (rec.parseStatus === 'reading') readCardInBackground(rec.id);
}

async function readCardInBackground(id) {
  const s = getSettings();
  try {
    const blob = await db.getImage(id);
    const reading = await readCardPhoto(s.cardReaderUrl, await auth.getAccessToken(), blob);
    await applyReaderFields(id, reading);
  } catch (err) {
    const retryLater = err instanceof auth.AuthRequiredError || err instanceof auth.NetworkError || err.retryable;
    await db.updateRecord(id, (r) => {
      r.parseStatus = retryLater ? 'pending' : 'failed';
      r.parseError = retryLater ? '' : err.message;
    });
    refreshFormStatus(id);
  }
}

async function applyReaderFields(id, reading) {
  let changed = [];
  const rec = await db.updateRecord(id, (r) => {
    // Use what is in the open form, so text typed while reading is kept.
    if (ui.form?.rec.id === id) Object.assign(r, pickContact(ui.form.rec));
    changed = applyReading(r, reading);
    // A badge code with nothing readable just leaves the QR data on show.
    if (r.parseStatus === 'unreadable' && r.source === 'qr') r.parseStatus = 'none';
    if (changed.length) touch(r);
  });
  if (!rec) return;
  if (ui.form?.rec.id === id) {
    Object.assign(ui.form.rec, pickContact(rec), { parseStatus: rec.parseStatus, parsedKeys: rec.parsedKeys, unsureKeys: rec.unsureKeys, updatedAt: rec.updatedAt, syncStatus: rec.syncStatus });
    for (const key of changed) {
      const input = app.querySelector(`[name="${key}"]`);
      if (input) {
        input.value = rec[key];
        input.closest('.field')?.classList.add('filled');
        input.closest('.field')?.classList.toggle('unsure', (rec.unsureKeys ?? []).includes(key));
      }
    }
    if (changed.some((k) => CONTACT_FIELDS.find((f) => f.key === k)?.more)) app.querySelector('details.more')?.setAttribute('open', '');
    refreshFormStatus(id);
    checkDuplicate();
  }
  if (!rec.isDraft) syncer.changed();
}

function pickContact(r) {
  return Object.fromEntries(CONTACT_FIELDS.map((f) => [f.key, r[f.key] ?? '']));
}

// ---------- contact form ----------

async function renderForm(id) {
  const rec = await db.getRecord(id);
  if (!rec || rec.deleted) {
    toast('That contact is no longer on this phone.');
    return go('#/', { replace: true });
  }
  ui.view = 'form';
  ui.form = { rec, saveTimer: null, dirty: false };
  const s = getSettings();
  const tags = [...new Set([...(s.tags?.length ? s.tags : DEFAULT_TAGS), ...(rec.tags || [])])];
  let imageHtml = '';
  if (rec.hasImage) {
    const blob = await db.getImage(id);
    if (blob) imageHtml = `<button type="button" class="card-photo" data-action="zoom-photo"><img src="${trackUrl(URL.createObjectURL(blob))}" alt="Card photo"></button>`;
  }
  const field = (f) => `
    <label class="field${(rec.parsedKeys || []).includes(f.key) ? ' filled' : ''}${(rec.unsureKeys || []).includes(f.key) ? ' unsure' : ''}">
      <span>${esc(f.label)}<em class="check-tag">check</em></span>
      <input name="${f.key}" type="${f.type || 'text'}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} autocomplete="off" autocapitalize="${f.type ? 'off' : 'words'}" value="${esc(rec[f.key])}">
    </label>`;
  const main = CONTACT_FIELDS.filter((f) => !f.more);
  const more = CONTACT_FIELDS.filter((f) => f.more);
  const moreHasValues = more.some((f) => rec[f.key]);

  app.innerHTML = `
    <header class="topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${icon('back')}</button>
      <h1>${rec.isDraft ? 'New contact' : 'Contact'}</h1>
      <span class="source-chip">${esc(SOURCE_LABELS[rec.source] || '')}</span>
    </header>
    <main class="page form" id="form">
      <div id="dup"></div>
      ${imageHtml}
      <div id="parse-status"></div>
      ${rec.qrRaw ? qrInfoHtml(rec) : ''}
      <div class="grid2">${field(main[0])}${field(main[1])}</div>
      ${main.slice(2).map(field).join('')}
      <details class="more"${moreHasValues ? ' open' : ''}><summary>More details</summary>${more.map(field).join('')}</details>
      <fieldset class="tags"><legend>Tags</legend>
        ${tags.map((t) => `<button type="button" class="chip${(rec.tags || []).includes(t) ? ' on' : ''}" data-action="tag" data-tag="${esc(t)}" aria-pressed="${(rec.tags || []).includes(t)}">${esc(t)}</button>`).join('')}
      </fieldset>
      <label class="field notes"><span>Notes</span><textarea name="notes" rows="4" placeholder="What did you talk about? Next steps?">${esc(rec.notes)}</textarea></label>
      <p class="meta-line">${icon('pin', 'small')} ${esc(rec.event || 'No event')} · ${esc(new Date(rec.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}${rec.capturedBy ? ` · ${esc(rec.capturedBy)}` : ''}</p>
      ${!rec.isDraft ? `<p class="meta-line">${syncLine(rec)}</p>` : ''}
    </main>
    <footer class="actionbar">
      ${rec.isDraft
        ? `<button type="button" class="btn ghost" data-action="discard">Discard</button><button type="button" class="btn primary grow" data-action="save">${icon('check', 'small')} Save contact</button>`
        : `<button type="button" class="icon-btn danger" data-action="delete" aria-label="Delete contact">${icon('trash')}</button><button type="button" class="btn ghost" data-action="vcard">${icon('user-plus', 'small')} Add to phone</button><button type="button" class="btn primary grow" data-action="done">Done</button>`}
    </footer>`;

  refreshFormStatus(id);
  checkDuplicate();
  const form = app.querySelector('#form');
  form.addEventListener('input', (e) => {
    const { name, value } = e.target;
    if (!name || !ui.form) return;
    ui.form.rec[name] = value;
    e.target.closest('.field')?.classList.remove('filled', 'unsure');
    queueFormSave();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'email') checkDuplicate();
  });
}

function qrInfoHtml(rec) {
  const link = rec.qrUrl ? `<a class="btn small ghost" href="${esc(rec.qrUrl)}" target="_blank" rel="noopener">${icon('link', 'small')} Open link</a>` : '';
  const hint = rec.qrKind === 'url' || (rec.qrKind === 'text' && !displayName(rec))
    ? `<p class="hint">This badge code has no contact details in it. Snap a photo of the badge instead, or type the name in.</p>`
    : '';
  return `<details class="qr-raw"><summary>QR data</summary><pre>${esc(rec.qrRaw)}</pre>${link}</details>${hint}`;
}

function syncLine(rec) {
  if (rec.syncStatus === 'synced') return `${icon('check', 'small')} In the team list`;
  if (rec.syncError) return `${icon('alert', 'small')} Not sent yet: ${esc(rec.syncError)}`;
  return `${icon('cloud-up', 'small')} Waiting to sync`;
}

async function refreshFormStatus(id) {
  if (ui.form?.rec.id !== id) return;
  const rec = await db.getRecord(id);
  const el = app.querySelector('#parse-status');
  if (!rec || !el) return;
  const s = getSettings();
  let html = '';
  if (rec.parseStatus === 'reading') {
    html = `<div class="reading">${icon('refresh', 'spin small')} Reading ${rec.source === 'qr' ? 'badge code' : 'card'}... keep typing notes meanwhile.</div>`;
  } else if (rec.parseStatus === 'done' && rec.source === 'card') {
    const unsure = (rec.unsureKeys ?? []).length || (rec.readConfidence ?? 1) < 0.6;
    html = !rec.parsedKeys?.length
      ? `<div class="reading">${icon('alert', 'small')} Nothing new found on the card. Fill in what you need.</div>`
      : unsure
        ? `<div class="reading warn">${icon('alert', 'small')} Filled from the card, but the reader wasn't sure of everything. Check the fields marked "check" against the photo.</div>`
        : `<div class="reading ok">${icon('check', 'small')} Filled from the card. Check the highlighted fields.</div>`;
  } else if (rec.parseStatus === 'unreadable') {
    html = `<div class="reading">${icon('image', 'small')} Couldn't read this card. Fill in what you need from the photo.</div>`;
  } else if (rec.parseStatus === 'pending') {
    html = `<div class="reading">${icon('cloud-off', 'small')} The card will be read when you are online and signed in.</div>`;
  } else if (rec.parseStatus === 'failed') {
    html = `<div class="reading warn">${icon('alert', 'small')} Could not read the card: ${esc(rec.parseError || 'unknown error')} <button type="button" class="link-btn" data-action="reread">Try again</button></div>`;
  } else if (rec.source === 'card' && !s.cardReaderUrl) {
    html = `<div class="reading">${icon('image', 'small')} Photo saved with the contact. (Automatic card reading is not set up.)</div>`;
  }
  for (const [i, extra] of (rec.extraContacts ?? []).entries()) {
    const who = displayName(extra.fields) || 'another person';
    html += `<div class="banner info">${icon('user-plus')}<div>This card also lists <strong>${esc(who)}</strong>.</div><button type="button" class="btn small" data-action="add-extra" data-index="${i}">Add as a contact</button></div>`;
  }
  el.innerHTML = html;
}

async function checkDuplicate() {
  if (!ui.form) return;
  const all = await db.listRecords();
  const dup = findDuplicate(ui.form.rec, all);
  const el = app.querySelector('#dup');
  if (!el) return;
  el.innerHTML = dup
    ? `<div class="banner warn">${icon('alert')}<div>Already captured ${esc(displayName(dup) || 'this person')} ${esc(dayLabel(dup.createdAt).toLowerCase())} at ${esc(timeLabel(dup.createdAt))}.</div><button type="button" class="btn small ghost" data-action="open" data-id="${esc(dup.id)}">Open</button></div>`
    : '';
}

function queueFormSave() {
  ui.form.dirty = true;
  clearTimeout(ui.form.saveTimer);
  ui.form.saveTimer = setTimeout(() => saveForm(), 400);
}

// Writes the form to IndexedDB (drafts stay drafts).
async function saveForm() {
  const f = ui.form;
  if (!f || !f.dirty) return;
  clearTimeout(f.saveTimer);
  f.dirty = false;
  const edits = { ...pickContact(f.rec), notes: f.rec.notes, tags: f.rec.tags };
  const saved = await db.updateRecord(f.rec.id, (r) => {
    Object.assign(r, edits);
    touch(r);
  });
  if (saved && ui.form === f) Object.assign(f.rec, { updatedAt: saved.updatedAt, syncStatus: saved.syncStatus });
  f.changedSinceOpen = true;
}

async function closeForm() {
  const f = ui.form;
  await saveForm();
  ui.form = null;
  if (f?.changedSinceOpen && !f.rec.isDraft) await syncer.changed();
}

// Turns the open draft into a saved contact that will sync.
async function commitDraft(f) {
  await saveForm();
  await db.updateRecord(f.rec.id, (r) => {
    r.isDraft = false;
    r.syncStatus = 'pending';
    r.updatedAt = now();
  });
  f.rec.isDraft = false;
  if (!getState('persistAsked')) {
    setState('persistAsked', true);
    db.requestPersistence();
  }
  await syncer.changed(600);
}

async function finishDraft() {
  const f = ui.form;
  if (!f || f.finishing) return;
  f.finishing = true;
  await commitDraft(f);
  toast(`Saved ${displayName(f.rec) || 'contact'}`);
  go('#/');
}

// A card that lists two people: save this contact, then open the other
// person as a new contact with the same photo.
async function addExtraContact(index) {
  const f = ui.form;
  if (!f || f.finishing) return;
  f.finishing = true;
  await saveForm();
  const current = await db.getRecord(f.rec.id);
  const extra = current?.extraContacts?.[index];
  if (!extra) {
    f.finishing = false;
    return;
  }
  const rec = newRecord(current.source, extra.fields);
  rec.event = current.event;
  rec.capturedBy = current.capturedBy;
  rec.parsedKeys = Object.keys(extra.fields).filter((k) => extra.fields[k]);
  rec.unsureKeys = extra.unsure ?? [];
  rec.parseStatus = 'done';
  const blob = current.hasImage ? await db.getImage(current.id) : null;
  if (blob) {
    await db.putImage(rec.id, blob);
    rec.hasImage = true;
  }
  await db.putRecord(rec);
  await db.updateRecord(current.id, (r) => {
    r.extraContacts = (r.extraContacts ?? []).filter((_, i) => i !== index);
  });
  if (current.isDraft) await commitDraft(f);
  toast(`Saved ${displayName(current) || 'contact'}. Now check ${displayName(rec) || 'the second person'}.`);
  go(`#/c/${rec.id}`, { replace: true });
}

// ---------- settings ----------

function accountHtml(s, account) {
  if (!isConfigured(s)) return `<p class="muted">Add the Supabase project URL and publishable key under "Connection" below (or in config.js) to turn on sync.</p>`;
  if (account) {
    return `<p class="row"><span>Signed in as <strong>${esc(account.name)}</strong>${account.name !== account.username ? `<br><small>${esc(account.username)}</small>` : ''}</span><button type="button" class="btn small ghost" data-action="sign-out">Sign out</button></p><div id="team-note"></div>`;
  }
  return `<form id="sign-in-form" autocomplete="on">
      <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="row-buttons"><button type="submit" class="btn primary">Sign in</button></div>
      <div id="sign-in-result"></div>
      <p class="hint">Your InfoCapture admin creates your login. You stay signed in on this phone until you sign out.</p>
    </form>`;
}

async function renderSettings() {
  ui.view = 'settings';
  const s = getSettings();
  const account = auth.getAccount();
  const records = (await db.listRecords()).filter((r) => !r.deleted);
  const synced = records.filter((r) => r.syncStatus === 'synced' && !r.isDraft).length;
  const pending = records.filter(needsSync).length;
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  app.innerHTML = `
    <header class="topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${icon('back')}</button>
      <h1>Settings</h1><span></span>
    </header>
    <main class="page settings">
      <section class="card" id="account">
        <h2>Account</h2>
        ${accountHtml(s, account)}
      </section>

      <form id="settings-form" class="card" autocomplete="off">
        <h2>Capturing</h2>
        <label class="field"><span>Your name (shown in "Captured By")</span><input name="capturedBy" value="${esc(s.capturedBy)}" placeholder="${esc(account?.name || 'Your name')}"></label>
        <label class="field"><span>Current event</span><input name="event" value="${esc(s.event)}" placeholder="e.g. HR Tech Expo 2026"></label>
        <label class="field"><span>Quick tags (comma separated)</span><input name="tags" value="${esc((s.tags || []).join(', '))}"></label>

        <details class="more"${isConfigured(s) ? '' : ' open'}>
          <summary>Connection</summary>
          <label class="field"><span>Supabase project URL</span><input name="supabaseUrl" value="${esc(s.supabaseUrl)}" type="url" autocapitalize="off" spellcheck="false" placeholder="https://....supabase.co"></label>
          <label class="field"><span>Publishable key</span><input name="supabaseKey" value="${esc(s.supabaseKey)}" autocapitalize="off" spellcheck="false" placeholder="sb_publishable_..."></label>
          <label class="field"><span>Card reader URL</span><input name="cardReaderUrl" value="${esc(s.cardReaderUrl)}" type="url" autocapitalize="off" spellcheck="false" placeholder="https://....lambda-url.us-east-2.on.aws/"></label>
        </details>
        <div class="row-buttons">
          <button type="submit" class="btn primary">Save settings</button>
          <button type="button" class="btn ghost" data-action="test">Test connection</button>
        </div>
        <div id="test-result"></div>
      </form>

      <section class="card">
        <h2>Team spreadsheet</h2>
        <p class="hint">Everyone's contacts in one Excel file. The card photo links in it work for ${PHOTO_LINK_DAYS} days; download again for fresh ones.</p>
        <button type="button" class="btn ghost" data-action="download-team" ${account ? '' : 'disabled'}>${icon('download', 'small')} Download spreadsheet</button>
      </section>

      <section class="card">
        <h2>Team setup</h2>
        <p class="hint">Send teammates a link that fills in the connection settings on their phone. It holds the addresses and the publishable key only, never a password; each person signs in with their own login.</p>
        <button type="button" class="btn ghost" data-action="copy-setup" ${isConfigured(s) ? '' : 'disabled'}>${icon('copy', 'small')} Copy setup link</button>
      </section>

      <section class="card">
        <h2>On this phone</h2>
        <p>${records.length} contacts: ${synced} in the team list, ${pending} waiting to sync.${persisted ? '' : ' <small class="muted">(Storage may be cleared by the browser if space runs low. Sync regularly.)</small>'}</p>
        <div class="row-buttons">
          <button type="button" class="btn ghost" data-action="export-csv" ${records.length ? '' : 'disabled'}>${icon('download', 'small')} Export CSV</button>
          <button type="button" class="btn ghost" data-action="export-vcf" ${records.length ? '' : 'disabled'}>${icon('user-plus', 'small')} Export contacts</button>
        </div>
        <button type="button" class="btn ghost danger-text" data-action="clear-synced" ${synced ? '' : 'disabled'}>Remove synced contacts from this phone</button>
        <p class="hint">Removes the copies on this phone only. The team list is not touched.</p>
      </section>
      <div class="signoff"><span>InfoCapture by</span><picture><source srcset="icons/tlc-trng-horizontal-gray-white.png" media="(prefers-color-scheme: dark)"><img src="icons/tlc-trng-horizontal-navy.png" alt="TLC_TRNG" width="131" height="20"></picture></div>
      <p class="version"><span id="sw-version"></span></p>
    </main>`;

  app.querySelector('#sign-in-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const out = form.querySelector('#sign-in-result');
    const button = form.querySelector('[type=submit]');
    const { email, password } = Object.fromEntries(new FormData(form));
    button.disabled = true;
    out.innerHTML = `<p class="muted">${icon('refresh', 'spin small')} Signing in...</p>`;
    try {
      await auth.signIn(email, password);
    } catch (err) {
      button.disabled = false;
      out.innerHTML = `<p class="bad-text">${icon('alert', 'small')} ${esc(err.message)}</p>`;
      return;
    }
    toast('Signed in');
    await renderSettings();
    syncer.run();
  });
  if (ui.focusSignIn) {
    ui.focusSignIn = false;
    app.querySelector('#sign-in-form [name=email]')?.focus();
  }
  if (account) showTeamNote();

  app.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const before = getSettings();
    const next = saveSettings({
      capturedBy: data.capturedBy.trim(),
      event: data.event.trim(),
      tags: data.tags.split(',').map((t) => t.trim()).filter(Boolean),
      supabaseUrl: data.supabaseUrl.trim(),
      supabaseKey: data.supabaseKey.trim(),
      cardReaderUrl: data.cardReaderUrl.trim(),
    });
    if (next.supabaseUrl !== before.supabaseUrl || next.supabaseKey !== before.supabaseKey) {
      toast('Saved. Reloading to apply the new connection...');
      setTimeout(() => location.reload(), 800);
      return;
    }
    toast('Settings saved');
    syncer.schedule();
  });
  navigator.serviceWorker?.controller?.postMessage('version');
}

// A login that exists but was never added to the team can sign in, yet
// nothing syncs; say so on the account card.
async function showTeamNote() {
  if (!isOnline()) return;
  let member = true;
  try {
    member = await auth.isTeamMember();
  } catch {
    return;
  }
  const el = app.querySelector('#team-note');
  if (el && !member) el.innerHTML = `<div class="banner warn">${icon('alert')}<div>${esc(NOT_ON_TEAM)}</div></div>`;
}

async function testConnection() {
  const out = app.querySelector('#test-result');
  const s = getSettings();
  const lines = [];
  const show = () => { out.innerHTML = `<ul class="checks">${lines.join('')}</ul>`; };
  const ok = (t) => lines.push(`<li class="ok">${icon('check', 'small')} ${t}</li>`);
  const bad = (t) => lines.push(`<li class="bad">${icon('alert', 'small')} ${t}</li>`);
  out.innerHTML = `<p class="muted">${icon('refresh', 'spin small')} Checking...</p>`;
  if (!isConfigured(s)) {
    bad('The Supabase project URL and publishable key are needed. Save them first.');
    return show();
  }
  if (!auth.getAccount()) {
    bad('Not signed in. Sign in under Account above.');
    return show();
  }
  ok(`Signed in as ${esc(auth.getAccount().username)}`);
  try {
    const r = await syncer.getStore().check();
    if (r.member) ok(`On the team. The team list has ${r.rows} contact${r.rows === 1 ? '' : 's'}.`);
    else bad(esc(NOT_ON_TEAM));
  } catch (err) {
    bad(`Team list: ${esc(err.message)}`);
  }
  if (s.cardReaderUrl) {
    try {
      const r = await pingCardReader(s.cardReaderUrl, await auth.getAccessToken());
      ok(`Card reader is working (${esc(r.model || 'Claude')})`);
    } catch (err) {
      bad(`Card reader: ${esc(err.message)}`);
    }
  } else {
    lines.push(`<li class="muted">Card reader not set up (card photos are saved without reading).</li>`);
  }
  show();
}

// Returns true when the settings were applied (the page then reloads).
async function applySetup(setup) {
  let host = setup.supabaseUrl || '';
  try {
    host = new URL(setup.supabaseUrl).host;
  } catch {
    // keep what was given
  }
  const summary = [host && `Team list: ${host}`, setup.cardReaderUrl && 'Card reader: on'].filter(Boolean).join('\n');
  if (!confirm(`Use these InfoCapture connection settings on this phone?\n\n${summary || 'InfoCapture connection'}`)) {
    if (ui.view === 'scan') go('#/', { replace: true });
    return false;
  }
  saveSettings(setup);
  history.replaceState(null, '', `${location.pathname}${location.search}#/settings`);
  location.reload();
  return true;
}

// ---------- actions ----------

const actions = {
  scan: () => go('#/scan'),
  card: () => pickCardPhoto(false),
  'card-library': () => pickCardPhoto(true),
  async manual() {
    const rec = newRecord('manual');
    await db.putRecord(rec);
    go(`#/c/${rec.id}`, { replace: ui.view === 'scan' });
  },
  'close-scan': () => goBack(),
  async 'camera-tap'(btn) {
    const scanner = ui.scanner;
    btn.remove();
    if (!scanner) return;
    // play() inside the tap is what iPhones wait for; if the picture still
    // doesn't come, open the camera again.
    if ((await scanner.resume()) && (await scanner.waitForPicture(2000))) return;
    try {
      await scanner.restart();
      if (ui.scanner === scanner && (await scanner.waitForPicture(3000))) return;
    } catch {
      // reported below
    }
    if (ui.scanner === scanner) app.querySelector('#scan-hint').textContent = 'The camera is not showing a picture. Close the scanner and open it again, or use "Scan from a photo".';
  },
  async torch(btn) {
    const on = !btn.classList.contains('on');
    try {
      await ui.scanner?.setTorch(on);
      btn.classList.toggle('on', on);
    } catch {
      btn.hidden = true;
    }
  },
  'qr-photo': () => {
    const input = document.getElementById('qr-photo-input');
    input.value = '';
    input.click();
  },
  open: (btn) => go(`#/c/${encodeURIComponent(btn.dataset.id)}`),
  back: () => goBack(),
  tag(btn) {
    const f = ui.form;
    const t = btn.dataset.tag;
    const set = new Set(f.rec.tags || []);
    if (set.has(t)) set.delete(t);
    else set.add(t);
    f.rec.tags = [...set];
    btn.classList.toggle('on', set.has(t));
    btn.setAttribute('aria-pressed', set.has(t));
    queueFormSave();
  },
  save: () => finishDraft(),
  async done() {
    go('#/');
  },
  async discard() {
    const r = ui.form.rec;
    const hasContent = displayName(r) || r.notes;
    if (hasContent && !confirm('Discard this contact?')) return;
    const id = r.id;
    ui.form = null;
    await db.deleteRecord(id);
    go('#/', { replace: true });
  },
  async delete() {
    const r = ui.form.rec;
    if (!confirm(`Delete ${displayName(r) || 'this contact'}?${r.syncedAt ? ' It is also removed from the team list.' : ''}`)) return;
    const id = r.id;
    ui.form = null;
    if (r.syncedAt || r.syncAttempted) {
      await db.updateRecord(id, (x) => {
        x.deleted = true;
        x.syncStatus = 'pending';
      });
      await syncer.changed();
    } else {
      await db.deleteRecord(id);
    }
    go('#/', { replace: true });
  },
  async vcard() {
    await saveForm();
    const r = ui.form.rec;
    const name = (displayName(r) || 'contact').replace(/[^\w\s-]/g, '').trim() || 'contact';
    await shareOrDownload(`${name}.vcf`, toVCard([r]), 'text/vcard');
  },
  async reread() {
    const id = ui.form.rec.id;
    await db.updateRecord(id, (r) => {
      r.parseStatus = 'reading';
    });
    refreshFormStatus(id);
    readCardInBackground(id);
  },
  'add-extra': (btn) => addExtraContact(Number(btn.dataset.index)),
  'zoom-photo': (btn) => btn.classList.toggle('zoomed'),
  async 'edit-event'() {
    const s = getSettings();
    const value = prompt('Which event are you at? It is saved with each contact.', s.event);
    if (value === null) return;
    saveSettings({ event: value.trim() });
    renderHome();
  },
  sync() {
    const st = syncer.status.state;
    if (st === 'signed-out' || st === 'needs-auth') return actions['sign-in']();
    if (st === 'not-configured') return go('#/settings');
    if (st === 'offline' && !isOnline()) return toast('You are offline. Contacts will sync when you reconnect.');
    toast('Syncing...', { timeout: 1500 });
    syncer.run();
  },
  'sign-in'() {
    ui.focusSignIn = true;
    if (ui.view === 'settings') renderSettings();
    else go('#/settings');
  },
  async 'sign-out'() {
    if (!confirm('Sign out on this phone? Unsynced contacts stay here and sync after you sign in again.')) return;
    await auth.signOut();
    syncer.store = null;
    renderSettings();
  },
  async 'download-team'(btn) {
    if (!isOnline()) return toast('The team spreadsheet needs a connection.');
    btn.disabled = true;
    toast('Building the spreadsheet...', { timeout: 0 });
    try {
      const store = syncer.getStore();
      const records = (await store.listAll()).map(fromRow);
      const paths = records.map((r) => r.cardPhotoPath).filter(Boolean);
      const links = paths.length ? await store.signedUrls(paths, PHOTO_LINK_DAYS * 86400) : new Map();
      const stamp = new Date().toISOString().slice(0, 10);
      const result = await shareOrDownload(`InfoCapture leads ${stamp}.xlsx`, teamWorkbook(records, links), XLSX_TYPE);
      toast(result === 'cancelled' ? 'Cancelled' : `Spreadsheet ready: ${records.length} contact${records.length === 1 ? '' : 's'}`);
    } finally {
      btn.disabled = false;
    }
  },
  test: () => testConnection(),
  async 'copy-setup'() {
    const link = `${location.origin}${location.pathname}#setup=${encodeSetup(getSettings())}`;
    try {
      if (navigator.share && /android|iphone|ipad/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'InfoCapture setup', text: 'Open this to set up InfoCapture:', url: link });
      } else {
        await navigator.clipboard.writeText(link);
        toast('Setup link copied');
      }
    } catch (err) {
      if (err.name !== 'AbortError') prompt('Copy this setup link:', link);
    }
  },
  async 'export-csv'() {
    const recs = (await db.listRecords()).filter((r) => !r.deleted).reverse();
    const stamp = new Date().toISOString().slice(0, 10);
    await shareOrDownload(`infocapture-${stamp}.csv`, toCsv(recs), 'text/csv');
  },
  async 'export-vcf'() {
    const recs = (await db.listRecords()).filter((r) => !r.deleted).reverse();
    await shareOrDownload('infocapture-contacts.vcf', toVCard(recs), 'text/vcard');
  },
  async 'clear-synced'() {
    const recs = (await db.listRecords()).filter((r) => r.syncStatus === 'synced' && !r.isDraft && !r.deleted);
    if (!confirm(`Remove ${recs.length} synced contacts from this phone? They stay in the team list.`)) return;
    for (const r of recs) await db.deleteRecord(r.id);
    await syncer.changed();
    toast(`Removed ${recs.length} from this phone`);
    renderSettings();
  },
  'dismiss-install'() {
    setState('installHintDismissed', true);
    refreshHomeChrome();
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const fn = actions[btn.dataset.action];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(btn)).catch((err) => {
    console.error(err);
    toast(err.message || 'Something went wrong');
  });
});

document.getElementById('card-input').addEventListener('change', (e) => handleCardFile(e.target.files[0]));
document.getElementById('photo-input').addEventListener('change', (e) => handleCardFile(e.target.files[0]));
document.getElementById('qr-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  toast('Looking for the QR code...', { timeout: 0 });
  try {
    const text = await decodeQrFromFile(file);
    document.getElementById('toast').classList.remove('show');
    if (text) handleQrText(text);
    else toast('No QR code found in that photo. Try again closer up.');
  } catch {
    toast('Could not read that photo.');
  }
});

// ---------- startup ----------

syncer.addEventListener('status', async () => {
  if (ui.view === 'home') {
    refreshHomeChrome();
    const list = app.querySelector('#list');
    if (list && syncer.status.state !== 'syncing') list.innerHTML = listHtml((await db.listRecords()).filter((r) => !r.deleted));
  }
});

window.addEventListener('hashchange', route);
window.addEventListener('online', () => syncer.schedule(1000));
window.addEventListener('offline', () => syncer.run());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncer.schedule(1500);
  else if (ui.form) saveForm();
});
window.addEventListener('pagehide', () => {
  if (ui.form) saveForm();
});
// Retry now and then while something is waiting.
setInterval(() => {
  if (isOnline() && syncer.status.pending && !['signed-out', 'needs-auth', 'not-configured'].includes(syncer.status.state)) syncer.run();
}, 60000);

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || (location.protocol === 'http:' && location.hostname !== 'localhost')) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready.', { action: 'Update', timeout: 0, onAction: () => next.postMessage('skipWaiting') });
        }
      });
    });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) {
      reloading = true;
      location.reload();
    }
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.version) {
      const el = document.getElementById('sw-version');
      if (el) el.textContent = `build ${e.data.version}`;
    }
  });
}

async function start() {
  const setup = decodeSetup(location.hash);
  if (setup) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (await applySetup(setup)) return;
  }
  try {
    await auth.initAuth(getSettings());
  } catch (err) {
    console.error(err);
    toast(`Sign-in is unavailable: ${err.message}`);
  }
  // A card read cut short (app closed mid-read) is retried by the next sync.
  for (const r of await db.listRecords()) {
    if (r.parseStatus === 'reading') await db.updateRecord(r.id, (x) => { x.parseStatus = x.source === 'card' ? 'pending' : 'none'; });
  }
  syncer.status.pending = await syncer.countPending();
  await route();
  syncer.run();
  registerServiceWorker();
}

start();

// Sends saved contacts from this device to Excel, oldest first. Safe to call
// as often as you like: runs never overlap, and every step can be retried
// without creating duplicate rows.

import * as db from './db.js';
import { getSettings, getState, setState, isM365Configured } from './settings.js';
import { getAccount, getGraphToken, getApiToken, AuthRequiredError, NetworkError } from './auth.js';
import { ExcelStore, GraphError } from './excel.js';
import { readCardPhoto } from './cardreader.js';
import { fillBlanks } from './fields.js';

// Thrown when a record is discarded on this device mid-sync.
class RecordGone extends Error {}

async function update(id, fn) {
  const r = await db.updateRecord(id, fn);
  if (!r) throw new RecordGone();
  return r;
}

export const needsSync = (r) => !r.isDraft && (r.deleted || r.syncStatus !== 'synced');

export class Syncer extends EventTarget {
  constructor() {
    super();
    this.status = { state: 'idle', pending: 0, message: '' };
    this.store = null;
    this.running = false;
  }

  setStatus(state, pending, message = '', extra = {}) {
    this.status = { state, pending, message, ...extra };
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  getStore() {
    const { workbook } = getSettings();
    if (!this.store || this.store.location !== workbook.trim()) {
      this.store = new ExcelStore({ getToken: getGraphToken, location: workbook, cached: getState('workbook') });
    }
    return this.store;
  }

  resetStore() {
    this.store = null;
    setState('workbook', null);
  }

  schedule(delay = 300) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  }

  // Call after anything is saved or deleted: the badge shows the new count
  // straight away, then a sync follows.
  async changed(delay = 300) {
    const pending = await this.countPending();
    if (!this.running) this.setStatus(this.status.state, pending, this.status.state === 'idle' ? '' : this.status.message, { scopes: this.status.scopes });
    this.schedule(delay);
  }

  async run() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again);
    } catch (err) {
      console.error(err);
      this.setStatus('error', this.status.pending, err.message || String(err));
    } finally {
      this.running = false;
    }
  }

  async countPending() {
    return (await db.listRecords()).filter(needsSync).length;
  }

  async runOnce(retriedWorkbook = false) {
    // Records whose card is being read right now wait for the reader, so the
    // row and photo go out once, with the name filled in.
    const queue = (await db.listRecords()).filter((r) => needsSync(r) && r.parseStatus !== 'reading').reverse();
    const s = getSettings();
    const total = queue.length;
    if (!total) return this.setStatus('idle', await this.countPending(), this.status.state === 'syncing' ? this.status.message : '');
    if (!isM365Configured(s)) return this.setStatus('not-configured', total, 'Add your Microsoft 365 details in Settings to start syncing.');
    if (!navigator.onLine) return this.setStatus('offline', total, 'Offline. Contacts are safe on this phone and sync when you reconnect.');
    if (!getAccount()) return this.setStatus('signed-out', total, 'Sign in with Microsoft 365 to send contacts to Excel.');

    this.setStatus('syncing', total, 'Sending to Excel...');
    const store = this.getStore();
    this.readerNeedsAuth = null;
    let sent = 0;
    const failures = [];
    for (const rec of queue) {
      try {
        await this.syncRecord(store, rec, s);
        sent += 1;
        this.setStatus('syncing', total - sent, 'Sending to Excel...');
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return this.setStatus('needs-auth', await this.countPending(), err.message, { scopes: err.scopes });
        }
        if (err instanceof NetworkError) {
          return this.setStatus('offline', await this.countPending(), 'Connection lost. Will retry when you are back online.');
        }
        // A cached workbook id can go stale if the file was moved or deleted.
        if (err instanceof GraphError && err.status === 404 && store.item && !retriedWorkbook && sent === 0) {
          this.resetStore();
          return this.runOnce(true);
        }
        console.warn('Sync failed for', rec.id, err);
        failures.push(err);
        await db.updateRecord(rec.id, (r) => {
          r.syncError = err.message || String(err);
        });
      }
    }
    if (store.item) setState('workbook', store.item);

    const left = await this.countPending();
    if (failures.length) {
      const n = failures.length;
      return this.setStatus('error', left, `${n} contact${n > 1 ? 's' : ''} could not be sent: ${failures[0].message}`);
    }
    if (this.readerNeedsAuth) {
      return this.setStatus('needs-auth', left, 'Sign in again so the card reader can read saved card photos.', { scopes: this.readerNeedsAuth });
    }
    return this.setStatus('idle', left, sent ? `Sent ${sent} to Excel` : '');
  }

  async syncRecord(store, rec, s) {
    if (rec.deleted) {
      if (rec.syncedAt || rec.syncAttempted) await store.remove(rec.id);
      await db.deleteRecord(rec.id);
      return;
    }
    let working = rec;

    // Card photos taken offline get read now. A failure here never blocks
    // the row from reaching Excel; the person can fill fields in by hand.
    if (working.parseStatus === 'pending' && s.cardReaderUrl && !this.readerNeedsAuth) {
      const blob = await db.getImage(rec.id);
      if (blob) {
        try {
          const fields = await readCardPhoto(s.cardReaderUrl, await getApiToken(s), blob);
          working = await update(rec.id, (r) => {
            r.parsedKeys = fillBlanks(r, fields);
            r.parseStatus = 'done';
            r.parseError = '';
          });
        } catch (err) {
          if (err instanceof NetworkError) throw err;
          if (err instanceof AuthRequiredError) {
            this.readerNeedsAuth = err.scopes;
          } else {
            working = await update(rec.id, (r) => {
              r.parseStatus = 'failed';
              r.parseError = err.message;
            });
          }
        }
      }
    }

    if (working.hasImage && !working.cardImageUrl) {
      const blob = await db.getImage(rec.id);
      if (blob) {
        const url = await store.uploadPhoto(working, blob);
        working = await update(rec.id, (r) => {
          r.cardImageUrl = url;
        });
      }
    }

    const knownNew = !working.syncedAt && !working.syncAttempted;
    if (knownNew) {
      working = await update(rec.id, (r) => {
        r.syncAttempted = true;
      });
    }
    const sentVersion = working.updatedAt;
    await store.upsert(working, { knownNew });
    await update(rec.id, (r) => {
      r.syncedAt = new Date().toISOString();
      r.syncError = '';
      // Edits made while this row was in flight keep the record pending.
      r.syncStatus = r.updatedAt === sentVersion && !r.deleted ? 'synced' : 'pending';
    });
  }
}

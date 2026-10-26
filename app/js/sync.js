// Sends saved contacts from this device to the team list, oldest first. Safe
// to call as often as you like: runs never overlap, and every step can be
// retried without creating duplicate rows.

import * as db from './db.js';
import { getSettings, isConfigured } from './settings.js';
import { getAccount, getClient, getAccessToken, AuthRequiredError, NetworkError } from './auth.js';
import { SupabaseStore, StoreError, NOT_ON_TEAM } from './store.js';
import { readCardPhoto } from './cardreader.js';
import { applyReading } from './fields.js';

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

  setStatus(state, pending, message = '') {
    this.status = { state, pending, message };
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  getStore() {
    const client = getClient();
    if (!this.store || this.store.client !== client) this.store = new SupabaseStore(client);
    return this.store;
  }

  schedule(delay = 300) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  }

  // Call after anything is saved or deleted: the badge shows the new count
  // straight away, then a sync follows.
  async changed(delay = 300) {
    const pending = await this.countPending();
    if (!this.running) this.setStatus(this.status.state, pending, this.status.state === 'idle' ? '' : this.status.message);
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

  async runOnce() {
    // Records whose card is being read right now wait for the reader, so the
    // row and photo go out once, with the name filled in.
    const queue = (await db.listRecords()).filter((r) => needsSync(r) && r.parseStatus !== 'reading').reverse();
    const s = getSettings();
    const total = queue.length;
    if (!total) return this.setStatus('idle', await this.countPending(), this.status.state === 'syncing' ? this.status.message : '');
    if (!isConfigured(s)) return this.setStatus('not-configured', total, 'Add the Supabase details in Settings to start syncing.');
    if (!navigator.onLine) return this.setStatus('offline', total, 'Offline. Contacts are safe on this phone and sync when you reconnect.');
    if (!getAccount()) return this.setStatus('signed-out', total, 'Sign in to send contacts to the team list.');

    this.setStatus('syncing', total, 'Syncing...');
    const store = this.getStore();
    let sent = 0;
    const failures = [];
    for (const rec of queue) {
      try {
        await this.syncRecord(store, rec, s);
        sent += 1;
        this.setStatus('syncing', total - sent, 'Syncing...');
      } catch (err) {
        if (err instanceof RecordGone) continue;
        if (err instanceof AuthRequiredError) return this.setStatus('needs-auth', await this.countPending(), err.message);
        if (err instanceof NetworkError) {
          return this.setStatus('offline', await this.countPending(), 'Connection lost. Will retry when you are back online.');
        }
        console.warn('Sync failed for', rec.id, err);
        await db.updateRecord(rec.id, (r) => {
          r.syncError = err.message || String(err);
        });
        // Every record would fail the same way; say so once.
        if (err instanceof StoreError && err.message === NOT_ON_TEAM) return this.setStatus('error', await this.countPending(), NOT_ON_TEAM);
        failures.push(err);
      }
    }

    const left = await this.countPending();
    if (failures.length) {
      const n = failures.length;
      return this.setStatus('error', left, `${n} contact${n > 1 ? 's' : ''} could not be sent: ${failures[0].message}`);
    }
    return this.setStatus('idle', left, sent ? `Sent ${sent} to the team list` : '');
  }

  async syncRecord(store, rec, s) {
    if (rec.deleted) {
      if (rec.syncedAt || rec.syncAttempted) await store.remove(rec);
      await db.deleteRecord(rec.id);
      return;
    }
    let working = rec;

    // Card photos taken offline get read now. A failure here never blocks
    // the contact from syncing; the person can fill fields in by hand.
    if (working.parseStatus === 'pending' && s.cardReaderUrl) {
      const blob = await db.getImage(rec.id);
      if (blob) {
        try {
          const reading = await readCardPhoto(s.cardReaderUrl, await getAccessToken(), blob);
          working = await update(rec.id, (r) => {
            applyReading(r, reading);
          });
        } catch (err) {
          if (err instanceof NetworkError || err instanceof AuthRequiredError || err instanceof RecordGone) throw err;
          working = await update(rec.id, (r) => {
            r.parseStatus = 'failed';
            r.parseError = err.message;
          });
        }
      }
    }

    if (working.hasImage && !working.cardPhotoPath) {
      const blob = await db.getImage(rec.id);
      if (blob) {
        const path = await store.uploadPhoto(working, blob);
        working = await update(rec.id, (r) => {
          r.cardPhotoPath = path;
        });
      }
    }

    if (!working.syncedAt && !working.syncAttempted) {
      working = await update(rec.id, (r) => {
        r.syncAttempted = true;
      });
    }
    const sentVersion = working.updatedAt;
    await store.upsert(working);
    await update(rec.id, (r) => {
      r.syncedAt = new Date().toISOString();
      r.syncError = '';
      // Edits made while this row was in flight keep the record pending.
      r.syncStatus = r.updatedAt === sentVersion && !r.deleted ? 'synced' : 'pending';
    });
  }
}

// The team list: contacts in the Supabase table "leads" and card photos in
// the private "card-photos" bucket (see supabase/setup.sql). Every write can
// be retried safely: rows are upserted by their ID and a photo always goes to
// the same file name.

import { AuthRequiredError, NetworkError } from './auth.js';
import { followUpFromRow, followUpToRow } from './followup.js';

export const TABLE = 'leads';
export const NOTES = 'lead_notes';
export const BUCKET = 'card-photos';
const PAGE = 1000;

// Contact record key -> database column.
export const DB_COLUMNS = {
  id: 'id',
  createdAt: 'captured_at',
  updatedAt: 'updated_at',
  firstName: 'first_name',
  lastName: 'last_name',
  company: 'company',
  title: 'title',
  email: 'email',
  phone: 'phone',
  tags: 'tags',
  notes: 'notes',
  event: 'event',
  capturedBy: 'captured_by',
  source: 'source',
  phoneAlt: 'other_phone',
  website: 'website',
  linkedin: 'linkedin',
  address: 'address',
  other: 'other_info',
  cardPhotoPath: 'card_photo',
  qrRaw: 'qr_data',
};

export const NOT_ON_TEAM = "This login isn't on the InfoCapture team yet. Ask your InfoCapture admin to add you.";
export const NEEDS_DB_UPDATE = 'The database needs the lead board update first (supabase/setup.sql). Ask your InfoCapture admin to run it.';

export class StoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export function toRow(rec) {
  const row = {};
  for (const [key, col] of Object.entries(DB_COLUMNS)) {
    const v = rec[key];
    if (key === 'tags') row[col] = Array.isArray(v) ? v.map(String) : [];
    else if (key === 'createdAt' || key === 'updatedAt') row[col] = v || new Date().toISOString();
    else row[col] = v == null ? '' : String(v);
  }
  return row;
}

export function fromRow(row) {
  const rec = {};
  for (const [key, col] of Object.entries(DB_COLUMNS)) rec[key] = row[col] ?? (key === 'tags' ? [] : '');
  return rec;
}

// A lead as the lead board and the team spreadsheet see it: the contact, its
// follow-up, and the login that captured it.
export const teamLeadFromRow = (row) => ({ ...fromRow(row), ...followUpFromRow(row), createdBy: row.created_by ?? '' });

export const photoPath = (rec) => `${rec.id}.jpg`;

const missingTable = (error) => error?.code === 'PGRST205' || error?.code === '42P01';

// Turns a supabase-js { error, status } into the app's error types.
function fail(error, status, what) {
  const message = String(error?.message ?? error ?? '');
  if (globalThis.navigator?.onLine === false || status === 0 || error?.name === 'StorageUnknownError') throw new NetworkError();
  if (status === 401 || error?.code === 'PGRST301' || error?.code === 'PGRST303' || /jwt/i.test(message)) throw new AuthRequiredError();
  if (status === 403 || error?.code === '42501' || /row-level security/i.test(message)) throw new StoreError(NOT_ON_TEAM, 403);
  throw new StoreError(`${what}: ${message || `error ${status}`}`, status);
}

export class SupabaseStore {
  constructor(client) {
    this.client = client;
  }

  async upsert(rec) {
    const { error, status } = await this.client.from(TABLE).upsert(toRow(rec), { onConflict: 'id' });
    if (error) fail(error, status, 'Saving the contact');
  }

  async remove(rec) {
    const { error, status } = await this.client.from(TABLE).delete().eq('id', rec.id);
    if (error) fail(error, status, 'Deleting the contact');
    if (rec.cardPhotoPath) {
      const res = await this.client.storage.from(BUCKET).remove([rec.cardPhotoPath]);
      if (res.error) fail(res.error, res.error.status, 'Deleting the card photo');
    }
  }

  async uploadPhoto(rec, blob) {
    const path = photoPath(rec);
    const body = blob.arrayBuffer ? await blob.arrayBuffer() : blob;
    const { error } = await this.client.storage.from(BUCKET).upload(path, body, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
    if (error) fail(error, Number(error.statusCode ?? error.status ?? 400), 'Saving the card photo');
    return path;
  }

  // Everyone's contacts, oldest first; with createdBy (a user ID), only the
  // ones that login captured.
  async listAll({ createdBy } = {}) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      let query = this.client.from(TABLE).select('*');
      if (createdBy) query = query.eq('created_by', createdBy);
      const { data, error, status } = await query.order('captured_at').order('id').range(from, from + PAGE - 1);
      if (error) fail(error, status, 'Reading the team list');
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  // path -> link that opens the photo for `seconds`.
  async signedUrls(paths, seconds) {
    const out = new Map();
    for (let i = 0; i < paths.length; i += 500) {
      const { data, error } = await this.client.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 500), seconds);
      if (error) fail(error, Number(error.statusCode ?? error.status ?? 400), 'Linking the card photos');
      for (const d of data) if (d.signedUrl && !d.error) out.set(d.path, d.signedUrl);
    }
    return out;
  }

  // One contact from the team list, or null.
  async get(id) {
    const { data, error, status } = await this.client.from(TABLE).select('*').eq('id', id).limit(1);
    if (error) fail(error, status, 'Reading the contact');
    return data[0] ?? null;
  }

  // The lead board's changes to a contact's details, only the fields given.
  // updated_at moves on, so the phone that captured it merges them in.
  async updateContact(id, patch) {
    const all = toRow(patch);
    const row = Object.fromEntries(Object.entries(DB_COLUMNS).filter(([key]) => key in patch).map(([, col]) => [col, all[col]]));
    row.updated_at = new Date().toISOString();
    const { data, error, status } = await this.client.from(TABLE).update(row).eq('id', id).select('id');
    if (error) fail(error, status, 'Saving the contact');
    if (!data?.length) throw new StoreError('That contact is no longer in the team list.', 404);
    return row.updated_at;
  }

  // The lead board's follow-up changes, only the fields given.
  async updateFollowUp(id, patch) {
    const { data, error, status } = await this.client.from(TABLE).update(followUpToRow(patch)).eq('id', id).select('id');
    if (error?.code === 'PGRST204') throw new StoreError(NEEDS_DB_UPDATE, status);
    if (error) fail(error, status, 'Saving the follow-up');
    if (!data?.length) throw new StoreError('That contact is no longer in the team list.', 404);
  }

  // Follow-up notes, oldest first: one lead's, or every lead's.
  async listNotes(leadId) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      let query = this.client.from(NOTES).select('*');
      if (leadId) query = query.eq('lead_id', leadId);
      const { data, error, status } = await query.order('created_at').order('id').range(from, from + PAGE - 1);
      if (missingTable(error)) throw new StoreError(NEEDS_DB_UPDATE, status);
      if (error) fail(error, status, 'Reading the notes');
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  // A follow-up note on a lead; the database stamps who wrote it and when.
  async addNote(leadId, body) {
    const { data, error, status } = await this.client.from(NOTES).insert({ lead_id: leadId, body }).select('*');
    if (missingTable(error)) throw new StoreError(NEEDS_DB_UPDATE, status);
    if (error) fail(error, status, 'Saving the note');
    return data[0];
  }

  // Only the person who wrote a note can delete it (supabase/setup.sql).
  async removeNote(id) {
    const { data, error, status } = await this.client.from(NOTES).delete().eq('id', id).select('id');
    if (error) fail(error, status, 'Deleting the note');
    if (!data?.length) throw new StoreError('Only the person who wrote a note can delete it.', 403);
  }

  // The team, for the Follow-up Person list: user ID -> name.
  async teamList() {
    const { data, error, status } = await this.client.rpc('team_list');
    if (error?.code === 'PGRST202') throw new StoreError(NEEDS_DB_UPDATE, status);
    if (error) fail(error, status, 'Reading the team');
    return new Map(data.map((p) => [p.user_id, p.name]));
  }

  // Read-only health check for Settings > Test connection.
  async check() {
    const team = await this.client.rpc('is_team_member');
    if (team.error) fail(team.error, team.status, 'Checking the team');
    if (team.data !== true) return { member: false, rows: 0 };
    const { count, error, status } = await this.client.from(TABLE).select('id', { count: 'exact', head: true });
    if (error) fail(error, status, 'Reading the team list');
    return { member: true, rows: count ?? 0 };
  }
}

import defaults from '../config.js';

const KEY = 'infocapture.settings';
export const DEFAULT_TAGS = ['Hot lead', 'Follow up', 'Send info', 'Book a demo', 'Partner', 'Hiring'];

// Connection values come from config.js unless this device overrides them
// on the Settings screen. Capture preferences only live on the device.
const CONNECTION_KEYS = ['tenantId', 'clientId', 'apiScope', 'cardReaderUrl', 'workbook'];

let cache;

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function getSettings() {
  if (cache) return cache;
  const local = readLocal();
  const merged = { event: '', capturedBy: '', tags: DEFAULT_TAGS, ...local };
  for (const k of CONNECTION_KEYS) merged[k] = (local[k] ?? defaults[k] ?? '').trim();
  merged.workbook ||= '/InfoCapture/InfoCapture Leads.xlsx';
  merged.apiScope ||= merged.clientId ? `api://${merged.clientId}/access_as_user` : '';
  cache = merged;
  return cache;
}

export function saveSettings(patch) {
  const local = { ...readLocal(), ...patch };
  // An override equal to config.js is not an override; drop it so later
  // config.js changes still reach this device.
  for (const k of CONNECTION_KEYS) {
    if (k in patch && (patch[k] ?? '').trim() === (defaults[k] ?? '').trim()) delete local[k];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(local));
  } catch {
    // storage unavailable (private mode); keep the in-memory copy
  }
  cache = undefined;
  return getSettings();
}

export function isM365Configured(s = getSettings()) {
  return Boolean(s.tenantId && s.clientId);
}

// Small per-device values that are not settings (resolved workbook ids,
// dismissed hints).
export function getState(name, fallback = null) {
  try {
    const raw = localStorage.getItem(`infocapture.${name}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function setState(name, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(`infocapture.${name}`);
    else localStorage.setItem(`infocapture.${name}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// Client for the card reader Lambda (backend/card-reader). It sends a card
// or badge photo, or unrecognised QR text, and gets contact fields back.
// Requests carry the person's Microsoft 365 access token; the Lambda only
// answers people signed in to your tenant.

import { blobToBase64 } from './image.js';
import { NetworkError } from './auth.js';

export class CardReaderError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'CardReaderError';
    this.status = status;
  }
}

async function call(url, token, payload, timeoutMs = 80000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new CardReaderError('The card reader took too long. It will try again on the next sync.');
    throw new NetworkError('Could not reach the card reader.');
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // fall through with an empty body
  }
  if (!res.ok || data.ok === false) {
    throw new CardReaderError(data.error || `Card reader error (${res.status}).`, res.status);
  }
  return data;
}

// Both return the reader's reply: { contacts: [{ fields, confidence, unsure }],
// unreadable }. See applyReading() in fields.js.
export async function readCardPhoto(url, token, blob) {
  const image = await blobToBase64(blob);
  return call(url, token, { action: 'card', mediaType: blob.type || 'image/jpeg', image });
}

export async function readQrText(url, token, text) {
  return call(url, token, { action: 'text', text: text.slice(0, 4000) });
}

export async function pingCardReader(url, token) {
  return call(url, token, { action: 'ping' }, 20000);
}

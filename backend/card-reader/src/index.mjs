// InfoCapture card reader: an AWS Lambda behind a function URL.
//
// POST JSON with the person's Supabase access token (Authorization: Bearer ...):
//   { "action": "card", "mediaType": "image/jpeg", "image": "<base64>" }
//   { "action": "text", "text": "<QR text>" }
//   { "action": "ping" }
// Replies { "ok": true, "contacts": [{ fields, confidence, unsure }],
// "fields": <first contact's fields>, "unreadable": "" } or
// { "ok": false, "error": "..." }. "unreadable" names why nothing came back
// (declined, cut_off, no_answer, nothing_found); the app treats that as
// "couldn't read this card", not as an error. Only signed-in members of the
// InfoCapture team (public.team_members in Supabase) get an answer.

import Anthropic from '@anthropic-ai/sdk';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readCardImage, readQrText, IMAGE_TYPES } from './extract.mjs';

const MAX_IMAGE_BASE64 = 5 * 1024 * 1024; // Claude's per-image limit is 5 MB
const MAX_TEXT = 4000;

export class NotOnTeamError extends Error {}
export class TeamCheckError extends Error {}

// Checks a Supabase access token: signed with the project's key (from its
// public key set), issued by its Auth server to a signed-in user, and that
// user is on the team. Membership is asked of the database with the
// person's own token and remembered for a few minutes.
export function makeTokenVerifier({ supabaseUrl, publishableKey, keySet, fetchImpl = fetch, cacheMs = 5 * 60_000, now = Date.now }) {
  if (!supabaseUrl || !publishableKey) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set');
  const base = supabaseUrl.replace(/\/+$/, '');
  const jwks = keySet ?? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  const options = { issuer: `${base}/auth/v1`, audience: 'authenticated', algorithms: ['ES256', 'RS256'], clockTolerance: 60 };
  const members = new Map(); // user id -> when membership was confirmed
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, options);
    if (payload.role !== 'authenticated' || !payload.sub) throw new Error('not a signed-in user');
    const seen = members.get(payload.sub);
    if (seen !== undefined && now() - seen < cacheMs) return payload;
    let res;
    try {
      res = await fetchImpl(`${base}/rest/v1/rpc/is_team_member`, {
        method: 'POST',
        headers: { apikey: publishableKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (err) {
      throw new TeamCheckError(`team check failed: ${err.name}`);
    }
    if (!res.ok) throw new TeamCheckError(`team check failed (${res.status})`);
    if ((await res.json()) !== true) throw new NotOnTeamError('not on the team');
    members.set(payload.sub, now());
    return payload;
  };
}

// The Anthropic key lives in AWS Secrets Manager (stored with set-key.sh).
// It is read once per warm start, and again after a 401 so a replaced key
// takes effect without a redeploy.
async function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.API_KEY_SECRET }));
  return String(out.SecretString ?? '').trim();
}

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

// getClient(refresh): an Anthropic client; refresh=true re-reads the key.
export function createHandler({ verifyToken, getClient, model, effort = 'low', log = console }) {
  return async (event) => {
    const started = Date.now();
    const method = event.requestContext?.http?.method ?? 'POST';
    if (method === 'OPTIONS') return { statusCode: 204, body: '' };
    if (method !== 'POST') return reply(405, { ok: false, error: 'Use POST.' });

    const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    try {
      if (!token) throw new Error('no token');
      await verifyToken(token);
    } catch (err) {
      log.warn?.(JSON.stringify({ msg: 'rejected token', reason: err.message }));
      if (err instanceof NotOnTeamError) return reply(403, { ok: false, error: "This login isn't on the InfoCapture team yet." });
      if (err instanceof TeamCheckError) return reply(503, { ok: false, error: 'The card reader could not check your sign-in. Try again in a minute.' });
      return reply(401, { ok: false, error: 'Sign in again to use the card reader.' });
    }

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
      body = JSON.parse(raw || '{}');
    } catch {
      return reply(400, { ok: false, error: 'Request body must be JSON.' });
    }

    let read;
    let inputSize = 0;
    if (body.action === 'ping') {
      return reply(200, { ok: true, model });
    } else if (body.action === 'card') {
      const mediaType = String(body.mediaType || 'image/jpeg').toLowerCase();
      if (!IMAGE_TYPES.has(mediaType)) return reply(400, { ok: false, error: `Unsupported image type ${mediaType}. Take the photo again with Snap card.` });
      if (typeof body.image !== 'string' || !body.image) return reply(400, { ok: false, error: 'No image was sent.' });
      if (body.image.length > MAX_IMAGE_BASE64) return reply(413, { ok: false, error: 'That photo is too large.' });
      inputSize = body.image.length;
      read = (client) => readCardImage({ client, model, effort, image: body.image, mediaType });
    } else if (body.action === 'text') {
      const text = String(body.text ?? '').slice(0, MAX_TEXT);
      if (!text.trim()) return reply(400, { ok: false, error: 'No text was sent.' });
      inputSize = text.length;
      read = (client) => readQrText({ client, model, effort, text });
    } else {
      return reply(400, { ok: false, error: 'Unknown action.' });
    }

    try {
      let result;
      try {
        result = await read(await getClient(false));
      } catch (err) {
        if (!(err instanceof Anthropic.AuthenticationError)) throw err;
        result = await read(await getClient(true)); // the key may have been replaced
      }
      // Sizes, timing and token counts only: never what the card says.
      log.log?.(JSON.stringify({
        msg: 'read', action: body.action, inputBytes: inputSize, ms: Date.now() - started, model: result.model,
        stop: result.stopReason, contacts: result.contacts.length, unreadable: result.unreadable || undefined,
        inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
      }));
      return reply(200, { ok: true, contacts: result.contacts, fields: result.contacts[0]?.fields ?? {}, unreadable: result.unreadable });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return reply(503, { ok: false, error: 'The card reader is busy. Try again in a minute.' });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        log.error?.(JSON.stringify({ msg: 'Claude API key rejected', status: err.status }));
        return reply(500, { ok: false, error: 'The card reader is not configured correctly (API key).' });
      }
      if (err instanceof Anthropic.APIConnectionError) return reply(504, { ok: false, error: 'The card reader timed out. Try again.' });
      if (err instanceof Anthropic.APIError) {
        log.error?.(JSON.stringify({ msg: 'Claude API error', status: err.status, requestId: err.requestID }));
        return reply(502, { ok: false, error: 'The card reader had a problem. Try again.' });
      }
      log.error?.(JSON.stringify({ msg: 'unexpected error', name: err?.name }));
      return reply(500, { ok: false, error: 'The card reader had a problem. Try again.' });
    }
  };
}

let clientPromise;
export const handler = createHandler({
  verifyToken: process.env.SUPABASE_URL
    ? makeTokenVerifier({ supabaseUrl: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY })
    : async () => { throw new Error('SUPABASE_URL is not set'); },
  getClient: (refresh) => {
    if (refresh || !clientPromise) {
      clientPromise = readApiKey()
        .then((apiKey) => new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 }))
        .catch((err) => {
          clientPromise = undefined;
          throw err;
        });
    }
    return clientPromise;
  },
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  effort: process.env.CLAUDE_EFFORT || 'low',
});

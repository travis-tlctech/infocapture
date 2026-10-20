// InfoCapture card reader: an AWS Lambda behind a function URL.
//
// POST JSON with a Microsoft 365 access token (Authorization: Bearer ...):
//   { "action": "card", "mediaType": "image/jpeg", "image": "<base64>" }
//   { "action": "text", "text": "<QR text>" }
//   { "action": "ping" }
// Replies { "ok": true, "fields": { firstName, lastName, ... } } or
// { "ok": false, "error": "..." }. Only signed-in users of your Entra
// tenant who were granted the access_as_user scope get an answer.

import Anthropic from '@anthropic-ai/sdk';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readCardImage, readQrText, ExtractError, IMAGE_TYPES } from './extract.mjs';

const MAX_IMAGE_BASE64 = 5 * 1024 * 1024; // Claude's per-image limit is 5 MB
const MAX_TEXT = 4000;

export function makeTokenVerifier({ tenantId, clientId, scope = 'access_as_user', keySet }) {
  if (!tenantId || !clientId) throw new Error('TENANT_ID and CLIENT_ID must be set');
  const jwks = keySet ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  // v2 tokens use the client id as audience; v1 tokens (the default for a
  // new app registration) use the Application ID URI.
  const options = {
    issuer: [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
    audience: [clientId, `api://${clientId}`],
    algorithms: ['RS256'],
    clockTolerance: 60,
  };
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, options);
    if (payload.tid !== tenantId) throw new Error('token is for another tenant');
    if (!String(payload.scp ?? '').split(' ').includes(scope)) throw new Error(`token lacks the ${scope} scope`);
    return payload;
  };
}

let apiKeyPromise;
async function getApiKeyFromEnvOrSsm() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  apiKeyPromise ??= (async () => {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.API_KEY_PARAMETER, WithDecryption: true }));
    return out.Parameter.Value;
  })().catch((err) => {
    apiKeyPromise = undefined;
    throw err;
  });
  return apiKeyPromise;
}

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export function createHandler({ verifyToken, getClient, model, effort = 'low', log = console }) {
  return async (event) => {
    const started = Date.now();
    const method = event.requestContext?.http?.method ?? 'POST';
    if (method === 'OPTIONS') return { statusCode: 204, body: '' };
    if (method !== 'POST') return reply(405, { ok: false, error: 'Use POST.' });

    const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    let user;
    try {
      if (!token) throw new Error('no token');
      user = await verifyToken(token);
    } catch (err) {
      log.warn?.(JSON.stringify({ msg: 'rejected token', reason: err.message }));
      return reply(401, { ok: false, error: 'Sign in to Microsoft 365 again to use the card reader.' });
    }

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
      body = JSON.parse(raw || '{}');
    } catch {
      return reply(400, { ok: false, error: 'Request body must be JSON.' });
    }

    try {
      let result;
      if (body.action === 'ping') {
        return reply(200, { ok: true, model });
      } else if (body.action === 'card') {
        const mediaType = String(body.mediaType || 'image/jpeg').toLowerCase();
        if (!IMAGE_TYPES.has(mediaType)) return reply(400, { ok: false, error: `Unsupported image type ${mediaType}.` });
        if (typeof body.image !== 'string' || !body.image) return reply(400, { ok: false, error: 'No image was sent.' });
        if (body.image.length > MAX_IMAGE_BASE64) return reply(413, { ok: false, error: 'That photo is too large.' });
        result = await readCardImage({ client: await getClient(), model, effort, image: body.image, mediaType });
      } else if (body.action === 'text') {
        const text = String(body.text ?? '').slice(0, MAX_TEXT);
        if (!text.trim()) return reply(400, { ok: false, error: 'No text was sent.' });
        result = await readQrText({ client: await getClient(), model, effort, text });
      } else {
        return reply(400, { ok: false, error: 'Unknown action.' });
      }
      log.log?.(JSON.stringify({
        msg: 'read', action: body.action, user: user.oid, model: result.model, ms: Date.now() - started,
        inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
      }));
      return reply(200, { ok: true, fields: result.fields });
    } catch (err) {
      if (err instanceof ExtractError) return reply(err.status, { ok: false, error: err.message });
      if (err instanceof Anthropic.RateLimitError) return reply(503, { ok: false, error: 'The card reader is busy. It will try again on the next sync.' });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        log.error?.(JSON.stringify({ msg: 'Claude API key rejected', status: err.status }));
        return reply(500, { ok: false, error: 'The card reader is not configured correctly (API key).' });
      }
      if (err instanceof Anthropic.APIConnectionError) return reply(504, { ok: false, error: 'The card reader timed out. Try again.' });
      if (err instanceof Anthropic.APIError) {
        log.error?.(JSON.stringify({ msg: 'Claude API error', status: err.status, requestId: err.requestID }));
        return reply(502, { ok: false, error: 'The card reader had a problem. Try again.' });
      }
      log.error?.(err);
      return reply(500, { ok: false, error: 'The card reader had a problem. Try again.' });
    }
  };
}

let client;
export const handler = createHandler({
  verifyToken: process.env.TENANT_ID
    ? makeTokenVerifier({ tenantId: process.env.TENANT_ID, clientId: process.env.CLIENT_ID })
    : async () => { throw new Error('TENANT_ID is not set'); },
  getClient: async () => {
    client ??= new Anthropic({ apiKey: await getApiKeyFromEnvOrSsm(), timeout: 30_000, maxRetries: 1 });
    return client;
  },
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  effort: process.env.CLAUDE_EFFORT || 'low',
});

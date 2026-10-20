import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createHandler, makeTokenVerifier } from '../src/index.mjs';
import { CONTACT_SCHEMA, normalise } from '../src/extract.mjs';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const keySet = createLocalJWKSet({ keys: [jwk] });
const verifyToken = makeTokenVerifier({ tenantId: TENANT, clientId: CLIENT, keySet });

function token(claims = {}, { issuer = `https://login.microsoftonline.com/${TENANT}/v2.0`, audience = CLIENT, exp = '1h' } = {}) {
  return new SignJWT({ tid: TENANT, scp: 'access_as_user', oid: 'user-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          return typeof reply === 'function' ? reply(req) : reply;
        },
      },
    },
  };
}

const okReply = {
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1500, output_tokens: 120 },
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify({ firstName: 'Ana', lastName: 'Silva', title: 'CTO', company: 'Acme', email: 'ana@acme.io', phone: '+1 555 0100', phoneAlt: '', website: 'acme.io', linkedin: '', address: '', other: 'Speaker' }) },
  ],
};

const silent = { log() {}, warn() {}, error() {} };

function makeHandler(client) {
  return createHandler({ verifyToken, getClient: async () => client, model: 'claude-opus-5-5', effort: 'low', log: silent });
}

const event = (body, tok) => ({
  requestContext: { http: { method: 'POST' } },
  headers: tok ? { authorization: `Bearer ${tok}` } : {},
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

test('reads a card photo and sends a structured-output request', async () => {
  const client = fakeClient(okReply);
  const res = await makeHandler(client)(event({ action: 'card', mediaType: 'image/jpeg', image: 'AAAA' }, await token()));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.fields.firstName, 'Ana');
  assert.equal(body.fields.other, 'Speaker');

  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: CONTACT_SCHEMA });
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.thinking, undefined, 'thinking cannot be configured off on Opus 5.5');
  assert.equal(req.messages[0].content[0].type, 'image');
  assert.equal(req.messages[0].content[0].source.media_type, 'image/jpeg');
});

test('reads QR text, wrapped as data', async () => {
  const client = fakeClient(okReply);
  const res = await makeHandler(client)(event({ action: 'text', text: 'Ana^Silva^Acme' }, await token()));
  assert.equal(res.statusCode, 200);
  const text = client.calls[0].messages[0].content[0].text;
  assert.match(text, /<qr_text>\nAna\^Silva\^Acme\n<\/qr_text>/);
});

test('omits fallbacks for models that do not support them', async () => {
  const client = fakeClient(okReply);
  const handler = createHandler({ verifyToken, getClient: async () => client, model: 'claude-haiku-5-5', log: silent });
  await handler(event({ action: 'text', text: 'Ana Silva, Acme' }, await token()));
  assert.equal(client.calls[0].fallbacks, undefined);
  assert.equal(client.calls[0].betas, undefined);
});

test('accepts v1 tokens (sts.windows.net issuer, api:// audience)', async () => {
  const tok = await token({}, { issuer: `https://sts.windows.net/${TENANT}/`, audience: `api://${CLIENT}` });
  const res = await makeHandler(fakeClient(okReply))(event({ action: 'ping' }, tok));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).model, 'claude-opus-5-5');
});

test('rejects missing, foreign, expired and unscoped tokens', async () => {
  const handler = makeHandler(fakeClient(okReply));
  const cases = [
    undefined,
    await token({ tid: '99999999-2222-3333-4444-555555555555' }),
    await token({}, { audience: 'some-other-app' }),
    await token({}, { issuer: 'https://login.microsoftonline.com/other/v2.0' }),
    await token({ scp: 'User.Read' }),
    await token({}, { exp: Math.floor(Date.now() / 1000) - 600 }),
  ];
  for (const tok of cases) {
    const res = await handler(event({ action: 'ping' }, tok));
    assert.equal(res.statusCode, 401);
  }
  const forged = await new SignJWT({ tid: TENANT, scp: 'access_as_user' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(CLIENT)
    .setExpirationTime('1h')
    .sign((await generateKeyPair('RS256')).privateKey);
  assert.equal((await handler(event({ action: 'ping' }, forged))).statusCode, 401);
});

test('validates input', async () => {
  const handler = makeHandler(fakeClient(okReply));
  const tok = await token();
  assert.equal((await handler(event({ action: 'card', mediaType: 'application/pdf', image: 'AAAA' }, tok))).statusCode, 400);
  assert.equal((await handler(event({ action: 'card', image: '' }, tok))).statusCode, 400);
  assert.equal((await handler(event({ action: 'card', image: 'A'.repeat(5 * 1024 * 1024 + 1) }, tok))).statusCode, 413);
  assert.equal((await handler(event({ action: 'text', text: '   ' }, tok))).statusCode, 400);
  assert.equal((await handler(event({ action: 'nope' }, tok))).statusCode, 400);
  const bad = { ...event({}, tok), body: '{not json' };
  assert.equal((await handler(bad)).statusCode, 400);
  const get = { ...event({}, tok), requestContext: { http: { method: 'GET' } } };
  assert.equal((await handler(get)).statusCode, 405);
});

test('maps refusals and truncation to errors', async () => {
  const tok = await token();
  const refused = makeHandler(fakeClient({ ...okReply, stop_reason: 'refusal', content: [] }));
  assert.equal((await refused(event({ action: 'card', image: 'AAAA' }, tok))).statusCode, 422);
  const cut = makeHandler(fakeClient({ ...okReply, stop_reason: 'max_tokens' }));
  assert.equal((await cut(event({ action: 'card', image: 'AAAA' }, tok))).statusCode, 502);
});

test('handles base64-encoded bodies', async () => {
  const tok = await token();
  const e = event({ action: 'text', text: 'Ana Silva' }, tok);
  e.body = Buffer.from(e.body).toString('base64');
  e.isBase64Encoded = true;
  assert.equal((await makeHandler(fakeClient(okReply))(e)).statusCode, 200);
});

test('normalise keeps only known string fields', () => {
  const out = normalise({ firstName: '  Ana\n ', email: 42, extra: 'x' });
  assert.equal(out.firstName, 'Ana');
  assert.equal(out.email, '');
  assert.equal('extra' in out, false);
  assert.equal(Object.keys(out).length, 11);
});

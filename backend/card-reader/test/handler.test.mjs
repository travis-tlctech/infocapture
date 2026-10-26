import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createHandler, makeTokenVerifier } from '../src/index.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { CARD_SCHEMA, SYSTEM_PROMPT, checkEntry } from '../src/extract.mjs';

const SUPABASE = 'https://test.supabase.co';
const KEY = 'sb_publishable_test';

// Supabase signs access tokens with an ES256 key it publishes as a key set.
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
const keySet = createLocalJWKSet({ keys: [jwk] });

// Stands in for is_team_member(): only user-1 is on the team.
const subOf = (bearer) => JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url')).sub;
const teamFetch = async (url, init) => new Response(JSON.stringify(subOf(init.headers.authorization) === 'user-1'), { status: 200 });
const verifyToken = makeTokenVerifier({ supabaseUrl: SUPABASE, publishableKey: KEY, keySet, fetchImpl: teamFetch });

function token({ sub = 'user-1', ...claims } = {}, { issuer = `${SUPABASE}/auth/v1`, audience = 'authenticated', exp = '1h', key = privateKey } = {}) {
  return new SignJWT({ role: 'authenticated', email: 'ana@example.com', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
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

const entry = (over = {}) => ({
  firstName: 'Ana', lastName: 'Silva', title: 'CTO', company: 'Acme', email: 'ana@acme.io', phone: '+1 555 0100',
  phoneAlt: null, website: 'acme.io', linkedin: null, address: null, other: 'Speaker', confidence: 0.92, unsure: [], ...over,
});
const replyWith = (contacts, over = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1500, output_tokens: 120 },
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify({ contacts }) },
  ],
  ...over,
});
const okReply = replyWith([entry()]);

const silent = { log() {}, warn() {}, error() {} };

function makeHandler(client, log = silent) {
  return createHandler({ verifyToken, getClient: async () => client, model: 'claude-opus-5-5', effort: 'low', log });
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
  assert.equal(body.unreadable, '');
  assert.equal(body.fields.firstName, 'Ana');
  assert.equal(body.fields.phoneAlt, '', 'null becomes an empty field');
  assert.equal(body.contacts.length, 1);
  assert.equal(body.contacts[0].confidence, 0.92);
  assert.deepEqual(body.contacts[0].unsure, []);

  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: CARD_SCHEMA });
  assert.match(req.system, /Never correct spelling/);
  assert.match(req.system, /untrusted input/);
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

test('asks the database whether the person is on the team, and remembers it for a few minutes', async () => {
  let t = 0;
  const calls = [];
  const verify = makeTokenVerifier({
    supabaseUrl: `${SUPABASE}/`, publishableKey: KEY, keySet, now: () => t,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('true'); },
  });
  const tok = await token();
  await verify(tok);
  await verify(tok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SUPABASE}/rest/v1/rpc/is_team_member`);
  assert.equal(calls[0].init.headers.apikey, KEY);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${tok}`);
  t += 6 * 60_000;
  await verify(tok);
  assert.equal(calls.length, 2);

  const res = await makeHandler(fakeClient(okReply))(event({ action: 'ping' }, tok));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).model, 'claude-opus-5-5');
});

test('a signed-in person who is not on the team gets a 403; a failed team check a 503', async () => {
  const res = await makeHandler(fakeClient(okReply))(event({ action: 'card', image: 'AAAA' }, await token({ sub: 'user-2' })));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /isn't on the InfoCapture team/);
  const unreachable = makeTokenVerifier({ supabaseUrl: SUPABASE, publishableKey: KEY, keySet, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const down = createHandler({ verifyToken: unreachable, getClient: async () => fakeClient(okReply), model: 'claude-opus-5-5', log: silent });
  assert.equal((await down(event({ action: 'ping' }, await token()))).statusCode, 503);
});

test('rejects missing, foreign, expired, anonymous and forged tokens', async () => {
  const handler = makeHandler(fakeClient(okReply));
  const cases = [
    undefined,
    'not-a-jwt',
    await token({}, { issuer: 'https://other.supabase.co/auth/v1' }),
    await token({}, { audience: 'anon' }),
    await token({ role: 'anon' }),
    await token({}, { exp: Math.floor(Date.now() / 1000) - 600 }),
    await token({}, { key: (await generateKeyPair('ES256')).privateKey }),
  ];
  for (const tok of cases) {
    const res = await handler(event({ action: 'ping' }, tok));
    assert.equal(res.statusCode, 401, String(tok).slice(0, 20));
  }
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

test('refusals, cut-off and empty replies come back as "couldn\'t read it", not errors', async () => {
  const tok = await token();
  const cases = [
    [replyWith([], { stop_reason: 'refusal', content: [] }), 'declined'],
    [replyWith([entry()], { stop_reason: 'max_tokens' }), 'cut_off'],
    [replyWith([], { content: [{ type: 'text', text: 'not json' }] }), 'no_answer'],
    [replyWith([]), 'nothing_found'],
    [replyWith([entry({ firstName: null, lastName: null, title: null, company: null, email: null, phone: null, website: null, other: null })]), 'nothing_found'],
  ];
  for (const [r, why] of cases) {
    const res = await makeHandler(fakeClient(r))(event({ action: 'card', image: 'AAAA' }, tok));
    assert.equal(res.statusCode, 200, why);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.unreadable, why);
    assert.deepEqual(body.contacts, []);
  }
});

test('one entry per person on the card', async () => {
  const two = replyWith([entry(), entry({ firstName: 'Bo', lastName: 'Lind', email: 'bo@acme.io', confidence: 0.8 })]);
  const res = await makeHandler(fakeClient(two))(event({ action: 'card', image: 'AAAA' }, await token()));
  const body = JSON.parse(res.body);
  assert.equal(body.contacts.length, 2);
  assert.equal(body.contacts[1].fields.firstName, 'Bo');
  assert.equal(body.fields.firstName, 'Ana', 'fields is the first person');
});

test('values that do not look right are flagged for checking, never dropped', () => {
  const checked = checkEntry(entry({ email: 'ana at acme', phone: '555-01', website: 'acme .io', confidence: 7, unsure: ['title', 'bogus', 'address'] }));
  assert.equal(checked.fields.email, 'ana at acme');
  assert.deepEqual(checked.unsure.sort(), ['email', 'phone', 'title', 'website']);
  assert.equal(checked.confidence, 1);
  assert.equal(checkEntry(entry({ confidence: 'high' })).confidence, 0);
  assert.equal(checkEntry(null), null);
});

test('a replaced key takes effect after a 401', async () => {
  let refreshed = false;
  const good = fakeClient(okReply);
  const stale = { beta: { messages: { create: async () => { throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()); } } } };
  const handler = createHandler({ verifyToken, model: 'claude-opus-5-5', log: silent, getClient: async (refresh) => { if (refresh) refreshed = true; return refresh ? good : stale; } });
  const res = await handler(event({ action: 'card', image: 'AAAA' }, await token()));
  assert.equal(res.statusCode, 200);
  assert.equal(refreshed, true);
  const alwaysBad = createHandler({ verifyToken, model: 'claude-opus-5-5', log: silent, getClient: async () => stale });
  assert.equal((await alwaysBad(event({ action: 'card', image: 'AAAA' }, await token()))).statusCode, 500);
});

test('logs hold sizes, timing and token counts, never card content', async () => {
  const lines = [];
  const log = { log: (l) => lines.push(l), warn() {}, error: (l) => lines.push(String(l)) };
  await makeHandler(fakeClient(okReply), log)(event({ action: 'card', image: 'QUJD'.repeat(100) }, await token()));
  const all = lines.join('\n');
  assert.match(all, /"inputBytes":400/);
  assert.match(all, /"inputTokens":1500/);
  for (const secret of ['Ana', 'Silva', 'acme', 'Speaker', 'user-1']) assert.equal(all.includes(secret), false, secret);
});

test('handles base64-encoded bodies', async () => {
  const tok = await token();
  const e = event({ action: 'text', text: 'Ana Silva' }, tok);
  e.body = Buffer.from(e.body).toString('base64');
  e.isBase64Encoded = true;
  assert.equal((await makeHandler(fakeClient(okReply))(e)).statusCode, 200);
});

test('checkEntry keeps only known string fields', () => {
  const out = checkEntry({ firstName: '  Ana\n ', email: 42, extra: 'x', confidence: 0.5, unsure: [] });
  assert.equal(out.fields.firstName, 'Ana');
  assert.equal(out.fields.email, '');
  assert.equal('extra' in out.fields, false);
  assert.equal(Object.keys(out.fields).length, 11);
});

test('the system prompt carries the handoff rules', () => {
  for (const rule of [/exactly what is printed/, /null/, /One entry per person/, /logo/i, /Handwritten/, /untrusted input/]) assert.match(SYSTEM_PROMPT, rule);
});

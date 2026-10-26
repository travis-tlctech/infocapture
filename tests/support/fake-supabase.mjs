// An in-memory stand-in for the parts of Supabase that InfoCapture uses:
// password sign-in, the "leads" table through PostgREST, the
// is_team_member() function, and the "card-photos" storage bucket. It
// applies the same rules as supabase/setup.sql: only team members can read
// or write. Used by the unit tests (as supabase-js's fetch) and by the
// Playwright tests (through page.route()).

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
const empty = (status = 204, headers = {}) => ({ status, headers, body: '' });

export const TEST_URL = 'https://test.supabase.co';
export const TEST_KEY = 'sb_publishable_test';

export class FakeSupabase {
  constructor() {
    this.users = new Map(); // email -> { id, email, password, member }
    this.tokens = new Map(); // access token -> user id
    this.refresh = new Map(); // refresh token -> user id
    this.leads = new Map(); // id -> row
    this.objects = new Map(); // path -> { contentType, size, upsert }
    this.requests = [];
    this.n = 0;
  }

  addUser({ email, password = 'correct horse', member = true, name } = {}) {
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    const user = { id, email, password, member, name };
    this.users.set(email.toLowerCase(), user);
    return user;
  }

  userById(id) {
    return [...this.users.values()].find((u) => u.id === id);
  }

  // A session as Supabase returns it (and as supabase-js stores it).
  createSession(user, { expiresIn = 3600 } = {}) {
    const n = ++this.n;
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const access = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp, n })}.sig${n}`;
    const refresh = `refresh-${n}`;
    this.tokens.set(access, user.id);
    this.refresh.set(refresh, user.id);
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: exp,
      refresh_token: refresh,
      user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, user_metadata: user.name ? { name: user.name } : {}, app_metadata: {} },
    };
  }

  rows() {
    return [...this.leads.values()].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  }

  // headers: lower-case names. body: Buffer, string or undefined.
  handle(method, url, headers, body) {
    const u = new URL(url);
    this.requests.push({ method, path: u.pathname, search: u.search });
    const text = body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    const parse = () => (text ? JSON.parse(text) : {});
    const bearer = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const caller = this.userById(this.tokens.get(bearer));

    if (!headers.apikey) return json(401, { message: 'No API key found in request' });

    // ---------- auth ----------
    if (u.pathname === '/auth/v1/token' && method === 'POST') {
      const data = parse();
      let user;
      if (u.searchParams.get('grant_type') === 'password') {
        user = this.users.get(String(data.email ?? '').toLowerCase());
        if (!user || user.password !== data.password) return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      } else {
        user = this.userById(this.refresh.get(data.refresh_token));
        if (!user) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        this.refresh.delete(data.refresh_token);
      }
      return json(200, this.createSession(user));
    }
    if (u.pathname === '/auth/v1/logout') {
      this.tokens.delete(bearer);
      return empty();
    }
    if (u.pathname === '/auth/v1/user') {
      return caller ? json(200, this.createSession(caller).user) : json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    }

    // Everything below needs a signed-in user, as with the real grants.
    if (u.pathname.startsWith('/rest/') || u.pathname.startsWith('/storage/')) {
      if (!caller) return json(401, { code: '42501', message: 'permission denied for table leads' });
    }

    // ---------- database ----------
    if (u.pathname === '/rest/v1/rpc/is_team_member' && method === 'POST') return json(200, caller.member);

    if (u.pathname === '/rest/v1/leads') {
      const denied = () => json(403, { code: '42501', message: 'new row violates row-level security policy for table "leads"', details: null, hint: null });
      if (method === 'POST') {
        if (!caller.member) return denied();
        const incoming = [].concat(parse());
        for (const row of incoming) {
          const existing = this.leads.get(row.id);
          this.leads.set(row.id, { ...(existing ?? { created_by: caller.id }), ...row });
        }
        return empty(201);
      }
      if (method === 'DELETE') {
        const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
        if (caller.member) this.leads.delete(id);
        return empty();
      }
      if (method === 'GET' || method === 'HEAD') {
        const by = u.searchParams.get('created_by')?.replace(/^eq\./, '');
        const all = caller.member ? this.rows().filter((r) => !by || r.created_by === by) : [];
        if (method === 'HEAD') return empty(200, { 'content-range': `*/${all.length}` });
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const limit = Number(u.searchParams.get('limit') ?? all.length);
        const page = all.slice(offset, offset + limit);
        return json(200, page, { 'content-range': `${offset}-${offset + page.length - 1}/*` });
      }
    }

    // ---------- storage ----------
    const objectPrefix = '/storage/v1/object/card-photos';
    const storageDenied = () => json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if (u.pathname === '/storage/v1/object/sign/card-photos' && method === 'POST') {
      if (!caller.member) return storageDenied();
      const { paths, expiresIn } = parse();
      return json(200, paths.map((p) => (this.objects.has(p)
        ? { error: null, path: p, signedURL: `/object/sign/card-photos/${p}?token=signed-${expiresIn}` }
        : { error: 'Either the object does not exist or you do not have access to it', path: p, signedURL: null })));
    }
    if (u.pathname === objectPrefix && method === 'DELETE') {
      if (!caller.member) return json(200, []);
      const { prefixes } = parse();
      const gone = prefixes.filter((p) => this.objects.delete(p));
      return json(200, gone.map((name) => ({ name, bucket_id: 'card-photos' })));
    }
    if (u.pathname.startsWith(`${objectPrefix}/`) && method === 'POST') {
      if (!caller.member) return storageDenied();
      const path = decodeURIComponent(u.pathname.slice(objectPrefix.length + 1));
      if (this.objects.has(path) && headers['x-upsert'] !== 'true') return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      this.objects.set(path, { contentType: headers['content-type'], size: Buffer.isBuffer(body) ? body.length : text.length, upsert: headers['x-upsert'] });
      return json(200, { Id: `obj-${path}`, Key: `card-photos/${path}` });
    }

    return json(404, { message: `FakeSupabase has no route for ${method} ${u.pathname}` });
  }

  // A fetch() for supabase-js in Node.
  fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = Buffer.from(await req.arrayBuffer());
    const headers = Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const res = this.handle(req.method, req.url, headers, body.length ? body : undefined);
    const nobody = res.status === 204 || req.method === 'HEAD';
    return new Response(nobody ? null : res.body, { status: res.status, headers: res.headers });
  };
}

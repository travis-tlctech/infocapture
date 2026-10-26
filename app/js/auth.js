// Sign-in with Supabase Auth (email and password; the admin creates each
// login). The session lives in localStorage and refreshes in the background,
// so people stay signed in; capturing never waits on sign-in, only syncing.

// Loaded with the app itself (and cached for offline use by sw.js), never
// later: a library that fails to load on a weak connection would leave the
// app signed out until it was reopened.
import { createClient } from '../vendor/supabase.min.js';

export const SESSION_KEY = 'infocapture.auth';

export class AuthRequiredError extends Error {
  constructor(message = 'Sign in again to keep syncing.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class NetworkError extends Error {
  constructor(message = 'No connection.') {
    super(message);
    this.name = 'NetworkError';
  }
}

let client = null;
let user = null;

const offline = () => globalThis.navigator?.onLine === false;
const isNetworkFailure = (err) => err?.name === 'AuthRetryableFetchError' || offline();

function storedUser() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')?.user ?? null;
  } catch {
    return null;
  }
}

export async function initAuth(settings) {
  client = null;
  user = null;
  if (!settings.supabaseUrl || !settings.supabaseKey) return null;
  client = createClient(settings.supabaseUrl, settings.supabaseKey, {
    auth: { storageKey: SESSION_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  // Offline with an expired token the library reports no session, but the
  // stored one is still good once there is signal; only a real sign-out
  // (or a refresh the server refuses) clears it.
  user = storedUser();
  client.auth.onAuthStateChange((event, session) => {
    if (session?.user) user = session.user;
    else if (event === 'SIGNED_OUT') user = null;
  });
  return getAccount();
}

export const isAuthReady = () => Boolean(client);
export const getClient = () => client;

export function getAccount() {
  if (!user) return null;
  return { id: user.id, name: user.user_metadata?.name || user.email, username: user.email };
}

export async function signIn(email, password) {
  if (!client) throw new Error('Add the Supabase project URL and publishable key in Settings first.');
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    if (isNetworkFailure(error)) throw new NetworkError('No connection. Sign in when you have signal.');
    if (error.code === 'invalid_credentials') throw new Error('That email and password did not match.');
    if (error.code === 'email_not_confirmed') throw new Error('This login is not confirmed yet. Ask your InfoCapture admin to confirm it in Supabase.');
    throw new Error(error.message || 'Sign-in failed.');
  }
  user = data.user;
  return getAccount();
}

export async function signOut() {
  if (!client) return;
  // Ends this phone's session only; other devices stay signed in.
  await client.auth.signOut({ scope: 'local' });
  user = null;
}

export async function getAccessToken() {
  if (!client || !user) throw new AuthRequiredError('Sign in to sync.');
  const { data, error } = await client.auth.getSession();
  if (data?.session?.access_token) return data.session.access_token;
  if (error && isNetworkFailure(error)) throw new NetworkError();
  user = storedUser();
  const e = new AuthRequiredError();
  e.cause = error;
  throw e;
}

// True when this login is on the InfoCapture team (supabase/add-team-member.sql).
export async function isTeamMember() {
  if (!client || !user) return false;
  const { data, error } = await client.rpc('is_team_member');
  if (error) {
    if (error.status === 0 || offline()) throw new NetworkError();
    throw new Error(error.message);
  }
  return data === true;
}

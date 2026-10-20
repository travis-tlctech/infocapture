// Microsoft 365 sign-in with MSAL.js (authorization code flow with PKCE).
// Tokens are cached in localStorage so people stay signed in between
// sessions; capturing never waits on sign-in, only syncing does.

export const GRAPH_SCOPES = ['User.Read', 'Files.ReadWrite.All'];

const NETWORK_CODES = new Set(['no_network_connectivity', 'post_request_failed', 'get_request_failed']);

export class AuthRequiredError extends Error {
  constructor(message = 'Sign in to Microsoft 365 again to keep syncing.') {
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

let pca = null;
let testAuth = null;
let redirectError = null;

export async function initAuth(settings) {
  // Automated tests inject a stand-in for MSAL before the app loads.
  testAuth = globalThis.__INFOCAPTURE_TEST_AUTH__ ?? null;
  if (testAuth) return getAccount();
  if (!settings.tenantId || !settings.clientId) return null;

  const { PublicClientApplication } = await import('../vendor/msal-browser.min.js');
  pca = new PublicClientApplication({
    auth: {
      clientId: settings.clientId,
      authority: `https://login.microsoftonline.com/${settings.tenantId}`,
      // MSAL v5 returns through a small bridge page; see redirect.html.
      redirectUri: new URL('redirect.html', document.baseURI).href,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();
  try {
    const result = await pca.handleRedirectPromise();
    if (result?.account) pca.setActiveAccount(result.account);
  } catch (err) {
    redirectError = err;
    console.warn('Microsoft sign-in did not complete', err);
  }
  if (!pca.getActiveAccount()) {
    const [first] = pca.getAllAccounts();
    if (first) pca.setActiveAccount(first);
  }
  return getAccount();
}

export function takeRedirectError() {
  const err = redirectError;
  redirectError = null;
  return err;
}

export function isAuthReady() {
  return Boolean(testAuth || pca);
}

export function getAccount() {
  if (testAuth) return testAuth.account ?? null;
  const a = pca?.getActiveAccount();
  return a ? { name: a.name || a.username, username: a.username } : null;
}

export async function signIn() {
  if (testAuth) return testAuth.signIn?.();
  if (!pca) throw new Error('Add the Microsoft 365 tenant and client IDs in Settings first.');
  await pca.loginRedirect({ scopes: GRAPH_SCOPES, prompt: 'select_account' });
}

export async function signOut() {
  if (testAuth) return testAuth.signOut?.();
  const account = pca?.getActiveAccount();
  if (!account) return;
  // Clears tokens on this device only; the Microsoft session is untouched.
  await pca.clearCache({ account });
  pca.setActiveAccount(null);
}

// Sends the person through Microsoft sign-in again for `scopes` (used when a
// silent refresh is no longer possible, or consent is needed).
export async function reauthorize(scopes = GRAPH_SCOPES) {
  if (testAuth) return testAuth.signIn?.();
  const account = pca?.getActiveAccount();
  if (!account) return signIn();
  await pca.acquireTokenRedirect({ scopes, account });
}

async function getToken(scopes) {
  if (testAuth) return testAuth.getToken(scopes);
  const account = pca?.getActiveAccount();
  if (!account) throw new AuthRequiredError('Sign in to Microsoft 365 to sync.');
  try {
    const result = await pca.acquireTokenSilent({ scopes, account });
    return result.accessToken;
  } catch (err) {
    if (NETWORK_CODES.has(err?.errorCode) || !navigator.onLine) throw new NetworkError();
    // Anything else (expired refresh token, consent, blocked iframe on iOS)
    // needs the person to sign in again.
    const e = new AuthRequiredError();
    e.cause = err;
    e.scopes = scopes;
    throw e;
  }
}

export const getGraphToken = () => getToken(GRAPH_SCOPES);
export const getApiToken = (settings) => getToken([settings.apiScope]);

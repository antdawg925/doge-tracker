import { supabase } from './supabase.js';

/** fetch() to our /api routes with the signed-in user's access token; throws with the server's message. */
export async function authedFetch(path, { method = 'GET', body } = {}) {
  const { data } = (await supabase?.auth.getSession()) ?? {};
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sign in first.');
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return json;
}

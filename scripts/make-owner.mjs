/**
 * Promote an existing Trade Smart account to owner (role 'owner' + bot access).
 *
 *   node --env-file=.env.local scripts/make-owner.mjs you@example.com
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (server-only;
 * never commit them). The account must already exist: sign up in the app first.
 * Equivalent SQL (Supabase dashboard → SQL editor):
 *   update public.profiles set role = 'owner', bot_access = true where email = 'you@example.com';
 */
const email = String(process.argv[2] || '').trim().toLowerCase();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !email.includes('@')) {
  console.error('Usage: node --env-file=.env.local scripts/make-owner.mjs <email>');
  process.exit(1);
}
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. in .env.local) first.');
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
  method: 'PATCH',
  headers: {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify({ role: 'owner', bot_access: true }),
});
const body = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`Supabase error (HTTP ${res.status}):`, body?.message || body);
  process.exit(1);
}
if (!Array.isArray(body) || body.length === 0) {
  console.error(`No account found for ${email}. Sign up in the app first, then rerun.`);
  process.exit(1);
}
const p = body[0];
console.log(`OK: ${p.email} is now ${p.role} (bot access: ${p.bot_access}).`);

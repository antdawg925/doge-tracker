/** Readable invite codes like TS-7KQM-XW3P (no 0/O/1/I/L to avoid misreads). */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateInviteCode() {
  const bytes = new Uint32Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `TS-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function signupLink(code) {
  return `${window.location.origin}/signup?code=${encodeURIComponent(code)}`;
}

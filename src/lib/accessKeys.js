/** Readable access keys like TS-7KQM-XW3P (no 0/O/1/I/L to avoid misreads). */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateAccessKey() {
  const bytes = new Uint32Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `TS-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Link that opens the locked bot screen with the key prefilled. */
export function redeemLink(code) {
  return `${window.location.origin}/alerts?key=${encodeURIComponent(code)}`;
}

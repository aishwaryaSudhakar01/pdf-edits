/**
 * Content-addressed image store for stamp/signature bytes.
 *
 * Annotations in editor history snapshots hold only an `imageKey` string, not
 * the raw Uint8Array. Multiple history entries that reference the same image
 * therefore share a single underlying byte buffer instead of holding 100×
 * copies. Bytes are NEVER evicted automatically — undoing back to a state that
 * references an old image must always succeed in re-resolving the bytes.
 */

export type ImageKind = 'png' | 'jpg';

export interface StoredImage {
  bytes: Uint8Array;
  type: ImageKind;
}

const store = new Map<string, StoredImage>();

/** FNV-1a 32-bit (cheap, non-cryptographic) — sufficient for dedup keying. */
function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  // Sample-and-fold to keep large images fast: hash header, tail, and length.
  const len = bytes.length;
  const sampleEnd = Math.min(len, 4096);
  for (let i = 0; i < sampleEnd; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  for (let i = Math.max(sampleEnd, len - 4096); i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= len;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16) + '_' + len.toString(16);
}

export function putImage(bytes: Uint8Array, type: ImageKind): string {
  const key = hashBytes(bytes);
  if (!store.has(key)) store.set(key, { bytes, type });
  return key;
}

export function getImage(key: string): StoredImage | undefined {
  return store.get(key);
}

export function getImageBytes(key: string): Uint8Array | undefined {
  return store.get(key)?.bytes;
}

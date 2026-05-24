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

const imageStoreGlobal = globalThis as typeof globalThis & {
  __pdfEditorImageStore?: Map<string, StoredImage>;
};

const store = imageStoreGlobal.__pdfEditorImageStore ?? (imageStoreGlobal.__pdfEditorImageStore = new Map<string, StoredImage>());

/**
 * FNV-1a 32-bit over the FULL byte array.
 *
 * Earlier we sampled only head and tail. That collided for two distinct
 * images that happened to share header, trailer, and length — both stamps
 * resolved to the same key and rendered identically.
 *
 * Hashing every byte is fast enough for the image sizes we handle here
 * (single-pass, no allocations). Even with a clean hash we still verify
 * byte-equality on a key hit and store under a salted key on collision,
 * because FNV-1a is not collision-free.
 */
function hashAllBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= len;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16) + '_' + len.toString(16);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function putImage(bytes: Uint8Array, type: ImageKind): string {
  const baseKey = hashAllBytes(bytes);
  // Verify true byte-equality on hash hit; on collision, salt the key.
  let key = baseKey;
  let salt = 0;
  while (store.has(key)) {
    const existing = store.get(key)!;
    if (bytesEqual(existing.bytes, bytes)) return key;
    salt += 1;
    key = `${baseKey}_c${salt}`;
  }
  store.set(key, { bytes, type });
  return key;
}

export function getImage(key: string): StoredImage | undefined {
  return store.get(key);
}

export function getImageBytes(key: string): Uint8Array | undefined {
  return store.get(key)?.bytes;
}

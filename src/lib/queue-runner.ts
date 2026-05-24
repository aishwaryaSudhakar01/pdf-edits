import { PDFDocument } from 'pdf-lib';
import type { Annotation } from '../components/AnnotationOverlay';
import { PdfOpError, type CropValues, type RedactRect, type PageItem } from './pdf-utils';
import { getImage } from './image-store';

/* ── Queue types (mirror PdfWorkspace) ─────────── */
export type QueueStepType =
  | 'organize' | 'rotate' | 'pageNumbers' | 'watermark' | 'redact' | 'crop'
  | 'resize' | 'compress' | 'metadata' | 'annotations' | 'split';

export interface QueueItem { id: string; type: QueueStepType }

/* ── Preflight ─────────────────────────────────── */

export interface PreflightIssue {
  operation: QueueStepType;
  message: string;
  /** Page number (1-based) when the issue is page-scoped. */
  pageNumber?: number;
}

export interface PreflightContext {
  pages: PageItem[];
  annotationsMap: Map<number, Annotation[]>;
  redactions: Map<number, RedactRect[]>;
  cropMap: Map<number, CropValues>;
  splitGroups: string[][];
  pn: { enabled: boolean; fontSize: number; startNumber: number };
  wm: { enabled: boolean; text: string; textByPage: Map<number, string>; fontSize: number };
  resize: { enabled: boolean; width: number; height: number };
  compress: { enabled: boolean; quality: number };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPG_MAGIC = [0xff, 0xd8, 0xff];

function looksLikePng(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  return PNG_MAGIC.every((v, i) => b[i] === v);
}
function looksLikeJpg(b: Uint8Array): boolean {
  if (b.length < 3) return false;
  return JPG_MAGIC.every((v, i) => b[i] === v);
}

export function preflightQueue(queue: QueueItem[], ctx: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const inQueue = new Set(queue.map(q => q.type));

  if (ctx.pages.length === 0) {
    issues.push({ operation: 'organize', message: 'No pages in document' });
    return issues;
  }

  if (inQueue.has('split')) {
    const nonEmpty = ctx.splitGroups.filter(g => g.length > 0);
    if (nonEmpty.length === 0) {
      issues.push({ operation: 'split', message: 'Split is queued but no groups have pages assigned' });
    } else {
      const validIds = new Set(ctx.pages.map(p => p.id));
      for (let gi = 0; gi < ctx.splitGroups.length; gi++) {
        const group = ctx.splitGroups[gi];
        const stale = group.filter(id => !validIds.has(id));
        if (stale.length > 0) {
          issues.push({ operation: 'split', message: `Group ${gi + 1} references ${stale.length} page(s) that no longer exist` });
        }
      }
    }
  }

  if (inQueue.has('annotations')) {
    for (const [pageIdx, anns] of ctx.annotationsMap.entries()) {
      for (const ann of anns) {
        if (ann.type === 'stamp') {
          const stampBytes = ann.imageKey ? getImage(ann.imageKey)?.bytes : ann.imageData;
          if (!stampBytes || stampBytes.length === 0) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: stamp has no image data` });
          } else if (!looksLikePng(ann.imageData) && !looksLikeJpg(ann.imageData)) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: stamp image is not a valid PNG or JPEG` });
          }
        } else if (ann.type === 'signature') {
          if (!ann.signatureData || ann.signatureData.length === 0) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: signature has no data` });
          } else if (!looksLikePng(ann.signatureData)) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: signature is not a valid PNG` });
          }
        } else if (ann.type === 'text') {
          if (!ann.text || ann.text.length === 0) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: text annotation is empty` });
          }
          const fs = ann.fontSize ?? 16;
          if (fs < 4 || fs > 200) {
            issues.push({ operation: 'annotations', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: text annotation font size ${fs} out of range (4–200)` });
          }
        }
      }
    }
  }

  if (inQueue.has('pageNumbers') && ctx.pn.enabled) {
    if (ctx.pn.fontSize < 4 || ctx.pn.fontSize > 200) {
      issues.push({ operation: 'pageNumbers', message: `Page-number font size ${ctx.pn.fontSize} out of range (4–200)` });
    }
    if (!Number.isFinite(ctx.pn.startNumber)) {
      issues.push({ operation: 'pageNumbers', message: 'Page-number start value is not a number' });
    }
  }

  if (inQueue.has('watermark') && ctx.wm.enabled) {
    const hasAny = !!ctx.wm.text || ctx.wm.textByPage.size > 0;
    if (!hasAny) {
      issues.push({ operation: 'watermark', message: 'Watermark is enabled but no text is set' });
    }
    if (ctx.wm.fontSize < 4 || ctx.wm.fontSize > 200) {
      issues.push({ operation: 'watermark', message: `Watermark font size ${ctx.wm.fontSize} out of range (4–200)` });
    }
  }

  if (inQueue.has('crop')) {
    for (const [pageIdx, c] of ctx.cropMap.entries()) {
      if (c.top + c.bottom >= 100) {
        issues.push({ operation: 'crop', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: top + bottom crop ≥ 100% (page would be empty)` });
      }
      if (c.left + c.right >= 100) {
        issues.push({ operation: 'crop', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: left + right crop ≥ 100% (page would be empty)` });
      }
      if (c.top < 0 || c.right < 0 || c.bottom < 0 || c.left < 0) {
        issues.push({ operation: 'crop', pageNumber: pageIdx + 1, message: `Page ${pageIdx + 1}: negative crop value` });
      }
    }
  }

  if (inQueue.has('resize') && ctx.resize.enabled) {
    if (!Number.isFinite(ctx.resize.width) || ctx.resize.width < 50 || ctx.resize.width > 14400) {
      issues.push({ operation: 'resize', message: `Resize width ${ctx.resize.width} out of range (50–14400 pt)` });
    }
    if (!Number.isFinite(ctx.resize.height) || ctx.resize.height < 50 || ctx.resize.height > 14400) {
      issues.push({ operation: 'resize', message: `Resize height ${ctx.resize.height} out of range (50–14400 pt)` });
    }
  }

  if (inQueue.has('compress') && ctx.compress.enabled) {
    if (ctx.compress.quality < 1 || ctx.compress.quality > 100) {
      issues.push({ operation: 'compress', message: `Compression quality ${ctx.compress.quality} out of range (1–100)` });
    }
  }

  return issues;
}

/* ── Ambiguity detection ───────────────────────── */

export interface QueueAmbiguity {
  /** id of the step whose row should show the note */
  stepId: string;
  /** the other step involved in the ambiguity */
  otherStepId: string;
  message: string;
  swapHint: string;
}

const VECTOR_OPS: QueueStepType[] = ['annotations', 'watermark', 'pageNumbers', 'redact', 'crop', 'metadata', 'rotate'];

export interface AmbiguityEnabledFlags {
  pageNumbers: boolean;
  watermark: boolean;
  compress: boolean;
}

export function detectQueueAmbiguities(
  queue: QueueItem[],
  enabled: AmbiguityEnabledFlags = { pageNumbers: true, watermark: true, compress: true },
): QueueAmbiguity[] {
  const out: QueueAmbiguity[] = [];
  const indexOf = (t: QueueStepType) => queue.findIndex(q => q.type === t);

  const split = indexOf('split');
  if (split >= 0) {
    for (const before of ['pageNumbers', 'watermark', 'compress'] as const) {
      // Skip ops that are queued but currently disabled — they won't actually run,
      // so warning the user about their order would be a false alarm.
      if (!enabled[before]) continue;
      const i = indexOf(before);
      if (i < 0) continue;
      const later = i > split ? queue[i] : queue[split];
      const other = i > split ? queue[split] : queue[i];
      const labelMap: Record<string, string> = {
        pageNumbers: 'page numbers', watermark: 'watermark', compress: 'compression',
      };
      const isBeforeSplit = i < split;
      out.push({
        stepId: later.id,
        otherStepId: other.id,
        message: isBeforeSplit
          ? `${labelMap[before]} runs BEFORE split: applied across the whole document, then split.`
          : `${labelMap[before]} runs AFTER split: applied to each split file independently.`,
        swapHint: 'Drag to swap order',
      });
    }
  }
  return out;
}

/* ── Output assertion ──────────────────────────── */

export async function assertSinglePdfPageCount(blob: Blob, expectedPageCount: number): Promise<void> {
  const buf = await blob.arrayBuffer();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  } catch (e) {
    throw new PdfOpError('output', `Output PDF could not be parsed: ${(e as Error)?.message}`, { recoverable: false, cause: e });
  }
  const got = doc.getPageCount();
  if (got === 0) {
    throw new PdfOpError('output', 'Output PDF is empty (0 pages)', { recoverable: false });
  }
  if (got !== expectedPageCount) {
    throw new PdfOpError('output', `Output page count mismatch: expected ${expectedPageCount}, got ${got}`, { recoverable: false });
  }
}

export async function assertNonEmpty(blob: Blob): Promise<void> {
  if (blob.size === 0) {
    throw new PdfOpError('output', 'Output file is empty (0 bytes)', { recoverable: false });
  }
  const buf = await blob.arrayBuffer();
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    if (doc.getPageCount() === 0) {
      throw new PdfOpError('output', 'Output PDF has no pages', { recoverable: false });
    }
  } catch (e) {
    if (e instanceof PdfOpError) throw e;
    throw new PdfOpError('output', `Output PDF could not be parsed: ${(e as Error)?.message}`, { recoverable: false, cause: e });
  }
}

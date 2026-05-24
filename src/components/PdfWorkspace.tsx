import { type ReactNode, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import * as pdfjsLib from 'pdfjs-dist';
import JSZip from 'jszip';
import {
  FileDown, FileText, Trash2, Zap, Loader2, Plus, RotateCcw, X,
  Scissors, RotateCw, Hash, Droplets, EyeOff, Crop, Image, Camera,
  Layers, ArrowDown, RotateCcw as RotateCcwIcon, ChevronRight, FileType,
  FileEdit, Type, Highlighter, Stamp, PenTool, Undo2, Redo2, Maximize,
  Menu as MenuIcon, Play, Clock, Check, GripVertical, AlertTriangle,
} from 'lucide-react';
import AnnotationOverlay, { type Annotation, type AnnotationType } from './AnnotationOverlay';
import PageThumbnail, { type ThumbnailOverlays } from './PageThumbnail';
import RedactOverlay from './RedactOverlay';
import CropOverlay from './CropOverlay';
import type { CropValues } from '../lib/pdf-utils';
import {
  type PageItem, type SourceFile, type RedactRect, type BuildOptions,
  formatBytes, buildFinalPdf, parseSplitRanges, splitPdf, imagesToPdf, compressPdf, convertToPageSize, blobToPipeline, PAGE_SIZES,
  PdfOpError,
} from '../lib/pdf-utils';
import { useHistory } from '../lib/useHistory';
import { preflightQueue, detectQueueAmbiguities, assertNonEmpty, assertSinglePdfPageCount, type PreflightIssue, type QueueAmbiguity, type AmbiguityEnabledFlags } from '../lib/queue-runner';

if (typeof window !== 'undefined') { pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`; }

/* ── Tool definitions ──────────────────────────── */

type ToolType = 'organize' | 'split' | 'compress' | 'rotate' | 'pageNumbers' | 'watermark' | 'redact' | 'crop' | 'resize' | 'imageToPdf' | 'pdfToImage' | 'metadata' | 'annotate' | 'highlight' | 'stamp' | 'signature';

const TOOLS: { id: ToolType; label: string; desc: string; icon: React.ElementType; group: string }[] = [
  { id: 'organize', label: 'Organize', desc: 'Merge & reorder', icon: Layers, group: 'Edit' },
  { id: 'split', label: 'Split PDF', desc: 'Extract ranges', icon: Scissors, group: 'Edit' },
  { id: 'rotate', label: 'Rotate', desc: 'Rotate pages', icon: RotateCw, group: 'Edit' },
  { id: 'compress', label: 'Compress', desc: 'Reduce size', icon: Zap, group: 'Enhance' },
  { id: 'pageNumbers', label: 'Page Numbers', desc: 'Add numbering', icon: Hash, group: 'Enhance' },
  { id: 'watermark', label: 'Watermark', desc: 'Text overlay', icon: Droplets, group: 'Enhance' },
  { id: 'redact', label: 'Black-out', desc: 'Visual cover only. Does NOT remove underlying text', icon: EyeOff, group: 'Modify' },
  { id: 'crop', label: 'Crop', desc: 'Trim margins', icon: Crop, group: 'Modify' },
  { id: 'annotate', label: 'Text', desc: 'Add text', icon: Type, group: 'Annotate' },
  { id: 'highlight', label: 'Highlight', desc: 'Mark areas', icon: Highlighter, group: 'Annotate' },
  { id: 'stamp', label: 'Image Stamp', desc: 'Place images', icon: Stamp, group: 'Annotate' },
  { id: 'signature', label: 'Signature', desc: 'Sign pages', icon: PenTool, group: 'Annotate' },
  { id: 'resize', label: 'Resize Pages', desc: 'A4, Letter, custom', icon: Maximize, group: 'Convert' },
  { id: 'imageToPdf', label: 'Image → PDF', desc: 'Convert images', icon: Image, group: 'Convert' },
  { id: 'pdfToImage', label: 'PDF → Image', desc: 'Export as images', icon: Camera, group: 'Convert' },
  { id: 'metadata', label: 'Metadata', desc: 'Edit PDF info', icon: FileEdit, group: 'Enhance' },
];

interface ImageFile {
  id: string;
  file: File;
  url: string;
  data: Uint8Array;
  type: 'png' | 'jpg';
}

/* ── Edit Queue Types ──────────────────────────── */
type QueueStepType = 'organize' | 'rotate' | 'pageNumbers' | 'watermark' | 'redact' | 'crop' | 'resize' | 'compress' | 'metadata' | 'annotations' | 'split';

interface QueueItem {
  id: string;
  type: QueueStepType;
}

const STEP_META: Record<QueueStepType, { label: string; icon: React.ElementType; tintVar: string }> = {
  organize: { label: 'Organize', icon: Layers, tintVar: 'var(--tint-warm-gray)' },
  rotate: { label: 'Rotate', icon: RotateCw, tintVar: 'var(--tint-warm-gray)' },
  pageNumbers: { label: 'Page numbers', icon: Hash, tintVar: 'var(--tint-butter)' },
  watermark: { label: 'Watermark', icon: Droplets, tintVar: 'var(--tint-mint)' },
  redact: { label: 'Black-out', icon: EyeOff, tintVar: 'var(--tint-warm-gray)' },
  crop: { label: 'Crop', icon: Crop, tintVar: 'var(--tint-warm-gray)' },
  resize: { label: 'Resize', icon: Maximize, tintVar: 'var(--tint-cream)' },
  compress: { label: 'Compress', icon: Zap, tintVar: 'var(--tint-cream)' },
  metadata: { label: 'Metadata', icon: FileEdit, tintVar: 'var(--tint-lavender)' },
  annotations: { label: 'Annotations', icon: Type, tintVar: 'var(--tint-blush)' },
  split: { label: 'Split', icon: Scissors, tintVar: 'var(--tint-cream)' },
};

const STEP_TO_TOOL: Record<QueueStepType, ToolType> = {
  organize: 'organize', rotate: 'rotate', pageNumbers: 'pageNumbers',
  watermark: 'watermark', redact: 'redact', crop: 'crop', resize: 'resize',
  compress: 'compress', metadata: 'metadata', annotations: 'annotate', split: 'split',
};

/* ── Tooltip ───────────────────────────────────── */
const ToolbarTooltip = ({ content, children }: { content: string; children: ReactNode }) => (
  <span className="relative inline-flex items-center justify-center group">
    {children}
    <span className="absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 -translate-y-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all duration-75 whitespace-nowrap py-1 px-2 rounded-md bg-accent text-foreground text-[11px] font-medium leading-tight z-10 border border-border">
      {content}
    </span>
  </span>
);

/* ── Processing Overlay ────────────────────────── */
interface ProcessingState {
  steps: { type: QueueStepType; label: string; status: 'pending' | 'active' | 'done' | 'error' | 'skipped'; error?: string }[];
  failedIndex: number | null;
}

const ProcessingOverlay = ({ state, onRetry, onCancel }: {
  state: ProcessingState;
  onRetry: () => void;
  onCancel: () => void;
}) => {
  const allDone = state.steps.every(s => s.status === 'done');
  const hasError = state.failedIndex !== null;

  return (
    <div className="fixed inset-0 bg-black/60 z-[999] flex items-center justify-center p-4">
      <div className="bg-background border border-border rounded-lg p-6 max-w-sm w-full">
        <h3 className="text-foreground font-semibold text-base mb-4">
          {hasError ? 'Processing failed' : allDone ? 'Complete!' : 'Processing your PDF...'}
        </h3>
        <div className="flex flex-col gap-2.5">
          {state.steps.map((step, idx) => {
            const Icon = STEP_META[step.type].icon;
            return (
              <div key={idx} className="flex items-center gap-2.5">
                {step.status === 'done' && (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <Check size={12} className="text-primary-foreground" />
                  </div>
                )}
                {step.status === 'active' && <Loader2 size={18} className="animate-spin text-primary shrink-0" />}
                {step.status === 'pending' && <div className="w-5 h-5 rounded-full border-2 border-border shrink-0" />}
                {step.status === 'error' && (
                  <div className="w-5 h-5 rounded-full bg-destructive flex items-center justify-center shrink-0">
                    <X size={12} className="text-destructive-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <span className={cn(
                    "text-sm",
                    step.status === 'active' && "text-foreground font-medium",
                    step.status === 'done' && "text-muted-foreground",
                    step.status === 'pending' && "text-muted-foreground/60",
                    step.status === 'error' && "text-destructive font-medium",
                  )}>
                    {step.status === 'active' ? `Applying ${step.label}...` : step.label}
                  </span>
                  {step.status === 'error' && step.error && (
                    <p className="text-destructive text-xs mt-0.5">{step.error}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {hasError && (
          <div className="flex gap-2 mt-5">
            <Button variant="secondary" size="compact" onClick={onCancel}>Cancel</Button>
            <Button variant="positive" size="compact" onClick={onRetry}>
              Retry from {state.steps[state.failedIndex!]?.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Component ─────────────────────────────────── */

interface EditorSnapshot {
  pages: PageItem[];
  annotationsMap: Map<number, Annotation[]>;
  redactions: Map<number, RedactRect[]>;
  cropMap: Map<number, CropValues>;
  splitGroups: string[][];
  editQueue: QueueItem[];
  // Page numbers
  pnEnabled: boolean;
  pnPosition: string;
  pnFontSize: number;
  pnStart: string;
  // Watermark
  wmEnabled: boolean;
  wmText: string;
  wmTextByPage: Map<number, string>;
  wmOpacity: number;
  wmFontSize: number;
  wmAngle: number;
  wmPages: Set<number>;
  // Resize
  resizeEnabled: boolean;
  resizePreset: number;
  customW: string;
  customH: string;
  // Compress
  compressEnabled: boolean;
  quality: number;
  // Metadata
  metaTitle: string;
  metaAuthor: string;
  metaSubject: string;
  metaKeywords: string;
}

const emptySnapshot = (): EditorSnapshot => ({
  pages: [],
  annotationsMap: new Map(),
  redactions: new Map(),
  cropMap: new Map(),
  splitGroups: [[]],
  editQueue: [],
  pnEnabled: false, pnPosition: 'bottom-center', pnFontSize: 12, pnStart: '1',
  wmEnabled: false, wmText: '', wmTextByPage: new Map(), wmOpacity: 30, wmFontSize: 48, wmAngle: -45, wmPages: new Set(),
  resizeEnabled: false, resizePreset: 0, customW: '612', customH: '792',
  compressEnabled: false, quality: 70,
  metaTitle: '', metaAuthor: '', metaSubject: '', metaKeywords: '',
});

const PdfWorkspace = () => {
  // Core state — the ORIGINAL file is never modified
  const [sources, setSources] = useState<Map<string, SourceFile>>(new Map());

  // ── Unified editor history (single Cmd+Z stack) ──
  // Per-field shallow equality. Every field is either a primitive, a clone-on-write
  // Map/Set, or a clone-on-write array. Reference equality is correct AND cheap.
  // We never recurse into Maps/Sets/Uint8Arrays.
  const snapshotEquals = useCallback((a: EditorSnapshot, b: EditorSnapshot) =>
    a.pages === b.pages
    && a.annotationsMap === b.annotationsMap
    && a.redactions === b.redactions
    && a.cropMap === b.cropMap
    && a.splitGroups === b.splitGroups
    && a.editQueue === b.editQueue
    && a.pnEnabled === b.pnEnabled && a.pnPosition === b.pnPosition && a.pnFontSize === b.pnFontSize && a.pnStart === b.pnStart
    && a.wmEnabled === b.wmEnabled && a.wmText === b.wmText && a.wmTextByPage === b.wmTextByPage
    && a.wmOpacity === b.wmOpacity && a.wmFontSize === b.wmFontSize && a.wmAngle === b.wmAngle && a.wmPages === b.wmPages
    && a.resizeEnabled === b.resizeEnabled && a.resizePreset === b.resizePreset && a.customW === b.customW && a.customH === b.customH
    && a.compressEnabled === b.compressEnabled && a.quality === b.quality
    && a.metaTitle === b.metaTitle && a.metaAuthor === b.metaAuthor && a.metaSubject === b.metaSubject && a.metaKeywords === b.metaKeywords
  , []);
  const editorHistory = useHistory<EditorSnapshot>(emptySnapshot(), 30, snapshotEquals);
  const editor = editorHistory.current;
  const pages = editor.pages;
  const annotationsMap = editor.annotationsMap;
  const redactions = editor.redactions;
  const cropMap = editor.cropMap;
  const splitGroups = editor.splitGroups;
  const editQueue = editor.editQueue;
  const pnEnabled = editor.pnEnabled, pnPosition = editor.pnPosition, pnFontSize = editor.pnFontSize, pnStart = editor.pnStart;
  const wmEnabled = editor.wmEnabled, wmText = editor.wmText, wmTextByPage = editor.wmTextByPage;
  const wmOpacity = editor.wmOpacity, wmFontSize = editor.wmFontSize, wmAngle = editor.wmAngle, wmPages = editor.wmPages;
  const resizeEnabled = editor.resizeEnabled, resizePreset = editor.resizePreset, customW = editor.customW, customH = editor.customH;
  const compressEnabled = editor.compressEnabled, quality = editor.quality;
  const metaTitle = editor.metaTitle, metaAuthor = editor.metaAuthor, metaSubject = editor.metaSubject, metaKeywords = editor.metaKeywords;

  // Generic field setter factory. Returns a setter that pushes ONE history entry per call.
  // Maps/Sets must be replaced with NEW instances by callers — never mutated in place.
  type FieldSetter<K extends keyof EditorSnapshot> = (val: EditorSnapshot[K] | ((p: EditorSnapshot[K]) => EditorSnapshot[K])) => void;
  const makeSet = useCallback(<K extends keyof EditorSnapshot>(key: K): FieldSetter<K> =>
    (val) => {
      editorHistory.set(prev => ({
        ...prev,
        [key]: typeof val === 'function' ? (val as (p: EditorSnapshot[K]) => EditorSnapshot[K])(prev[key]) : val,
      }));
    }, [editorHistory]);
  // Non-history version — for incidental sync (mount effects, derived auto-adds).
  const makeUpdate = useCallback(<K extends keyof EditorSnapshot>(key: K): FieldSetter<K> =>
    (val) => {
      editorHistory.update(prev => ({
        ...prev,
        [key]: typeof val === 'function' ? (val as (p: EditorSnapshot[K]) => EditorSnapshot[K])(prev[key]) : val,
      }));
    }, [editorHistory]);

  // Setters — every Map/Set setter must clone-on-write at the call site; never mutate.
  const setPages = useMemo(() => makeSet('pages'), [makeSet]);
  const setAnnotationsMap = useMemo(() => makeSet('annotationsMap'), [makeSet]);
  const setRedactions = useMemo(() => makeSet('redactions'), [makeSet]);
  const setCropMap = useMemo(() => makeSet('cropMap'), [makeSet]);
  const setSplitGroups = useMemo(() => makeSet('splitGroups'), [makeSet]);
  const setEditQueue = useMemo(() => makeSet('editQueue'), [makeSet]);
  const updateEditQueue = useMemo(() => makeUpdate('editQueue'), [makeUpdate]);
  const setPnEnabled = useMemo(() => makeSet('pnEnabled'), [makeSet]);
  const setPnPosition = useMemo(() => makeSet('pnPosition'), [makeSet]);
  const setPnFontSize = useMemo(() => makeSet('pnFontSize'), [makeSet]);
  const setPnStart = useMemo(() => makeSet('pnStart'), [makeSet]);
  const setWmEnabled = useMemo(() => makeSet('wmEnabled'), [makeSet]);
  const setWmText = useMemo(() => makeSet('wmText'), [makeSet]);
  const setWmTextByPage = useMemo(() => makeSet('wmTextByPage'), [makeSet]);
  const setWmOpacity = useMemo(() => makeSet('wmOpacity'), [makeSet]);
  const setWmFontSize = useMemo(() => makeSet('wmFontSize'), [makeSet]);
  const setWmAngle = useMemo(() => makeSet('wmAngle'), [makeSet]);
  const setWmPages = useMemo(() => makeSet('wmPages'), [makeSet]);
  const setResizeEnabled = useMemo(() => makeSet('resizeEnabled'), [makeSet]);
  const setResizePreset = useMemo(() => makeSet('resizePreset'), [makeSet]);
  const setCustomW = useMemo(() => makeSet('customW'), [makeSet]);
  const setCustomH = useMemo(() => makeSet('customH'), [makeSet]);
  const setCompressEnabled = useMemo(() => makeSet('compressEnabled'), [makeSet]);
  const setQuality = useMemo(() => makeSet('quality'), [makeSet]);
  const setMetaTitle = useMemo(() => makeSet('metaTitle'), [makeSet]);
  const setMetaAuthor = useMemo(() => makeSet('metaAuthor'), [makeSet]);
  const setMetaSubject = useMemo(() => makeSet('metaSubject'), [makeSet]);
  const setMetaKeywords = useMemo(() => makeSet('metaKeywords'), [makeSet]);

  // ── Coalescing helpers ──
  // One undo entry per continuous slider drag or text-input editing session.
  // Begin on first onValueChange / focus, end on onValueCommit / blur.
  const coalescingRef = useRef(false);
  const beginCoalesceOnce = useCallback(() => {
    if (!coalescingRef.current) {
      coalescingRef.current = true;
      editorHistory.beginCoalesce();
    }
  }, [editorHistory]);
  const endCoalesce = useCallback(() => {
    if (coalescingRef.current) {
      coalescingRef.current = false;
      editorHistory.endCoalesce();
    }
  }, [editorHistory]);
  // Wraps a slider's onValueChange so it begins coalescing on first call of the drag.
  const slideChange = useCallback(<V,>(handler: (v: V) => void) => (v: V) => {
    beginCoalesceOnce();
    handler(v);
  }, [beginCoalesceOnce]);


  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [activeTool, setActiveTool] = useState<ToolType>('organize');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // ── Edit Queue UI state ──
  const [activeSplitGroup, setActiveSplitGroup] = useState(0);
  const [processingState, setProcessingState] = useState<ProcessingState | null>(null);
  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[] | null>(null);
  const [compressWarning, setCompressWarning] = useState<{ pendingRun: () => void } | null>(null);

  // Queue drag state
  const [dragQueueIdx, setDragQueueIdx] = useState<number | null>(null);
  const [dragOverQueueIdx, setDragOverQueueIdx] = useState<number | null>(null);

  // Drag (page cards)
  const [dragPageIdx, setDragPageIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Processing
  const [processing, setProcessing] = useState(false);

  // Compress preview (UI-only, not history)
  const [compressedSize, setCompressedSize] = useState(0);
  const [compressedBlob, setCompressedBlob] = useState<Blob | null>(null);

  // Split groups (page IDs) — splitGroups & activeSplitGroup live in editorHistory; keep palette here

  const SPLIT_GROUPS = [
    { color: 'hsl(var(--split-group-blue))', tint: 'hsl(var(--split-group-blue) / 0.14)' },
    { color: 'hsl(var(--split-group-red))', tint: 'hsl(var(--split-group-red) / 0.14)' },
    { color: 'hsl(var(--split-group-green))', tint: 'hsl(var(--split-group-green) / 0.14)' },
    { color: 'hsl(var(--split-group-purple))', tint: 'hsl(var(--split-group-purple) / 0.14)' },
    { color: 'hsl(var(--split-group-orange))', tint: 'hsl(var(--split-group-orange) / 0.14)' },
  ];
  const getSplitGroupColor = useCallback((gi: number) => SPLIT_GROUPS[gi % SPLIT_GROUPS.length].color, [SPLIT_GROUPS]);
  const getSplitGroupTint = useCallback((gi: number) => SPLIT_GROUPS[gi % SPLIT_GROUPS.length].tint, [SPLIT_GROUPS]);
  const getSplitGroupIndices = useCallback((pageId: string) => splitGroups.reduce<number[]>((acc, group, gi) => { if (group.includes(pageId)) acc.push(gi); return acc; }, []), [splitGroups]);
  const formatPageRangeList = useCallback((group: string[]) => {
    if (group.length === 0) return '';
    // Resolve page IDs to current indices
    const indices = group.map(id => pages.findIndex(p => p.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
    if (indices.length === 0) return '';
    const ranges: string[] = [];
    let start = indices[0], end = indices[0];
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && indices[i] === end + 1) { end = indices[i]; }
      else { ranges.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`); if (i < indices.length) { start = indices[i]; end = indices[i]; } }
    }
    return ranges.join(', ');
  }, [pages]);
  const getSplitCardShadow = useCallback((groupIndices: number[], baseShadow: string) => {
    if (groupIndices.length === 0) return baseShadow;
    const rings = groupIndices.slice(0, 4).map((gi, ri) => `0 0 0 ${ri * 3 + 2}px ${getSplitGroupColor(gi)}`);
    return [...rings, baseShadow].join(', ');
  }, [getSplitGroupColor]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Split (text input — not history-tracked)
  const [splitRanges, setSplitRanges] = useState('');

  // Watermark draft mirror (incidental UI state — not history-tracked)
  const [wmDraft, setWmDraft] = useState('CONFIDENTIAL');

  // Redact / Crop overlay UI
  const [redactPageIdx, setRedactPageIdx] = useState<number | null>(null);
  const [cropPageIdx, setCropPageIdx] = useState<number | null>(null);
  const cropEnabled = cropMap.size > 0;

  // Image→PDF
  const [uploadedImages, setUploadedImages] = useState<ImageFile[]>([]);

  // PDF→Image
  const [exportFormat, setExportFormat] = useState<'png' | 'jpg'>('png');


  // Annotations
  // Annotations — annotationsMap lives in editorHistory
  const [annotatePageIdx, setAnnotatePageIdx] = useState<number | null>(null);
  const [annotateMode, setAnnotateMode] = useState<AnnotationType>('text');
  const totalAnnotations = Array.from(annotationsMap.values()).reduce((s, a) => s + a.length, 0);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const overlayCloseGuard = useRef(false);

  // No longer compute totalOriginalSize from all sources — use compressedBlob comparison only
  const hasPdfPages = pages.length > 0;
  const hasMetadata = !!(metaTitle || metaAuthor || metaSubject || metaKeywords);

  /* ── Edit Queue Management ──────────────────────
     The user's queue order is the source of truth. We never silently move steps. */
  const addToQueueIncidental = useCallback((type: QueueStepType) => {
    // Auto-adds from useEffect: never push history entries the user didn't make.
    updateEditQueue(prev => {
      if (prev.some(item => item.type === type)) return prev;
      const newItem: QueueItem = { id: crypto.randomUUID(), type };
      return [...prev, newItem];
    });
  }, [updateEditQueue]);
  // Kept for explicit user-initiated adds (currently unused, retained for future use)
  const addToQueue = addToQueueIncidental;

  const removeFromQueue = useCallback((type: QueueStepType) => {
    // Coalesce the queue removal + corresponding setting clears into ONE history entry.
    editorHistory.beginCoalesce();
    try {
      editorHistory.set(prev => {
        const next: EditorSnapshot = { ...prev, editQueue: prev.editQueue.filter(item => item.type !== type) };
        switch (type) {
          case 'rotate': next.pages = prev.pages.map(p => ({ ...p, rotation: 0 })); break;
          case 'pageNumbers': next.pnEnabled = false; break;
          case 'watermark': next.wmEnabled = false; next.wmText = ''; next.wmTextByPage = new Map(); break;
          case 'redact': next.redactions = new Map(); break;
          case 'crop': next.cropMap = new Map(); break;
          case 'resize': next.resizeEnabled = false; break;
          case 'compress': next.compressEnabled = false; break;
          case 'metadata': next.metaTitle = ''; next.metaAuthor = ''; next.metaSubject = ''; next.metaKeywords = ''; break;
          case 'annotations': next.annotationsMap = new Map(); break;
          case 'split': next.splitGroups = [[]]; break;
        }
        return next;
      });
    } finally {
      editorHistory.endCoalesce();
    }
    if (type === 'split') setActiveSplitGroup(0);
  }, [editorHistory]);

  const reorderQueue = useCallback((fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    setEditQueue(prev => {
      const newQueue = [...prev];
      const [item] = newQueue.splice(fromIdx, 1);
      newQueue.splice(toIdx, 0, item);
      // The user's chosen order is honored. Ambiguities are surfaced inline,
      // not silently corrected.
      return newQueue;
    });
  }, [setEditQueue]);


  /* ── Auto-add to queue when settings become active ── */
  useEffect(() => {
    if (hasPdfPages) addToQueue('organize');
  }, [hasPdfPages]);

  useEffect(() => {
    if (pages.some(p => p.rotation !== 0)) addToQueue('rotate');
  }, [pages]);

  useEffect(() => {
    if (pnEnabled) addToQueue('pageNumbers');
  }, [pnEnabled]);

  useEffect(() => {
    if (wmEnabled) addToQueue('watermark');
  }, [wmEnabled]);

  useEffect(() => {
    if (redactions.size > 0) addToQueue('redact');
  }, [redactions.size]);

  useEffect(() => {
    if (cropEnabled) addToQueue('crop');
  }, [cropEnabled]);

  useEffect(() => {
    if (resizeEnabled) addToQueue('resize');
  }, [resizeEnabled]);

  useEffect(() => {
    if (compressEnabled) addToQueue('compress');
  }, [compressEnabled]);

  useEffect(() => {
    if (hasMetadata) addToQueue('metadata');
  }, [hasMetadata]);

  useEffect(() => {
    if (totalAnnotations > 0) addToQueue('annotations');
  }, [totalAnnotations]);

  useEffect(() => {
    const nonEmpty = splitGroups.some(g => g.length > 0);
    if (nonEmpty) addToQueue('split');
  }, [splitGroups]);

  // Auto-compress preview
  useEffect(() => {
    if (activeTool !== 'compress' || pages.length === 0) { setCompressedBlob(null); setCompressedSize(0); return; }
    setProcessing(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const blob = await compressPdf(pages, sources, quality);
        setCompressedBlob(blob); setCompressedSize(blob.size);
      } catch { setCompressedBlob(null); setCompressedSize(0); }
      finally { setProcessing(false); }
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [pages, sources, quality, activeTool]);

  const getBuildOptions = useCallback((): BuildOptions => {
    // Only include options for steps that are in the queue
    const inQueue = new Set(editQueue.map(i => i.type));
    return {
      quality,
      pageNumbers: inQueue.has('pageNumbers') ? { enabled: pnEnabled, position: pnPosition, fontSize: pnFontSize, startNumber: parseInt(pnStart) || 1 } : { enabled: false, position: 'bottom-center', fontSize: 12, startNumber: 1 },
      watermark: inQueue.has('watermark') ? { enabled: wmEnabled, text: wmText, opacity: wmOpacity, fontSize: wmFontSize, angle: wmAngle, pages: wmPages.size > 0 ? wmPages : undefined, textByPage: wmTextByPage.size > 0 ? wmTextByPage : undefined } : { enabled: false, text: '', opacity: 30, fontSize: 48, angle: -45 },
      redactions: inQueue.has('redact') ? redactions : new Map(),
      crops: inQueue.has('crop') ? cropMap : new Map(),
      metadata: inQueue.has('metadata') && hasMetadata ? { title: metaTitle, author: metaAuthor, subject: metaSubject, keywords: metaKeywords } : undefined,
      annotations: inQueue.has('annotations') ? annotationsMap : new Map(),
    };
  }, [editQueue, quality, pnEnabled, pnPosition, pnFontSize, pnStart, wmEnabled, wmText, wmTextByPage, wmOpacity, wmFontSize, wmAngle, wmPages, redactions, cropMap, metaTitle, metaAuthor, metaSubject, metaKeywords, hasMetadata, annotationsMap]);

  /* ── File handlers ────────────────────────────── */
  const addFiles = useCallback(async (newFiles: File[]) => {
    const newSources = new Map(sources);
    const newPages: PageItem[] = [];
    for (const f of newFiles) {
      if (f.type !== 'application/pdf') continue;
      const buffer = await f.arrayBuffer();
      let pageCount = 0;
      try { const doc = await (await import('pdf-lib')).PDFDocument.load(buffer, { ignoreEncryption: true }); pageCount = doc.getPageCount(); } catch { continue; }
      const fileId = crypto.randomUUID();
      newSources.set(fileId, { id: fileId, name: f.name, buffer, pageCount, size: f.size });
      for (let i = 0; i < pageCount; i++) newPages.push({ id: crypto.randomUUID(), sourceFileId: fileId, sourcePageIndex: i, rotation: 0 });
    }
    setSources(newSources);
    setPages(prev => [...prev, ...newPages]);
  }, [sources]);

  const addImages = useCallback(async (files: File[]) => {
    const newImages: ImageFile[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const data = new Uint8Array(await f.arrayBuffer());
      const type = f.type.includes('png') ? 'png' as const : 'jpg' as const;
      newImages.push({ id: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), data, type });
    }
    setUploadedImages(prev => [...prev, ...newImages]);
  }, []);

  /* ── Page handlers ────────────────────────────── */
  const removePage = (id: string) => { setPages(prev => prev.filter(p => p.id !== id)); setSelectedPageIds(prev => { const n = new Set(prev); n.delete(id); return n; }); };
  const removeSelected = () => { setPages(prev => prev.filter(p => !selectedPageIds.has(p.id))); setSelectedPageIds(new Set()); };
  const toggleSelect = (id: string) => { setSelectedPageIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const selectAll = () => { setSelectedPageIds(selectedPageIds.size === pages.length ? new Set() : new Set(pages.map(p => p.id))); };
  const movePage = (from: number, to: number) => {
    if (from === to) return;
    if (selectedPageIds.size > 1 && selectedPageIds.has(pages[from]?.id)) {
      setPages(prev => {
        const selectedItems = prev.filter(p => selectedPageIds.has(p.id));
        const remaining = prev.filter(p => !selectedPageIds.has(p.id));
        const targetPage = prev[to];
        let insertIdx = remaining.findIndex(p => p.id === targetPage?.id);
        if (insertIdx < 0) insertIdx = remaining.length;
        if (to > from) insertIdx++;
        remaining.splice(insertIdx, 0, ...selectedItems);
        return remaining;
      });
    } else {
      setPages(prev => { const n = [...prev]; const [item] = n.splice(from, 1); n.splice(to, 0, item); return n; });
    }
  };
  const rotatePage = (id: string, deg: number) => { setPages(prev => prev.map(p => p.id === id ? { ...p, rotation: (p.rotation + deg + 360) % 360 } : p)); };
  const rotateSelected = (deg: number) => {
    const ids = selectedPageIds.size > 0 ? selectedPageIds : new Set(pages.map(p => p.id));
    setPages(prev => prev.map(p => ids.has(p.id) ? { ...p, rotation: (p.rotation + deg + 360) % 360 } : p));
  };

  const handleReset = () => {
    setSources(new Map());
    setSelectedPageIds(new Set());
    setCompressedBlob(null); setCompressedSize(0);
    setUploadedImages([]);
    setActiveSplitGroup(0);
    // One history entry for the entire reset.
    editorHistory.set(() => emptySnapshot());
  };

  /* ── Save helper ─────────────────────────────── */
  const saveBlob = async (blob: Blob, defaultName: string, mimeType = 'application/pdf', ext = 'pdf') => {
    // Prefer the File System Access API so users can pick folder + filename
    const anyWin = window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;
    };
    // showSaveFilePicker is unavailable in cross-origin iframes (e.g. Lovable preview).
    // Detect that case and skip straight to the prompt-based fallback so the
    // user can still choose a filename.
    const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
    if (typeof anyWin.showSaveFilePicker === 'function' && !inIframe) {
      try {
        const handle = await anyWin.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{
            description: ext.toUpperCase() + ' file',
            accept: { [mimeType]: [`.${ext}`] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // Other errors fall through to the prompt fallback below.
      }
    }
    // Fallback: ask the user for a filename, then trigger an anchor download.
    // (Folder selection isn't possible without the File System Access API; the
    // browser's default download folder will be used.)
    const userName = window.prompt('Save as (filename):', defaultName);
    if (userName === null) return; // user cancelled
    let finalName = userName.trim() || defaultName;
    if (!finalName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      finalName += `.${ext}`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* ── Sequential Download Processor ───────────── */
  const handleDownload = async (retryFrom = 0) => {
    // Build the processing steps from the edit queue (excluding organize which is implicit)
    const queueSteps = editQueue.filter(item => item.type !== 'organize');

    // Preflight: validate everything before processing starts.
    if (retryFrom === 0) {
      const issues = preflightQueue(editQueue, {
        pages, annotationsMap, redactions, cropMap, splitGroups,
        pn: { enabled: pnEnabled, fontSize: pnFontSize, startNumber: parseInt(pnStart) || 1 },
        wm: { enabled: wmEnabled, text: wmText, textByPage: wmTextByPage, fontSize: wmFontSize },
        resize: {
          enabled: resizeEnabled,
          width: resizePreset >= 0 ? PAGE_SIZES[resizePreset].width : parseFloat(customW) || 612,
          height: resizePreset >= 0 ? PAGE_SIZES[resizePreset].height : parseFloat(customH) || 792,
        },
        compress: { enabled: compressEnabled, quality },
      });
      if (issues.length > 0) {
        setPreflightIssues(issues);
        return;
      }

      // Compress-with-vector-ops safety warning (low quality only).
      const hasCompress = editQueue.some(q => q.type === 'compress');
      const hasVectorAfterCompress = (() => {
        const ci = editQueue.findIndex(q => q.type === 'compress');
        if (ci < 0) return false;
        const vector: QueueStepType[] = ['annotations', 'watermark', 'pageNumbers', 'redact'];
        return editQueue.slice(0, ci).some(q => vector.includes(q.type));
      })();
      if (hasCompress && hasVectorAfterCompress && quality < 60 && !compressWarning) {
        setCompressWarning({
          pendingRun: () => { setCompressWarning(null); handleDownload(retryFrom); },
        });
        return;
      }
    }

    if (queueSteps.length === 0 && hasPdfPages) {
      // No edits queued, just download the organized PDF
      setProcessing(true);
      try {
        const blob = await buildFinalPdf(pages, sources, {
          quality: 100,
          pageNumbers: { enabled: false, position: 'bottom-center', fontSize: 12, startNumber: 1 },
          watermark: { enabled: false, text: '', opacity: 30, fontSize: 48, angle: -45 },
          redactions: new Map(), crops: new Map(), annotations: new Map(),
        });
        const defaultName = sources.size === 1 ? Array.from(sources.values())[0].name.replace('.pdf', '_edited.pdf') : 'output.pdf';
        await saveBlob(blob, defaultName);
      } catch (e) { console.error(e); }
      finally { setProcessing(false); }
      return;
    }

    // Categorize steps
    const singlePassTypes = new Set<QueueStepType>(['rotate', 'pageNumbers', 'watermark', 'redact', 'crop', 'metadata', 'annotations']);
    const singlePassSteps = queueSteps.filter(s => singlePassTypes.has(s.type));
    const postSteps = queueSteps.filter(s => !singlePassTypes.has(s.type)); // resize, compress, split

    // Build processing state
    const allDisplaySteps: ProcessingState['steps'] = [];
    if (singlePassSteps.length > 0) {
      for (const s of singlePassSteps) {
        allDisplaySteps.push({ type: s.type, label: STEP_META[s.type].label, status: 'pending' });
      }
    }
    for (const s of postSteps) {
      allDisplaySteps.push({ type: s.type, label: STEP_META[s.type].label, status: 'pending' });
    }

    // Mark steps before retryFrom as done
    for (let i = 0; i < retryFrom && i < allDisplaySteps.length; i++) {
      allDisplaySteps[i].status = 'done';
    }

    setProcessingState({ steps: allDisplaySteps, failedIndex: null });
    

    try {
      let blob: Blob | null = null;
      let stepIdx = 0;

      // Single-pass build (rotate, redact, crop, page numbers, watermark, metadata, annotations)
      if (singlePassSteps.length > 0) {
        if (retryFrom <= stepIdx + singlePassSteps.length - 1) {
          for (let i = 0; i < singlePassSteps.length; i++) {
            setProcessingState(prev => {
              if (!prev) return prev;
              const steps = [...prev.steps];
              steps[stepIdx + i] = { ...steps[stepIdx + i], status: 'active' };
              return { ...prev, steps };
            });
          }

          blob = await buildFinalPdf(pages, sources, getBuildOptions());

          for (let i = 0; i < singlePassSteps.length; i++) {
            setProcessingState(prev => {
              if (!prev) return prev;
              const steps = [...prev.steps];
              steps[stepIdx + i] = { ...steps[stepIdx + i], status: 'done' };
              return { ...prev, steps };
            });
          }
        } else {
          // Already done in a previous run — still need base blob
          blob = await buildFinalPdf(pages, sources, getBuildOptions());
        }
        stepIdx += singlePassSteps.length;
      } else {
        // No single-pass steps, build a clean PDF
        blob = await buildFinalPdf(pages, sources, {
          quality: 100,
          pageNumbers: { enabled: false, position: 'bottom-center', fontSize: 12, startNumber: 1 },
          watermark: { enabled: false, text: '', opacity: 30, fontSize: 48, angle: -45 },
          redactions: new Map(), crops: new Map(), annotations: new Map(),
        });
      }

      // Post-processing steps in queue order
      for (const step of postSteps) {
        const currentIdx = stepIdx;
        if (retryFrom > currentIdx) { stepIdx++; continue; }

        setProcessingState(prev => {
          if (!prev) return prev;
          const steps = [...prev.steps];
          steps[currentIdx] = { ...steps[currentIdx], status: 'active' };
          return { ...prev, steps };
        });

        try {
          if (step.type === 'resize') {
            const { pages: rPages, sources: rSources } = await blobToPipeline(blob!);
            const preset = PAGE_SIZES[resizePreset];
            blob = await convertToPageSize(rPages, rSources, preset ? preset.width : parseFloat(customW) || 612, preset ? preset.height : parseFloat(customH) || 792);
          } else if (step.type === 'compress') {
            const { pages: cPages, sources: cSources } = await blobToPipeline(blob!);
            blob = await compressPdf(cPages, cSources, quality);
          } else if (step.type === 'split') {
            // Split produces multiple files
            const nonEmptyGroups = splitGroups.filter(g => g.length > 0);
            if (nonEmptyGroups.length > 0) {
              // Use the current blob as the source for splitting
              const { pages: splitPages, sources: splitSources } = await blobToPipeline(blob!);
              const results: { blob: Blob; label: string }[] = [];
              for (let gi = 0; gi < nonEmptyGroups.length; gi++) {
                const group = nonEmptyGroups[gi];
                // Resolve page IDs to current page order indices, then map to splitPages indices
                const resolvedIndices = group
                  .map(id => pages.findIndex(p => p.id === id))
                  .filter(i => i >= 0)
                  .sort((a, b) => a - b);
                const groupPages = resolvedIndices.map(idx => splitPages[idx]).filter(Boolean);
                if (groupPages.length === 0) continue;
                const groupBlob = await buildFinalPdf(groupPages, splitSources, {
                  quality: 100,
                  pageNumbers: { enabled: false, position: 'bottom-center', fontSize: 12, startNumber: 1 },
                  watermark: { enabled: false, text: '', opacity: 30, fontSize: 48, angle: -45 },
                  redactions: new Map(), crops: new Map(), annotations: new Map(),
                });
                results.push({ blob: groupBlob, label: `group_${gi + 1}_pages_${resolvedIndices.map(s => s + 1).join('_')}` });
              }

              setProcessingState(prev => {
                if (!prev) return prev;
                const steps = [...prev.steps];
                steps[currentIdx] = { ...steps[currentIdx], status: 'done' };
                return { ...prev, steps };
              });

              if (results.length === 1) {
                await saveBlob(results[0].blob, `${results[0].label}.pdf`);
              } else if (results.length > 1) {
                const zip = new JSZip();
                for (const r of results) zip.file(`${r.label}.pdf`, r.blob);
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                await saveBlob(zipBlob, 'split_pages.zip', 'application/zip', 'zip');
              }
              stepIdx++;
              continue; // Skip normal download since split handles its own
            }
          }
        } catch (err) {
          console.error(`Step ${step.type} failed:`, err);
          setProcessingState(prev => {
            if (!prev) return prev;
            const steps = [...prev.steps];
            steps[currentIdx] = { ...steps[currentIdx], status: 'error', error: String(err) };
            return { ...prev, steps, failedIndex: currentIdx };
          });
          return; // Stop processing, let user retry
        }

        setProcessingState(prev => {
          if (!prev) return prev;
          const steps = [...prev.steps];
          steps[currentIdx] = { ...steps[currentIdx], status: 'done' };
          return { ...prev, steps };
        });
        stepIdx++;
      }

      // Download final blob (unless split already handled it)
      const hasSplit = postSteps.some(s => s.type === 'split');
      if (!hasSplit && blob) {
        const defaultName = sources.size === 1 ? Array.from(sources.values())[0].name.replace('.pdf', '_edited.pdf') : 'output.pdf';
        await saveBlob(blob, defaultName);
      }

      // Brief pause to show completion, then close overlay
      await new Promise(r => setTimeout(r, 600));
      setProcessingState(null);
    } catch (e) {
      console.error('Download pipeline failed:', e);
      // Find the first non-done step and mark it as error
      setProcessingState(prev => {
        if (!prev) return prev;
        const failIdx = prev.steps.findIndex(s => s.status === 'active' || s.status === 'pending');
        if (failIdx < 0) return { ...prev, failedIndex: 0 };
        const steps = [...prev.steps];
        steps[failIdx] = { ...steps[failIdx], status: 'error', error: String(e) };
        return { ...prev, steps, failedIndex: failIdx };
      });
    }
  };

  const handleRetryFromFailed = () => {
    if (!processingState || processingState.failedIndex === null) return;
    handleDownload(processingState.failedIndex);
  };

  const handleSkipFailed = () => {
    if (!processingState || processingState.failedIndex === null) return;
    const failed = processingState.failedIndex;
    // Mark as skipped (visible state, not silent omission) and resume after it.
    setProcessingState(prev => {
      if (!prev) return prev;
      const steps = [...prev.steps];
      steps[failed] = { ...steps[failed], status: 'skipped', error: undefined };
      return { ...prev, steps, failedIndex: null };
    });
    handleDownload(failed + 1);
  };

  /* ── Standalone tool actions ──────────────────── */
  const handleImageToPdf = async () => {
    if (uploadedImages.length === 0) return;
    setProcessing(true);
    try { await saveBlob(await imagesToPdf(uploadedImages.map(i => ({ data: i.data, type: i.type }))), 'images.pdf'); }
    catch (e) { console.error(e); } finally { setProcessing(false); }
  };

  const handlePdfToImage = async () => {
    setProcessing(true);
    try {
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i]; const src = sources.get(page.sourceFileId); if (!src) continue;
        const pdf = await pdfjsLib.getDocument({ data: src.buffer.slice(0) }).promise;
        const pdfPage = await pdf.getPage(page.sourcePageIndex + 1);
        const vp = pdfPage.getViewport({ scale: 2, rotation: page.rotation });
        const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext('2d'); if (!ctx) continue;
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        const mime = exportFormat === 'png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise<Blob>(res => canvas.toBlob(b => res(b!), mime, 0.95));
        await saveBlob(blob, `page_${i + 1}.${exportFormat}`, mime, exportFormat);
      }
    } catch (e) { console.error(e); } finally { setProcessing(false); }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); editorHistory.undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); editorHistory.redo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editorHistory]);

  const openFilePicker = () => { if (fileInputRef.current) { fileInputRef.current.value = ''; fileInputRef.current.click(); } };
  const openImagePicker = () => { if (imageInputRef.current) { imageInputRef.current.value = ''; imageInputRef.current.click(); } };

  const actualSavings = 0; // Savings shown only via compressed preview size
  const isImageTool = activeTool === 'imageToPdf';

  /* ── Position grid helper (inline, not a nested component) ── */
  const positionGridPositions = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

  /* ── Sidebar tool list ───────────────────────── */
  const renderToolList = (onSelect?: () => void) => {
    let lastGroup = '';
    return TOOLS.map(tool => {
      const showGroup = tool.group !== lastGroup;
      lastGroup = tool.group;
      const Icon = tool.icon;
      return (
        <div key={tool.id}>
          {showGroup && (
            <div className="text-muted-foreground uppercase tracking-widest text-[10px] font-medium px-3 pt-5 pb-1.5">{tool.group}</div>
          )}
          <div
            onClick={() => { setActiveTool(tool.id); onSelect?.(); }}
            className={cn("flex items-center gap-3 px-3 py-1.5 rounded-md cursor-pointer transition-colors",
              activeTool === tool.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
          >
            <Icon size={15} className={activeTool === tool.id ? "text-primary" : ""} />
            <div>
              <div className={cn("text-[13px] leading-tight", activeTool === tool.id ? "font-medium text-foreground" : "font-normal")}>{tool.label}</div>
              <div className="text-[10px] opacity-60">{tool.desc}</div>
            </div>
          </div>
        </div>
      );
    });
  };

  /* ── Step parameter summary (one human line per card) ── */
  const describeStep = useCallback((type: QueueStepType): string => {
    switch (type) {
      case 'organize': return `${pages.length} page${pages.length !== 1 ? 's' : ''} in order`;
      case 'rotate': {
        const rotated = pages.filter(p => p.rotation !== 0).length;
        return rotated > 0 ? `${rotated} page${rotated !== 1 ? 's' : ''} rotated` : 'rotation pending';
      }
      case 'pageNumbers':
        return `${pnPosition.replace('-', ' ')} · ${pnFontSize}pt · start ${parseInt(pnStart) || 1}`;
      case 'watermark': {
        const txt = wmText || (wmTextByPage.size > 0 ? `${wmTextByPage.size} per-page` : '');
        return `${txt || 'no text'} · ${wmOpacity}% · ${wmAngle}°`;
      }
      case 'redact': {
        const total = Array.from(redactions.values()).reduce((s, r) => s + r.length, 0);
        return `${total} area${total !== 1 ? 's' : ''} on ${redactions.size} page${redactions.size !== 1 ? 's' : ''}`;
      }
      case 'crop': return `${cropMap.size} page${cropMap.size !== 1 ? 's' : ''} cropped`;
      case 'resize': {
        const w = resizePreset >= 0 ? PAGE_SIZES[resizePreset].width : parseFloat(customW) || 612;
        const h = resizePreset >= 0 ? PAGE_SIZES[resizePreset].height : parseFloat(customH) || 792;
        const label = resizePreset >= 0 ? PAGE_SIZES[resizePreset].label : 'custom';
        return `${label} · ${Math.round(w)}×${Math.round(h)} pt`;
      }
      case 'compress': return `quality ${quality}`;
      case 'metadata': {
        const parts = [metaTitle, metaAuthor].filter(Boolean);
        return parts.length > 0 ? parts.join(' · ') : 'metadata set';
      }
      case 'annotations': {
        const total = Array.from(annotationsMap.values()).reduce((s, a) => s + a.length, 0);
        return `${total} mark${total !== 1 ? 's' : ''} on ${annotationsMap.size} page${annotationsMap.size !== 1 ? 's' : ''}`;
      }
      case 'split': {
        const groups = splitGroups.filter(g => g.length > 0);
        if (groups.length === 0) return 'no groups';
        return groups.map(g => formatPageRangeList(g)).join(' · ');
      }
    }
  }, [pages, pnPosition, pnFontSize, pnStart, wmText, wmTextByPage, wmOpacity, wmAngle, redactions, cropMap, resizePreset, customW, customH, quality, metaTitle, metaAuthor, annotationsMap, splitGroups, formatPageRangeList]);

  /* ── Vertical chain panel (cards) ─────────────────────── */
  const renderQueueTrail = () => {
    if (editQueue.length === 0) return null;
    const ambiguities = detectQueueAmbiguities(editQueue, { pageNumbers: pnEnabled, watermark: wmEnabled, compress: compressEnabled });
    const isProcessing = !!processingState;
    const hasError = isProcessing && processingState.failedIndex !== null;
    const allDone = isProcessing && processingState.steps.every(s => s.status === 'done');

    // Map step type → its display step in processingState (sequential indices match queueSteps order)
    const statusFor = (type: QueueStepType): 'pending' | 'active' | 'done' | 'error' | 'skipped' | null => {
      if (!processingState) return null;
      const found = processingState.steps.find(s => s && s.type === type);
      return found?.status ?? null;
    };
    const errorFor = (type: QueueStepType): string | undefined => {
      if (!processingState) return;
      return processingState.steps.find(s => s && s.type === type)?.error;
    };

    return (
      <div className="mt-4 md:mt-5 p-4 md:p-5 border border-border rounded-xl bg-card">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-foreground text-[11px] font-semibold uppercase tracking-wider">Edit chain</span>
          <span className="text-muted-foreground text-[10px]">{editQueue.length} step{editQueue.length !== 1 ? 's' : ''}</span>
          {allDone && (
            <span className="ml-auto text-[11px] font-semibold text-primary success-glow">Ready</span>
          )}
        </div>

        <ol className="flex flex-col gap-2">
          {editQueue.map((item, idx) => {
            const meta = STEP_META[item.type];
            const Icon = meta.icon;
            const isOrganize = item.type === 'organize';
            const isDragOver = dragOverQueueIdx === idx && dragQueueIdx !== idx;
            const status = statusFor(item.type);
            const err = errorFor(item.type);
            const ambig = ambiguities.find(a => a.message.toLowerCase().includes(meta.label.toLowerCase()));
            const params = describeStep(item.type);

            return (
              <li
                key={item.id}
                draggable={!isOrganize && !isProcessing}
                onDragStart={() => !isOrganize && setDragQueueIdx(idx)}
                onDragOver={(e) => { e.preventDefault(); setDragOverQueueIdx(idx); }}
                onDragLeave={() => { if (dragOverQueueIdx === idx) setDragOverQueueIdx(null); }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragQueueIdx !== null) reorderQueue(dragQueueIdx, idx); setDragQueueIdx(null); setDragOverQueueIdx(null); }}
                onDragEnd={() => { setDragQueueIdx(null); setDragOverQueueIdx(null); }}
                onClick={() => !isProcessing && setActiveTool(STEP_TO_TOOL[item.type])}
                className={cn(
                  "card-in group flex flex-col gap-1.5 p-2.5 pl-2 pr-2.5 rounded-lg border bg-card transition-all duration-200",
                  !isProcessing && "cursor-pointer hover:border-foreground/20",
                  isDragOver && "ring-2 ring-primary",
                  dragQueueIdx === idx && "opacity-50",
                  status === 'active' && "border-primary/60 soft-pulse",
                  status === 'done' && "opacity-80",
                  status === 'error' && "border-destructive/60",
                )}
              >
                <div className="flex items-center gap-2.5">
                  {!isOrganize && !isProcessing ? (
                    <span className="cursor-grab text-muted-foreground/50 hover:text-foreground/70 shrink-0" aria-hidden>
                      <GripVertical size={14} />
                    </span>
                  ) : (
                    <span className="w-[14px] shrink-0" />
                  )}
                  <span
                    className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border border-border"
                    style={{ backgroundColor: meta.tintVar }}
                  >
                    <Icon size={14} className="text-foreground" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-foreground leading-tight">{meta.label}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">#{idx + 1}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate leading-tight">{params}</div>
                  </div>

                  {/* Status badge */}
                  {status === 'active' && (
                    <Loader2 size={14} className="text-primary spin shrink-0" aria-label="processing" />
                  )}
                  {status === 'done' && (
                    <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                      <Check size={12} />
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shrink-0">
                      <X size={12} />
                    </span>
                  )}
                  {status === 'pending' && (
                    <Clock size={14} className="text-muted-foreground/60 shrink-0" aria-label="queued" />
                  )}
                  {status === 'skipped' && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-px shrink-0" aria-label="skipped">Skipped</span>
                  )}

                  {!isOrganize && !isProcessing && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFromQueue(item.type); }}
                      className="opacity-40 hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-1 rounded shrink-0"
                      aria-label={`Remove ${meta.label} step`}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Inline error detail */}
                {status === 'error' && err && (
                  <div className="ml-[42px] text-[11px] text-destructive">{err}</div>
                )}

                {/* Inline ambiguity note + Swap */}
                {ambig && !isProcessing && (
                  <div className="ml-[42px] flex items-start gap-1.5 text-[11px]">
                    <AlertTriangle size={12} className="text-foreground/70 shrink-0 mt-px" />
                    <span className="text-muted-foreground flex-1">
                      {ambig.message}{' '}
                      <ToolbarTooltip content={ambig.swapHint}>
                        <span className="underline decoration-dotted underline-offset-2 cursor-help">What's the difference?</span>
                      </ToolbarTooltip>
                    </span>
                    {idx > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); reorderQueue(idx, idx - 1); }}
                        className="text-primary font-semibold hover:underline shrink-0"
                      >
                        Swap
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex items-center justify-between gap-2 mt-4">
          <span className="text-[11px] text-muted-foreground">
            {isProcessing ? (hasError ? 'A step needs your attention' : allDone ? 'Your file is ready' : 'Working through the chain') : 'Drag to reorder. Click a step to tweak it.'}
          </span>
          <div className="flex gap-2">
            {hasError && (
              <>
                <Button variant="secondary" size="compact" onClick={() => setProcessingState(null)}>Cancel</Button>
                <Button variant="tertiary" size="compact" onClick={handleSkipFailed}>Skip</Button>
                <Button variant="positive" size="compact" onClick={handleRetryFromFailed}>Retry</Button>
              </>
            )}
            {!isProcessing && (
              <Button onClick={() => handleDownload(0)} disabled={processing || pages.length === 0} isLoading={processing} size="compact" variant="positive" className="px-6">
                <FileDown size={14} className="mr-1.5" /> Download
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ── Render ──────────────────────────────────── */
  return (
    <div className="flex h-screen min-w-0 w-full max-w-full overflow-hidden flex-col md:flex-row">
      {/* Hidden inputs */}
      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" multiple className="fixed -left-[9999px] top-0 h-px w-px opacity-0" onChange={e => { if (e.target.files) addFiles(Array.from(e.target.files)); }} />
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/jpg" multiple className="fixed -left-[9999px] top-0 h-px w-px opacity-0" onChange={e => { if (e.target.files) addImages(Array.from(e.target.files)); }} />

      {/* ── Mobile menu bar ──────────────────── */}
      <div className="flex items-center p-3 border-b border-border bg-sidebar-background gap-3 md:hidden">
        <button onClick={() => setMobileMenuOpen(true)} className="flex items-center justify-center w-9 h-9 rounded-md bg-transparent border border-border cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <MenuIcon size={18} />
        </button>
        <span className="font-medium text-sm text-foreground tracking-tight">PDF Tools</span>
      </div>

      {/* ── Mobile Drawer ──────────────────────── */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="p-3 overflow-y-auto bg-sidebar-background">
          {renderToolList(() => setMobileMenuOpen(false))}
        </SheetContent>
      </Sheet>

      {/* ── Desktop Sidebar ────────────────────── */}
      <div className="hidden md:flex md:flex-col md:w-[220px] md:border-r md:border-border md:bg-sidebar-background md:overflow-y-auto md:py-2 md:px-2 md:shrink-0">
        <div className="flex-1">{renderToolList()}</div>
      </div>

      {/* ── Main content ───────────────────────── */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {/* Drop zone */}
        <div className={cn("flex justify-center shrink-0", hasPdfPages && !isImageTool ? "items-start p-2 px-5" : "flex-col items-center p-8", (!hasPdfPages || (isImageTool && uploadedImages.length === 0)) && "flex-1 pt-12")}>
          <div
            className={cn("relative w-full border-2 border-dashed border-border rounded-2xl text-center cursor-pointer transition-colors",
              hasPdfPages && !isImageTool ? "p-2 px-4 bg-secondary hover:bg-accent" : "max-w-[520px] p-14 bg-card/50 backdrop-blur-sm hover:bg-card/70")}
            onClick={isImageTool ? openImagePicker : openFilePicker}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const files = Array.from(e.dataTransfer.files); isImageTool ? addImages(files) : addFiles(files); }}
          >
            {!isImageTool && (
              <input
                type="file"
                accept=".pdf,application/pdf"
                multiple
                aria-label="Add PDF files"
                className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                onChange={e => { if (e.target.files) addFiles(Array.from(e.target.files)); e.currentTarget.value = ''; }}
              />
            )}
            {isImageTool && (
              <input
                type="file"
                accept="image/png,image/jpeg,image/jpg"
                multiple
                aria-label="Add image files"
                className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                onChange={e => { if (e.target.files) addImages(Array.from(e.target.files)); e.currentTarget.value = ''; }}
              />
            )}
            {!hasPdfPages || (isImageTool && uploadedImages.length === 0) ? (
              <>
                {isImageTool ? <Image size={40} className="text-muted-foreground mx-auto mb-3" /> : <FileText size={40} className="text-muted-foreground mx-auto mb-3" />}
                <p className="font-medium text-sm mb-2">{isImageTool ? 'Drop images here or click to browse' : 'Drop PDFs here or click to browse'}</p>
                <p className="text-muted-foreground text-sm">{isImageTool ? 'PNG, JPG. Will be converted to PDF' : 'All tools are available once you upload'}</p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">Drop PDFs here or click to add more files</p>
            )}
          </div>
          {!hasPdfPages && !isImageTool && (
            <div className="mt-8 text-center">
              <p className="text-foreground text-lg font-semibold tracking-tight">One PDF. Every edit. One download.</p>
              <p className="text-muted-foreground text-sm mt-1.5">A PDF editor that does all your edits in one pass — right in your browser.</p>
            </div>
          )}
        </div>

        {(hasPdfPages || (isImageTool && uploadedImages.length > 0)) && (
          <>
            {/* Toolbar */}
            {!isImageTool && (
              <div className="flex items-center justify-between p-3 md:p-4 md:px-6 border-b border-border flex-wrap gap-2 md:gap-3 shrink-0">
                <div className="flex items-center gap-3">
                  <Button variant="secondary" size="mini" onClick={selectAll}>
                    {selectedPageIds.size === pages.length ? 'Deselect' : 'Select All'}
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    {pages.length}p{selectedPageIds.size > 0 && ` · ${selectedPageIds.size} selected`}
                  </span>
                </div>
                <div className="flex gap-2">
                  <ToolbarTooltip content="Undo (Ctrl+Z)">
                    <Button variant="tertiary" size="mini" onClick={editorHistory.undo} disabled={!editorHistory.canUndo} aria-label="Undo"><Undo2 size={14} /></Button>
                  </ToolbarTooltip>
                  <ToolbarTooltip content="Redo (Ctrl+Y)">
                    <Button variant="tertiary" size="mini" onClick={editorHistory.redo} disabled={!editorHistory.canRedo} aria-label="Redo"><Redo2 size={14} /></Button>
                  </ToolbarTooltip>
                  {selectedPageIds.size > 0 && (
                    <ToolbarTooltip content="Delete selected pages">
                      <Button variant="secondary" size="mini" onClick={removeSelected} aria-label="Delete selected pages"><Trash2 size={14} /></Button>
                    </ToolbarTooltip>
                  )}
                  <ToolbarTooltip content="Reset all">
                    <Button variant="tertiary" size="mini" onClick={handleReset} aria-label="Reset all"><RotateCcw size={14} /></Button>
                  </ToolbarTooltip>
                </div>
              </div>
            )}

            {/* Page grid / Image grid */}
            <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
              {isImageTool ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4 md:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:gap-5">
                  {uploadedImages.map((img, idx) => (
                    <div key={img.id} className="relative rounded-md border border-border overflow-hidden bg-secondary">
                      <img src={img.url} alt={img.file.name} className="w-full h-auto block aspect-[0.707] object-cover" />
                      <button onClick={() => setUploadedImages(prev => prev.filter(i => i.id !== img.id))}
                        className="absolute top-1.5 right-1.5 w-[22px] h-[22px] rounded-full bg-black/60 border-none flex items-center justify-center cursor-pointer">
                        <X size={12} color="white" />
                      </button>
                      <div className="p-1 text-center border-t border-border"><span className="text-xs font-medium">{idx + 1}</span></div>
                    </div>
                  ))}
                  <div onClick={openImagePicker} className="rounded-md border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer min-h-[180px] hover:bg-secondary">
                    <Plus size={24} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Add Images</span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4 md:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:gap-5"
                  onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }}>
                  {pages.map((page, idx) => {
                    const src = sources.get(page.sourceFileId);
                    if (!src) return null;
                    const isSelected = selectedPageIds.has(page.id);
                    const isDragOver = dragOverIdx === idx && dragPageIdx !== idx;
                    const hasRedaction = (redactions.get(idx) || []).length > 0;
                    const cropVal = cropMap.get(idx);
                    const hasCrop = !!cropVal && (cropVal.top > 0 || cropVal.right > 0 || cropVal.bottom > 0 || cropVal.left > 0);
                    const annCount = annotationsMap.get(idx)?.length ?? 0;
                    const hasAnnotations = annCount > 0;
                    const hasRotation = page.rotation !== 0;
                    const editBadges: { label: string; bg: string }[] = [];
                    if (hasRedaction) editBadges.push({ label: 'REDACTED', bg: 'bg-red-600/90' });
                    if (hasCrop) editBadges.push({ label: 'CROPPED', bg: 'bg-amber-600/90' });
                    if (hasAnnotations) editBadges.push({ label: 'EDITED', bg: 'bg-emerald-600/90' });
                    if (hasRotation) editBadges.push({ label: `${page.rotation}°`, bg: 'bg-sky-600/90' });
                    const splitGroupIndices = getSplitGroupIndices(page.id);
                    const defaultCardShadow = isSelected ? '0 0 0 2px hsl(var(--foreground) / 0.08)' : dragPageIdx === idx ? '0 8px 24px hsl(var(--foreground) / 0.15)' : '0 1px 4px hsl(var(--foreground) / 0.06)';
                    const cardBorder = (() => {
                      if (activeTool === 'split' && splitGroupIndices.length > 0) return `1px solid ${getSplitGroupColor(splitGroupIndices[0])}`;
                      if (isSelected) return '2px solid hsl(var(--foreground))';
                      if (isDragOver) return '2px dashed hsl(var(--foreground))';
                      return '1px solid hsl(var(--border))';
                    })();
                    const cardShadow = activeTool === 'split' ? getSplitCardShadow(splitGroupIndices, defaultCardShadow) : defaultCardShadow;

                    return (
                      <div key={page.id} draggable
                        onDragStart={e => { setDragPageIdx(idx); e.dataTransfer.effectAllowed = 'move'; }}
                        onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
                        onDragLeave={() => { if (dragOverIdx === idx) setDragOverIdx(null); }}
                        onDrop={e => { e.preventDefault(); e.stopPropagation(); if (dragPageIdx !== null) movePage(dragPageIdx, idx); setDragPageIdx(null); setDragOverIdx(null); }}
                        onDragEnd={() => { setDragPageIdx(null); setDragOverIdx(null); }}
                        onClick={() => {
                          if (overlayCloseGuard.current) return;
                          if (activeTool === 'split') {
                            setSplitGroups(prev => {
                              const next = prev.map(g => [...g]);
                              const group = next[activeSplitGroup];
                              const existingIdx = group.indexOf(page.id);
                              if (existingIdx >= 0) group.splice(existingIdx, 1); else group.push(page.id);
                              return next;
                            });
                          } else if (activeTool === 'redact') { setRedactPageIdx(idx); }
                          else if (activeTool === 'crop') { setCropPageIdx(idx); }
                          else if (activeTool === 'annotate' || activeTool === 'highlight' || activeTool === 'stamp' || activeTool === 'signature') {
                            setAnnotateMode(activeTool === 'annotate' ? 'text' : activeTool as AnnotationType);
                            setAnnotatePageIdx(idx);
                          } else toggleSelect(page.id);
                        }}
                        className="relative rounded-md bg-background overflow-hidden transition-all duration-150 hover:-translate-y-px"
                        style={{
                          cursor: ['redact', 'crop', 'annotate', 'highlight', 'stamp', 'signature', 'split'].includes(activeTool) ? 'pointer' : 'grab',
                          border: cardBorder,
                          boxShadow: cardShadow,
                          transform: dragPageIdx === idx ? 'scale(1.05)' : undefined,
                        }}
                      >
                        {isSelected && (
                          <div className="absolute top-1.5 left-1.5 w-[22px] h-[22px] rounded-full bg-foreground flex items-center justify-center z-[2]">
                            <span className="text-background text-xs font-bold">✓</span>
                          </div>
                        )}
                        {editBadges.length > 0 && (
                          <div className={cn("absolute top-1.5 z-[2] flex flex-wrap gap-1", isSelected ? "left-[34px]" : "left-1.5")}>
                            {editBadges.map(b => (
                              <div key={b.label} className={cn("rounded px-1.5 py-px", b.bg)}>
                                <span className="text-white text-[10px] font-semibold">{b.label}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <button onClick={e => { e.stopPropagation(); removePage(page.id); }}
                          className="absolute top-1.5 right-1.5 w-[22px] h-[22px] rounded-full bg-black/60 border-none flex items-center justify-center cursor-pointer z-[2] opacity-0 transition-opacity hover:bg-red-600/90 hover:opacity-100"
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0'; }}>
                          <X size={12} color="white" />
                        </button>
                        <div className="aspect-[0.707] bg-secondary flex items-center justify-center overflow-hidden">
                          <PageThumbnail pdfBuffer={src.buffer} pageIndex={page.sourcePageIndex} width={180} rotation={page.rotation}
                            overlays={{
                              ...(pnEnabled ? { pageNumber: { text: String((parseInt(pnStart) || 1) + idx), position: pnPosition, fontSize: pnFontSize } } : {}),
                              ...(() => {
                                const pageWmText = wmTextByPage.get(idx) || wmText;
                                return wmEnabled && pageWmText && (wmPages.size === 0 || wmPages.has(idx)) ? { watermark: { text: pageWmText, opacity: wmOpacity, fontSize: wmFontSize, angle: wmAngle } } : {};
                              })(),
                              ...((redactions.get(idx)?.length ?? 0) > 0 ? { redactRects: redactions.get(idx) } : {}),
                              ...(cropMap.has(idx) ? { crop: cropMap.get(idx) } : {}),
                            }} />
                        </div>
                        <div className="p-1.5 px-2 text-center border-t border-border">
                          <span className="text-xs font-medium">{src.name.replace('.pdf', '')} ({page.sourcePageIndex + 1})</span>
                          {page.rotation !== 0 && <p className="text-muted-foreground text-[10px] m-0">↻ {page.rotation}°</p>}
                          {activeTool === 'split' && splitGroupIndices.length > 0 && (
                            <div className="flex gap-[3px] justify-center flex-wrap mt-1">
                              {splitGroupIndices.map(gi => (
                                <span key={gi} className="text-[9px] font-semibold rounded px-1 py-px border"
                                  style={{ color: getSplitGroupColor(gi), borderColor: getSplitGroupColor(gi), backgroundColor: getSplitGroupTint(gi) }}>
                                  G{gi + 1}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div onClick={openFilePicker} className="rounded-md border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer min-h-[180px] hover:bg-secondary hover:border-muted-foreground">
                    <Plus size={24} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Add PDF</span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Tool Panel ─────────────────────── */}
            <div className="border-t border-border p-4 md:p-6 bg-background overflow-x-hidden overflow-y-auto shrink-0 max-h-[36vh] md:max-h-[40vh]">

              {/* Organize */}
              {activeTool === 'organize' && hasPdfPages && (
                <p className="text-muted-foreground text-sm">Drag pages to reorder · Select & delete · Add more PDFs</p>
              )}

              {/* Split */}
              {activeTool === 'split' && hasPdfPages && (() => {
                const nonEmptyGroups = splitGroups.filter(g => g.length > 0);
                const hasEmptyActiveGroup = splitGroups[activeSplitGroup]?.length === 0 && nonEmptyGroups.length > 0;
                const hasValidGroups = nonEmptyGroups.length > 0;
                const groupSummaries = nonEmptyGroups.map(group => `Group ${splitGroups.indexOf(group) + 1}: pages ${formatPageRangeList(group)}`);
                return (
                  <div className="flex flex-col gap-4">
                    <p className="text-muted-foreground text-sm">Click pages above to add them to the active group. Split will be applied on Download.</p>
                    <div className="flex gap-2 items-center flex-wrap">
                      {splitGroups.map((group, gi) => (
                        <button key={gi} onClick={() => setActiveSplitGroup(gi)}
                          className={cn("px-3 py-1 rounded text-xs flex items-center gap-1.5 cursor-pointer border text-foreground",
                            activeSplitGroup === gi ? "font-semibold" : "font-normal",
                            activeSplitGroup === gi ? "" : "border-border hover:bg-secondary")}
                          style={activeSplitGroup === gi ? { borderColor: getSplitGroupColor(gi), borderWidth: 2, backgroundColor: getSplitGroupTint(gi) } : undefined}>
                          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: getSplitGroupColor(gi) }} />
                          Group {gi + 1} ({group.length})
                          {splitGroups.length > 1 && (
                            <span onClick={(e) => { e.stopPropagation(); setSplitGroups(prev => { const next = prev.filter((_, i) => i !== gi); return next.length === 0 ? [[]] : next; }); setActiveSplitGroup(c => Math.max(0, Math.min(c > gi ? c - 1 : c, splitGroups.length - 2))); }}
                              className="opacity-50 hover:opacity-100 cursor-pointer"><X size={12} /></span>
                          )}
                        </button>
                      ))}
                      <Button variant="tertiary" size="mini" onClick={() => { setSplitGroups(prev => [...prev, []]); setActiveSplitGroup(splitGroups.length); }}>
                        <Plus size={14} className="mr-1" /> New Group
                      </Button>
                    </div>
                    {hasValidGroups && (
                      <div className="p-3 bg-secondary rounded text-xs text-muted-foreground">{groupSummaries.join(' | ')}</div>
                    )}
                    {hasEmptyActiveGroup && <p className="text-destructive text-sm">Group {activeSplitGroup + 1} is empty. Click pages to add them</p>}
                  </div>
                );
              })()}

              {/* Compress */}
              {activeTool === 'compress' && hasPdfPages && (
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="font-medium text-sm">Quality</span>
                    <span className="font-medium text-sm">{quality}%</span>
                  </div>
                  <Slider value={[quality]} onValueChange={slideChange<number[]>(v => { setQuality(v[0]); setCompressEnabled(true); })} onValueCommit={endCoalesce} min={10} max={100} step={5} />
                  <div className="flex justify-between items-center p-4 border border-border rounded-md mt-4">
                    <div>
                      <span className="text-muted-foreground text-xs">Compressed Preview</span>
                      {processing ? <Loader2 size={16} className="animate-spin" /> :
                        <p className={cn("font-medium text-sm")}>{compressedSize > 0 ? formatBytes(compressedSize) : '—'}</p>}
                    </div>
                  </div>
                </div>
              )}

              {/* Rotate */}
              {activeTool === 'rotate' && hasPdfPages && (
                <div className="flex gap-4 items-center flex-wrap">
                  {selectedPageIds.size > 0 ? (
                    <>
                      <span className="text-muted-foreground text-xs">Rotate {selectedPageIds.size} selected page{selectedPageIds.size !== 1 ? 's' : ''}</span>
                      <Button variant="secondary" size="compact" onClick={() => rotateSelected(-90)}><RotateCcwIcon size={16} className="mr-1" /> CCW</Button>
                      <Button variant="secondary" size="compact" onClick={() => rotateSelected(90)}><RotateCw size={16} className="mr-1" /> CW</Button>
                      <Button variant="secondary" size="compact" onClick={() => rotateSelected(180)}>180°</Button>
                    </>
                  ) : <p className="text-muted-foreground text-sm">Select pages above or use "Select All" to rotate</p>}
                </div>
              )}

              {/* Page Numbers */}
              {activeTool === 'pageNumbers' && hasPdfPages && (
                <div className="flex gap-6 flex-wrap items-center">
                  <div>
                    <span className="text-xs font-medium mb-2 block">Position</span>
                    <div className="grid grid-cols-3 gap-1 max-w-[180px]">
                      {positionGridPositions.map(pos => (
                        <button key={pos} onClick={() => { setPnPosition(pos); setPnEnabled(true); }}
                          className={cn("p-2 rounded text-[10px] cursor-pointer border hover:bg-secondary", pnPosition === pos ? "border-2 border-foreground bg-secondary" : "border-border bg-transparent")}>
                          {pos.replace('-', '\n')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="min-w-[120px]">
                    <span className="text-xs font-medium mb-2 block">Font size: {pnFontSize}px</span>
                    <Slider value={[pnFontSize]} onValueChange={slideChange<number[]>(v => { setPnFontSize(v[0]); setPnEnabled(true); })} onValueCommit={endCoalesce} min={8} max={24} step={1} />
                  </div>
                  <div className="min-w-[80px]">
                    <span className="text-xs font-medium mb-2 block">Start at</span>
                    <Input type="number" value={pnStart} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => { setPnStart(e.target.value); setPnEnabled(true); }} className="h-7 text-xs" />
                  </div>
                </div>
              )}

              {/* Watermark */}
              {activeTool === 'watermark' && hasPdfPages && (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-5 flex-wrap items-center">
                    <div className="min-w-[140px] flex-1">
                      <span className="text-xs font-medium mb-2 block">Watermark Text</span>
                      <Input
                        value={wmDraft}
                        onChange={e => setWmDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && wmDraft.trim()) {
                            if (selectedPageIds.size > 0) {
                              // Apply to selected pages
                              const newMap = new Map(wmTextByPage);
                              selectedPageIds.forEach(id => {
                                const idx = pages.findIndex(p => p.id === id);
                                if (idx >= 0) newMap.set(idx, wmDraft);
                              });
                              setWmTextByPage(newMap);
                            } else {
                              setWmText(wmDraft);
                            }
                            setWmEnabled(true);
                          }
                        }}
                        placeholder="Type watermark and press Enter"
                        className="h-8"
                      />
                    </div>
                    <div className="min-w-[100px]">
                      <span className="text-xs font-medium">Opacity: {wmOpacity}%</span>
                      <Slider value={[wmOpacity]} onValueChange={slideChange<number[]>(v => { setWmOpacity(v[0]); })} onValueCommit={endCoalesce} min={5} max={80} step={5} />
                    </div>
                    <div className="min-w-[100px]">
                      <span className="text-xs font-medium">Size: {wmFontSize}px</span>
                      <Slider value={[wmFontSize]} onValueChange={slideChange<number[]>(v => { setWmFontSize(v[0]); })} onValueCommit={endCoalesce} min={12} max={96} step={4} />
                    </div>
                    <div className="min-w-[100px]">
                      <span className="text-xs font-medium">Angle: {wmAngle}°</span>
                      <Slider value={[wmAngle]} onValueChange={slideChange<number[]>(v => { setWmAngle(v[0]); })} onValueCommit={endCoalesce} min={-90} max={90} step={5} />
                    </div>
                  </div>

                  {/* Apply buttons */}
                  <div className="flex gap-2 items-center flex-wrap">
                    <Button
                      variant="positive"
                      size="mini"
                      disabled={!wmDraft.trim()}
                      onClick={() => {
                        if (!wmDraft.trim()) return;
                        setWmText(wmDraft);
                        setWmTextByPage(new Map());
                        setWmPages(new Set());
                        setWmEnabled(true);
                      }}
                    >
                      Apply to All Pages
                    </Button>
                    {selectedPageIds.size > 0 && (
                      <Button
                        variant="secondary"
                        size="mini"
                        disabled={!wmDraft.trim()}
                        onClick={() => {
                          if (!wmDraft.trim()) return;
                          const newMap = new Map(wmTextByPage);
                          selectedPageIds.forEach(id => {
                            const idx = pages.findIndex(p => p.id === id);
                            if (idx >= 0) newMap.set(idx, wmDraft);
                          });
                          setWmTextByPage(newMap);
                          setWmEnabled(true);
                        }}
                      >
                        Apply to {selectedPageIds.size} Selected
                      </Button>
                    )}
                    {wmEnabled && (
                      <Button variant="tertiary" size="mini" onClick={() => { setWmEnabled(false); setWmText(''); setWmTextByPage(new Map()); }}>
                        Clear All
                      </Button>
                    )}
                  </div>

                  {wmEnabled && !wmText && wmTextByPage.size === 0 && (
                    <p className="text-xs text-amber-500">⚠ Watermark enabled but no text set. It will not appear in your output.</p>
                  )}

                  {/* Per-page watermark status */}
                  {wmEnabled && (
                    <div className="flex gap-3 items-center flex-wrap">
                      <span className="text-muted-foreground text-xs">Pages with watermark:</span>
                      {pages.map((_, idx) => {
                        const pageWm = wmTextByPage.get(idx) || wmText;
                        const hasWm = !!pageWm && (wmPages.size === 0 || wmPages.has(idx));
                        return (
                          <ToolbarTooltip key={idx} content={hasWm ? `"${pageWm}"` : 'No watermark'}>
                            <button
                              onClick={() => {
                                if (wmTextByPage.has(idx)) {
                                  // Remove per-page override
                                  const newMap = new Map(wmTextByPage);
                                  newMap.delete(idx);
                                  setWmTextByPage(newMap);
                                } else {
                                  // Set per-page watermark with current draft
                                  if (wmDraft.trim()) {
                                    const newMap = new Map(wmTextByPage);
                                    newMap.set(idx, wmDraft);
                                    setWmTextByPage(newMap);
                                    setWmEnabled(true);
                                  }
                                }
                              }}
                              className={cn("w-7 h-7 rounded text-[11px] font-semibold cursor-pointer border",
                                hasWm ? "bg-foreground text-background border-foreground" : "bg-transparent text-muted-foreground border-border hover:bg-secondary")}
                            >
                              {idx + 1}
                            </button>
                          </ToolbarTooltip>
                        );
                      })}
                    </div>
                  )}

                  {selectedPageIds.size === 0 && !wmEnabled && (
                    <p className="text-muted-foreground text-sm">Select pages above for per-page watermarks, or use "Apply to All Pages"</p>
                  )}
                </div>
              )}

              {/* Redact */}
              {activeTool === 'redact' && hasPdfPages && (
                <div className="flex gap-4 items-center flex-wrap">
                  <EyeOff size={18} className="text-foreground" />
                  <p className="text-muted-foreground text-sm">Select a page above to draw redaction areas</p>
                  {redactions.size > 0 && (
                    <>
                      <span className="text-foreground text-xs font-medium">{Array.from(redactions.values()).reduce((s, r) => s + r.length, 0)} area(s) on {redactions.size} page(s)</span>
                      <Button variant="tertiary" size="mini" onClick={() => setRedactions(new Map())}>Clear all</Button>
                    </>
                  )}
                </div>
              )}

              {/* Crop */}
              {activeTool === 'crop' && hasPdfPages && (
                <div className="flex gap-4 items-center flex-wrap">
                  <Crop size={18} className="text-foreground" />
                  <p className="text-muted-foreground text-sm">Click a page above to visually crop it</p>
                  {cropMap.size > 0 && (
                    <>
                      <span className="text-foreground text-xs font-medium">{cropMap.size} page{cropMap.size !== 1 ? 's' : ''} cropped</span>
                      <Button variant="tertiary" size="mini" onClick={() => setCropMap(new Map())}>Clear all</Button>
                    </>
                  )}
                </div>
              )}

              {/* Annotation tools */}
              {(activeTool === 'annotate' || activeTool === 'highlight' || activeTool === 'stamp' || activeTool === 'signature') && hasPdfPages && (
                <div className="flex gap-4 items-center flex-wrap">
                  {activeTool === 'annotate' && <Type size={18} className="text-foreground" />}
                  {activeTool === 'highlight' && <Highlighter size={18} className="text-foreground" />}
                  {activeTool === 'stamp' && <Stamp size={18} className="text-foreground" />}
                  {activeTool === 'signature' && <PenTool size={18} className="text-foreground" />}
                  <p className="text-muted-foreground text-sm">Click a page above to add {activeTool === 'annotate' ? 'text' : activeTool}</p>
                  {totalAnnotations > 0 && (
                    <>
                      <span className="text-foreground text-xs font-medium">{totalAnnotations} annotation(s) on {annotationsMap.size} page(s)</span>
                      <Button variant="tertiary" size="mini" onClick={() => setAnnotationsMap(new Map())}>Clear all</Button>
                    </>
                  )}
                </div>
              )}

              {/* Resize Pages */}
              {activeTool === 'resize' && hasPdfPages && (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-4 items-center flex-wrap">
                    {PAGE_SIZES.map((size, idx) => (
                      <Button key={size.label} variant={resizePreset === idx ? 'default' : 'secondary'} size="mini" onClick={() => { setResizePreset(idx); setResizeEnabled(true); }}>{size.label}</Button>
                    ))}
                    <Button variant={resizePreset === -1 ? 'default' : 'secondary'} size="mini" onClick={() => { setResizePreset(-1); setResizeEnabled(true); }}>Custom</Button>
                    {resizePreset === -1 && (
                      <div className="flex gap-2 items-center">
                        <Input type="number" value={customW} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setCustomW(e.target.value)} className="w-20 h-7 text-xs" />
                        <span className="text-xs font-medium">×</span>
                        <Input type="number" value={customH} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setCustomH(e.target.value)} className="w-20 h-7 text-xs" />
                        <span className="text-muted-foreground text-xs">pts</span>
                      </div>
                    )}
                    {resizePreset >= 0 && (
                      <p className="text-muted-foreground text-sm">{PAGE_SIZES[resizePreset].label}: {Math.round(PAGE_SIZES[resizePreset].width * 25.4 / 72)} × {Math.round(PAGE_SIZES[resizePreset].height * 25.4 / 72)} mm</p>
                    )}
                  </div>
                </div>
              )}

              {/* Image → PDF */}
              {activeTool === 'imageToPdf' && uploadedImages.length > 0 && (
                <div className="flex gap-4 items-center flex-wrap">
                  <p className="text-muted-foreground text-sm">{uploadedImages.length} image{uploadedImages.length !== 1 ? 's' : ''} ready</p>
                  <div className="flex-1 min-w-4" />
                  <Button onClick={handleImageToPdf} disabled={processing} isLoading={processing} variant="positive">
                    <FileDown size={18} className="mr-2" /> Create PDF
                  </Button>
                </div>
              )}

              {/* PDF → Image */}
              {activeTool === 'pdfToImage' && hasPdfPages && (
                <div className="flex gap-3 items-center flex-wrap">
                  <span className="text-foreground text-xs font-medium">Format:</span>
                  <Button variant={exportFormat === 'png' ? 'default' : 'secondary'} size="mini" onClick={() => setExportFormat('png')}>PNG</Button>
                  <Button variant={exportFormat === 'jpg' ? 'default' : 'secondary'} size="mini" onClick={() => setExportFormat('jpg')}>JPG</Button>
                  <p className="text-muted-foreground text-sm">{pages.length} page{pages.length !== 1 ? 's' : ''}</p>
                  <div className="flex-1 min-w-4" />
                  <Button onClick={handlePdfToImage} disabled={processing} isLoading={processing} variant="positive">
                    <Camera size={18} className="mr-2" /> Export
                  </Button>
                </div>
              )}

              {/* Metadata */}
              {activeTool === 'metadata' && hasPdfPages && (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-4 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <span className="text-xs font-medium mb-2 block">Title</span>
                      <Input value={metaTitle} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setMetaTitle(e.target.value)} placeholder="Document title" className="h-8" />
                    </div>
                    <div className="flex-1 min-w-[140px]">
                      <span className="text-xs font-medium mb-2 block">Author</span>
                      <Input value={metaAuthor} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setMetaAuthor(e.target.value)} placeholder="Author name" className="h-8" />
                    </div>
                  </div>
                  <div className="flex gap-4 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <span className="text-xs font-medium mb-2 block">Subject</span>
                      <Input value={metaSubject} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setMetaSubject(e.target.value)} placeholder="Document subject" className="h-8" />
                    </div>
                    <div className="flex-1 min-w-[140px]">
                      <span className="text-xs font-medium mb-2 block">Keywords (comma-separated)</span>
                      <Input value={metaKeywords} onFocus={beginCoalesceOnce} onBlur={endCoalesce} onChange={e => setMetaKeywords(e.target.value)} placeholder="pdf, report, 2024" className="h-8" />
                    </div>
                  </div>
                  {hasMetadata && <p className="text-muted-foreground text-sm">✓ Metadata will be embedded on download</p>}
                </div>
              )}

              {/* ── Edit Chain Panel ─────────────────── */}
              {hasPdfPages && activeTool !== 'imageToPdf' && activeTool !== 'pdfToImage' && (
                <>
                  {editQueue.length > 0 ? renderQueueTrail() : (
                    <div className="mt-4 md:mt-5 p-5 border border-border rounded-xl bg-card">
                      <div className="text-center">
                        <p className="text-foreground text-sm font-semibold mb-1">Your edit chain is empty.</p>
                        <p className="text-muted-foreground text-xs mb-4">Pick a tool above. Each change you make lands here as a card you can reorder, tweak, or remove.</p>
                        <Button onClick={() => handleDownload(0)} disabled={processing || pages.length === 0} isLoading={processing} size="compact" variant="positive" className="px-6">
                          <FileDown size={14} className="mr-1.5" /> Download as is
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Processing Overlay */}
      {/* Preflight issues dialog */}
      {preflightIssues && (
        <div className="fixed inset-0 bg-black/60 z-[999] flex items-center justify-center p-4">
          <div className="bg-background border border-border rounded-lg p-6 max-w-md w-full max-h-[80vh] overflow-y-auto">
            <h3 className="text-foreground font-semibold text-base mb-2">Fix these before processing</h3>
            <p className="text-muted-foreground text-xs mb-4">{preflightIssues.length} issue{preflightIssues.length !== 1 ? 's' : ''} would prevent a correct output.</p>
            <ul className="flex flex-col gap-2 mb-5">
              {preflightIssues.map((iss, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <AlertTriangle size={14} className="text-destructive shrink-0 mt-1" />
                  <div>
                    <span className="text-foreground font-medium">{STEP_META[iss.operation as QueueStepType]?.label || iss.operation}:</span>{' '}
                    <span className="text-muted-foreground">{iss.message}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button variant="positive" size="compact" onClick={() => setPreflightIssues(null)}>Got it</Button>
            </div>
          </div>
        </div>
      )}

      {/* Compression warning — vector ops will be rasterized */}
      {compressWarning && (
        <div className="fixed inset-0 bg-black/60 z-[999] flex items-center justify-center p-4">
          <div className="bg-background border border-border rounded-lg p-6 max-w-md w-full">
            <h3 className="text-foreground font-semibold text-base mb-2">Low-quality compression will rasterize edits</h3>
            <p className="text-muted-foreground text-sm mb-5">
              Compression runs before vector edits (annotations, watermark, page numbers, black-out) at quality &lt;60%.
              Pages will be re-rendered as JPEG. Continue?
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" size="compact" onClick={() => setCompressWarning(null)}>Cancel</Button>
              <Button variant="positive" size="compact" onClick={() => compressWarning.pendingRun()}>Continue</Button>
            </div>
          </div>
        </div>
      )}

      {/* Processing state is rendered inline on the chain cards (no modal) */}

      {/* Redact Overlay */}
      {redactPageIdx !== null && (() => {
        const page = pages[redactPageIdx]; const src = page ? sources.get(page.sourceFileId) : null;
        if (!src) return null;
        const closeRedact = () => { setRedactPageIdx(null); overlayCloseGuard.current = true; setTimeout(() => { overlayCloseGuard.current = false; }, 400); };
        return <RedactOverlay pdfBuffer={src.buffer} pageIndex={page.sourcePageIndex} rotation={page.rotation} existingRects={redactions.get(redactPageIdx) || []}
          onSave={rects => { setRedactions(prev => { const next = new Map(prev); if (rects.length > 0) next.set(redactPageIdx, rects); else next.delete(redactPageIdx); return next; }); closeRedact(); }}
          onClose={closeRedact} />;
      })()}

      {/* Crop Overlay */}
      {cropPageIdx !== null && (() => {
        const page = pages[cropPageIdx]; const src = page ? sources.get(page.sourceFileId) : null;
        if (!src) return null;
        const closeCrop = () => { setCropPageIdx(null); overlayCloseGuard.current = true; setTimeout(() => { overlayCloseGuard.current = false; }, 400); };
        return <CropOverlay pdfBuffer={src.buffer} pageIndex={page.sourcePageIndex} rotation={page.rotation} existingCrop={cropMap.get(cropPageIdx!) || { top: 0, right: 0, bottom: 0, left: 0 }}
          onSave={crop => { setCropMap(prev => { const next = new Map(prev); const hasCrop = crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0; if (hasCrop) next.set(cropPageIdx!, crop); else next.delete(cropPageIdx!); return next; }); closeCrop(); }}
          onClose={closeCrop} />;
      })()}

      {/* Annotation Overlay */}
      {annotatePageIdx !== null && (() => {
        const page = pages[annotatePageIdx]; const src = page ? sources.get(page.sourceFileId) : null;
        if (!src) return null;
        const closeOverlay = () => {
          setAnnotatePageIdx(null);
          // Guard: prevent page clicks from immediately re-opening an overlay
          overlayCloseGuard.current = true;
          setTimeout(() => { overlayCloseGuard.current = false; }, 400);
        };
        return <AnnotationOverlay pdfBuffer={src.buffer} pageIndex={page.sourcePageIndex} rotation={page.rotation} existingAnnotations={annotationsMap.get(annotatePageIdx) || []} mode={annotateMode}
          onSave={anns => { setAnnotationsMap(prev => { const next = new Map(prev); if (anns.length > 0) next.set(annotatePageIdx, anns); else next.delete(annotatePageIdx); return next; }); closeOverlay(); }}
          onClose={closeOverlay} />;
      })()}
    </div>
  );
};

export default PdfWorkspace;

# Hardening the PDF Editor Pipeline (revised)

Scope: logic, validation, error handling, ordering, history. No visual restyle. The two-phase architecture (`buildFinalPdf` single-pass + chained post-processing via `blobToPipeline`) is preserved. Do not rewrite the architecture; harden it with targeted changes only.

Five correctness rules below are non-negotiable and are marked **[CRITICAL]**. They address failure modes that will silently corrupt state or output if skipped. Apply them as you implement, not afterward.

---

## 1. User-controlled operation order

**Today:** `editQueue` exists but is silently reordered. `addToQueue` and `reorderQueue` force `split` to the end, and `buildFinalPdf` lumps all "page edit" operations into one pass regardless of queue order.

**Change:**

- Remove the silent split-pinning in `addToQueue` / `reorderQueue`. Drop `splitMovedToast`.
- Treat the queue as the single source of truth for execution order. Walk it linearly. Each step either (a) modifies the in-flight `{pages, sources}` pipeline via a focused `buildFinalPdf` call carrying ONLY that step's options, or (b) is a terminal/branching step (`split`, `compress`, `resize`).
- Detect *genuine* ambiguities and surface an inline note in the queue row (not a silent reorder). Cases:
  - `pageNumbers` + `split`: numbering before split = continuous numbering across output files; numbering after split = each file restarts at start number. Inline note on the later of the two, with a "Swap" affordance and a "What's the difference?" tooltip.
  - `watermark` + `split`: same pattern (per-page watermark map indices may shift after split).
  - `compress` + `split`: also order-dependent (compress-then-split vs split-then-compress-each yields different per-file size and quality). Lower priority than the two above, but flag it with the same inline-note mechanism rather than ignoring it.
- Other multi-edit pairs are commutative enough that user order is honored without warning.

**Technical:**

- New `runQueue(queue, ctx)` orchestrator in `PdfWorkspace` (delegating to the pure module below). Loops steps, threading `{pages, sources}` through `blobToPipeline` after any step that produces a blob (compress/resize/split-as-single).
- New helper `detectQueueAmbiguities(queue): {stepId, message, swapTarget}[]` shown in the queue UI.

## 2. Eliminate silent failures

**Today:** `buildFinalPdf` swallows stamp/signature embed errors with `console.warn`. Compression `pdfPage.render` and `canvas.toBlob` can fail silently.

**Change:**

- New `PdfOpError` class in `pdf-utils.ts` carrying `{operation, pageIndex, cause, recoverable: true}`.
- Convert every `catch (e) { console.warn… }` in `pdf-utils.ts` into a thrown `PdfOpError`.
- `runQueue` catches per-step. Extend the existing `ProcessingOverlay` error state from "Retry from X / Cancel" to three actions: **Skip this operation** (removes the failing op from the queue for this run only and continues), **Retry**, **Abort**.
- Page-level errors bubble up with explicit page numbers, e.g. "Stamp embed failed on page 4: invalid PNG data" — never a silent missing stamp.

## 3. Preflight validation

**New function** `preflightQueue(queue, state): PreflightIssue[]` runs synchronously before `runQueue` starts. Checks:

- `split`: parse current split groups against `pages.length`; flag empty groups, out-of-range, overlap-with-warning.
- `stamp` / `signature` annotations: each annotation's `imageData` / `signatureData` is non-empty and decodes (cheap header sniff for PNG/JPEG magic bytes).
- `watermark` / `pageNumbers`: text non-empty when enabled; font size in [4, 200].
- `crop`: each `CropValues` has top+bottom < 100 and left+right < 100; otherwise the page is degenerate.
- `resize`: custom width/height numeric and within [50, 14400].
- `compress`: `quality` in [1, 100].
- `pages.length > 0`.

If any issues, show a single dialog listing them all grouped by operation, blocking `Run`. No partial start.

## 4. Compression safety with annotations

**Today:** lossy `compressPdf` (quality < 60) re-renders each page to JPEG and rebuilds it at `origVp` dimensions with `scale: 1`, and it does NOT honor the crop box. Any vector data (text, highlights, stamps, page numbers, watermark, redaction rectangles) that exists before compression is flattened; any added after a compress round-trip lands in a coordinate system that no longer matches the pre-compress page geometry.

**Change:**

- In `runQueue`, when `compress` and any of `{annotations, watermark, pageNumbers, redact}` are both present:
  - If compress comes AFTER the vector ops → bake them in via `buildFinalPdf` first, then compress. No data loss; the user's order is honored.
  - If compress comes BEFORE the vector ops → after compression, run `buildFinalPdf` again on the compressed blob (via `blobToPipeline`) to apply the vector ops on top.
- **[CRITICAL] Do not assume annotation coordinates survive the compression round-trip.** Because the lossy path rebuilds pages at `origVp` dimensions and discards the crop box, the post-compress page geometry can differ from what the annotation coordinates were authored against. After compression, re-derive every subsequent annotation/watermark/page-number placement from the *compressed page's actual dimensions and crop state*, not from the pre-compress geometry. Add a test that places a signature on a page that is BOTH cropped AND compressed and confirms the signature lands in the correct spot.
- Surface a one-time warning when `compress` precedes vector ops at low quality (<60): "Low-quality compression rasterizes pages. Edits placed before compression will lose fidelity. Continue?" with Continue/Cancel.

## 5. Unified undo history

**Today:** `useHistory` only wraps `pages`. Annotations, watermark, page numbers, redactions, crops, resize, compress, metadata, and `editQueue` live outside it.

**Change:**

- Replace `pagesHistory` with `editorHistory: useHistory<EditorState>`:

```ts
interface EditorState {
  pages: PageItem[];
  editQueue: QueueItem[];
  annotationsMap: Map<number, Annotation[]>;
  redactions: Map<number, RedactRect[]>;
  cropMap: Map<number, CropValues>;
  splitGroups: string[][];
  pnEnabled; pnPosition; pnFontSize; pnStart;
  wmEnabled; wmText; wmTextByPage; wmOpacity; wmFontSize; wmAngle; wmPages;
  resizeEnabled; resizePreset; customW; customH;
  compressEnabled; quality;
  metaTitle; metaAuthor; metaSubject; metaKeywords;
}

```

- `useHistory` already supports any `T`; widen the generic. Add `update`, `beginCoalesce`, `endCoalesce`.
- Provide a thin `useEditorState()` wrapper exposing per-field setters that internally call `update`, so call sites stay readable.
- Debounce rapid same-field edits (slider drags) via coalescing so a single drag = one history entry.
- Keyboard: `Cmd/Ctrl+Z` → `undo`, `Cmd/Ctrl+Shift+Z` → `redo`, wired to the unified hook.
- `sources` (raw file buffers) stays out of history — immutable inputs, not edits.

**[CRITICAL] Map immutability.** Every history-tracked Map (`annotationsMap`, `redactions`, `cropMap`) must be replaced with a brand-new Map on every edit and NEVER mutated in place. In-place mutation (`map.set(...)` on a Map that is also referenced by a prior history snapshot) makes the "previous" snapshot point at the already-mutated object, so undo silently does nothing or skips a step. The existing code passes Maps around freely, so enforce this explicitly: any setter touching a Map clones it first (`new Map(prev)`), edits the clone, and stores the clone. Add a comment marking this rule at each such setter.

**[CRITICAL] Only intentional edits push history.** Because every setter now snapshots the whole `EditorState`, incidental or derived state changes will inject phantom history entries, and the user will hit undo and see "nothing happen" because they are undoing a change they never consciously made. Build this rule into `useEditorState`: only user-initiated edits (placing an annotation, changing a setting, reordering the queue, rotating a page) create a history entry. Mount effects, selection/active-tool changes, recomputed/derived values, and programmatic syncs must use a non-history setter path that updates state without pushing onto the undo stack. Coalescing handles within-field rapid edits; this rule handles cross-field and incidental noise. They are separate concerns and both are required.

- History granularity target: placing a highlight, then changing watermark text, then reordering the queue = three distinct undoable entries, each reversible individually.

## 6. Composability guarantees

- Add `assertOutputValid(blob, expectations)` post-pipeline: reload the blob with `pdf-lib`, assert `pageCount > 0`.
- **[CRITICAL] Keep the page-count assertion simple.** Page count changes ONLY on split. For any non-split pipeline, assert output page count === input page count, exactly. Do not build a complex expected-count formula for the non-split case; an over-engineered formula produces false-positive failures on valid output. For the split (zip) case, assert the sum of group sizes equals the total ranged pages.
- Add an `executedOps` accumulator in `runQueue`. After completion, assert `executedOps.length === queue.length` minus any user-skipped ops. Throws `PdfOpError` if any op was silently dropped.
- All assertions throw `PdfOpError` so they hit the same overlay UX.

## 7. Known limitation to surface, not silently "solve"

**[CRITICAL — honesty, not silent pass] Redaction does not actually remove content.** The current `redact` op draws an opaque black rectangle over the region, but the underlying text/content stream remains in the PDF and is fully recoverable by select-all or text extraction. This is a false-confidence misfeature for any sensitive document. Do ONE of the following and state which you chose:

- (a) Truly remove the underlying content in the redacted region (strip the covered content stream operators), or
- (b) Relabel the redact tool in the UI to make explicit it is a visual cover only ("Black-out (visual cover, does not remove underlying text)"), so no user trusts it for real redaction. Do not implement redaction as a black box and treat it as solved.

---

## Files to change

- `src/lib/pdf-utils.ts` — add `PdfOpError`; throw instead of `console.warn` in stamp/signature/render paths; expose granular per-step `buildFinalPdf` callers (`applyAnnotations`, `applyWatermark`, etc., all built on the existing `buildFinalPdf` with narrowed `BuildOptions`); add post-compress coordinate re-derivation for downstream vector ops; no architectural rewrite.
- `src/lib/useHistory.ts` — add `update`, `beginCoalesce`, `endCoalesce`; keep generic.
- `src/lib/editor-state.ts` (new) — `EditorState` type, `useEditorState` hook wrapping `useHistory`, default state factory, the Map-clone rule, and the intentional-vs-incidental setter split.
- `src/lib/queue-runner.ts` (new) — `runQueue`, `preflightQueue`, `detectQueueAmbiguities`, `assertOutputValid`. Pure functions, no React.
- `src/components/PdfWorkspace.tsx` — switch state to `useEditorState`; replace inline pipeline-execution code in the Run handler with `runQueue`; render preflight dialog and ambiguity inline notes; extend `ProcessingOverlay` action set (Skip/Retry/Abort); remove silent split-pinning.
- `src/components/AnnotationOverlay.tsx` — propagate annotation edits via the unified history setter (one entry per finalized stroke/text, not per keystroke; uses coalescing); clone-on-write for the annotations Map.
- `src/components/RedactOverlay.tsx` — only if pursuing redaction option (a); otherwise the relabel lives in `PdfWorkspace`/UI copy.
- No changes to `CropOverlay.tsx`, `PageThumbnail.tsx`, `theme-context.tsx`, styles, or any UI primitive.

## Out of scope

- Any visual/styling change.
- Replacing `pdf-lib` / `pdfjs-dist`.
- New tools or features beyond what already exists in `TOOLS` (true content-stream redaction under 7(a) is a hardening of an existing tool, not a new one).

## Risk notes

- Widening `useHistory` to a fat object means every history-pushing setter snapshots the full state. Mitigated by (1) the intentional-only rule keeping the entry count low, (2) coalescing rapid edits, and (3) clone-on-write Maps so structural sharing is safe rather than a corruption source.
- The orchestrator's per-step re-entry via `blobToPipeline` reloads the in-flight PDF between steps; this is already the pattern for compress/resize/split, so no perf regression versus today for those branches.
- Post-compress coordinate re-derivation (rule 4) adds one extra geometry read per affected page; negligible cost, prevents misplaced annotations.

## After implementing

List exactly which files changed and what changed in each. State which redaction option (a or b) you chose. Confirm the cropped-and-compressed signature test passes.
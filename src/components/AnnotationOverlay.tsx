import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { X, Type, Highlighter, ImageIcon, PenTool, Plus, Minus, Trash2, Undo2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { putImage, getImage } from '@/lib/image-store';

if (typeof window !== 'undefined') { pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`; }

export type AnnotationType = 'text' | 'highlight' | 'stamp' | 'signature';

export interface Annotation {
  id: string;
  type: AnnotationType;
  x: number; y: number; width: number; height: number;
  text?: string; fontSize?: number; color?: string;
  highlightColor?: string; highlightOpacity?: number;
  /** Content-addressed key into image-store (stamps + signatures). */
  imageKey?: string; imageType?: 'png' | 'jpg';
  /** @deprecated legacy inline bytes — kept for backwards compat with old snapshots. */
  imageData?: Uint8Array;
  /** @deprecated legacy inline bytes — kept for backwards compat with old snapshots. */
  signatureData?: Uint8Array;
}


interface AnnotationOverlayProps {
  pdfBuffer: ArrayBuffer;
  pageIndex: number;
  rotation?: number;
  existingAnnotations: Annotation[];
  mode: AnnotationType;
  onSave: (annotations: Annotation[]) => void;
  onClose: () => void;
}

const COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#FF6600', '#FFFF00', '#00CC00',
  '#0000FF', '#9900CC', '#FF69B4', '#00CCCC', '#8B4513', '#808080',
];
const HIGHLIGHT_COLORS = [
  '#FFFF00', '#00CC00', '#FF69B4', '#00CCCC', '#FF6600',
  '#0000FF', '#9900CC', '#FF0000', '#8B4513', '#808080',
];

const ColorPalette = ({
  colors,
  active,
  onChange,
}: { colors: string[]; active: string; onChange: (c: string) => void }) => (
  <div className="flex gap-1 items-center flex-wrap">
    {colors.map(c => (
      <button key={c} onClick={() => onChange(c)}
        className="w-6 h-6 rounded-full cursor-pointer flex-shrink-0"
        style={{ backgroundColor: c, border: active === c ? '3px solid white' : '2px solid rgba(255,255,255,0.3)' }} />
    ))}
    <label className="w-6 h-6 rounded-full cursor-pointer flex items-center justify-center flex-shrink-0"
      style={{ border: !colors.includes(active) ? '3px solid white' : '2px solid rgba(255,255,255,0.3)', backgroundColor: !colors.includes(active) ? active : 'transparent' }}>
      <Plus size={12} className="text-white pointer-events-none" />
      <input type="color" value={active} onChange={e => onChange(e.target.value)} className="sr-only" />
    </label>
  </div>
);



const AnnotationOverlay = ({ pdfBuffer, pageIndex, rotation = 0, existingAnnotations, mode, onSave, onClose }: AnnotationOverlayProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [annotations, setAnnotations] = useState<Annotation[]>(existingAnnotations);
  const [newText, setNewText] = useState('Sample text');
  const [newFontSize, setNewFontSize] = useState(16);
  const [newColor, setNewColor] = useState('#000000');
  const [highlightColor, setHighlightColor] = useState('#FFFF00');
  const [highlightOpacity, setHighlightOpacity] = useState(0.4);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawCurrent, setDrawCurrent] = useState({ x: 0, y: 0 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDragRef = useRef<{ id: string; offset: { x: number; y: number } } | null>(null);
  const didStartDrag = useRef(false);
  const sigCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isSigDrawing, setIsSigDrawing] = useState(false);
  const isSigDrawingRef = useRef(false);
  const [sigPoints, setSigPoints] = useState<{ x: number; y: number }[][]>([]);
  const [currentSigStroke, setCurrentSigStroke] = useState<{ x: number; y: number }[]>([]);
  const currentSigStrokeRef = useRef<{ x: number; y: number }[]>([]);
  const stampInputRef = useRef<HTMLInputElement>(null);

  // Cancel re-trigger guard
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(t);
  }, []);

  // Scale step for +/- toolbar sizing
  const SCALE_STEP_PX = 10;

  const scaleX = displaySize.width > 0 ? displaySize.width / pageSize.width : 1;
  const scaleY = displaySize.height > 0 ? displaySize.height / pageSize.height : 1;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer.slice(0)) }).promise;
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1, rotation });
      setPageSize({ width: vp.width, height: vp.height });
      const maxW = window.innerWidth * 0.7;
      const maxH = window.innerHeight * 0.75;
      const scale = Math.min(maxW / vp.width, maxH / vp.height, 2);
      const scaledVp = page.getViewport({ scale, rotation });
      setDisplaySize({ width: scaledVp.width, height: scaledVp.height });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = scaledVp.width; canvas.height = scaledVp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;
      pdf.destroy();
    })();
    return () => { cancelled = true; };
  }, [pdfBuffer, pageIndex, rotation]);

  const toPdf = useCallback((sx: number, sy: number) => ({ x: sx / scaleX, y: pageSize.height - sy / scaleY }), [scaleX, scaleY, pageSize.height]);
  const toScreen = useCallback((px: number, py: number) => ({ x: px * scaleX, y: (pageSize.height - py) * scaleY }), [scaleX, scaleY, pageSize.height]);

  const getPos = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  

  const hitTestAnnotation = (pos: { x: number; y: number }) => {
    for (const ann of [...annotations].reverse()) {
      const s = toScreen(ann.x, ann.y);
      const sw = ann.width * scaleX;
      const sh = ann.height * scaleY;
      if (pos.x >= s.x && pos.x <= s.x + sw && pos.y >= s.y - sh && pos.y <= s.y) {
        return ann;
      }
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!ready) return;
    const pos = getPos(e);
    const hitAnn = hitTestAnnotation(pos);

    if (hitAnn) {
      // All annotation types: use delayed drag (150ms hold) so we can drag placed signatures/stamps too
      const s = toScreen(hitAnn.x, hitAnn.y);
      const sh = hitAnn.height * scaleY;
      const offset = { x: pos.x - s.x, y: pos.y - (s.y - sh) };
      pendingDragRef.current = { id: hitAnn.id, offset };
      didStartDrag.current = false;
      dragDelayTimer.current = setTimeout(() => {
        didStartDrag.current = true;
        setDraggingId(hitAnn.id);
        setDragOffset(offset);
      }, 150);
      return;
    }

    // In signature mode, the page is read-only outside of placed signatures.
    if (mode === 'signature') return;

    // Clicked empty space — deselect if something selected, or place/draw
    if (selectedId) {
      setSelectedId(null);
      return;
    }
    setIsDrawing(true); setDrawStart(pos); setDrawCurrent(pos);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = getPos(e);


    if (draggingId) {
      setAnnotations(prev => prev.map(a => {
        if (a.id !== draggingId) return a;
        const pdf = toPdf(pos.x - dragOffset.x, pos.y - dragOffset.y + a.height * scaleY);
        return { ...a, x: Math.max(0, pdf.x), y: Math.max(0, pdf.y) };
      }));
      return;
    }
    if (isDrawing) setDrawCurrent(pos);
  };

  const handleMouseUp = () => {
    // Handle text drag delay cleanup
    if (dragDelayTimer.current) {
      clearTimeout(dragDelayTimer.current);
      dragDelayTimer.current = null;
    }
    if (pendingDragRef.current && !didStartDrag.current) {
      // Short click on text annotation — select it
      setSelectedId(pendingDragRef.current.id);
      pendingDragRef.current = null;
      return;
    }
    pendingDragRef.current = null;

    if (draggingId) { setDraggingId(null); return; }
    if (!isDrawing) return;
    setIsDrawing(false);
    const x1 = Math.min(drawStart.x, drawCurrent.x);
    const y1 = Math.min(drawStart.y, drawCurrent.y);
    const x2 = Math.max(drawStart.x, drawCurrent.x);
    const y2 = Math.max(drawStart.y, drawCurrent.y);
    const sw = x2 - x1;
    const sh = y2 - y1;

    if (mode === 'text') {
      const pdf = toPdf(drawStart.x, drawStart.y);
      setAnnotations(prev => [...prev, { id: crypto.randomUUID(), type: 'text', x: pdf.x, y: pdf.y, width: 200, height: newFontSize * 1.2, text: newText, fontSize: newFontSize, color: newColor }]);
    } else if (mode === 'highlight' && sw > 5 && sh > 5) {
      const topLeft = toPdf(x1, y2);
      setAnnotations(prev => [...prev, { id: crypto.randomUUID(), type: 'highlight', x: topLeft.x, y: topLeft.y, width: sw / scaleX, height: sh / scaleY, highlightColor, highlightOpacity }]);
    } else if (mode === 'stamp') {
      stampInputRef.current?.click();
    }
  };

  const scaleAnnotation = (annId: string, delta: number) => {
    setAnnotations(prev => prev.map(a => {
      if (a.id !== annId) return a;
      const ratio = a.width > 0 ? a.height / a.width : 1;
      const newW = Math.max(10, a.width + delta);
      const newH = Math.max(10, a.height + delta * ratio);
      const dx = (newW - a.width) / 2;
      const dy = (newH - a.height) / 2;
      return { ...a, width: newW, height: newH, x: a.x - dx, y: a.y + dy };
    }));
  };

  const handleStampFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const type = file.type.includes('png') ? 'png' as const : 'jpg' as const;
    const url = URL.createObjectURL(file);
    const img = document.createElement('img');
    await new Promise<void>(r => { img.onload = () => r(); img.src = url; });
    URL.revokeObjectURL(url);
    const maxDim = 150;
    const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    const pdf = toPdf(drawStart.x || displaySize.width / 2, drawStart.y || displaySize.height / 2);
    const imageKey = putImage(data, type);
    setAnnotations(prev => [...prev, { id: crypto.randomUUID(), type: 'stamp', x: pdf.x - w / 2, y: pdf.y - h / 2, width: w, height: h, imageKey, imageType: type }]);
  };

  const getSigPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = sigCanvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleSigDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = getSigPos(e);
    isSigDrawingRef.current = true;
    currentSigStrokeRef.current = [point];
    setIsSigDrawing(true);
    setCurrentSigStroke([point]);
  };
  const handleSigMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isSigDrawingRef.current) return;
    e.preventDefault();
    const next = [...currentSigStrokeRef.current, getSigPos(e)];
    currentSigStrokeRef.current = next;
    setCurrentSigStroke(next);
  };
  const handleSigUp = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isSigDrawingRef.current) return;
    e?.preventDefault();
    if (e?.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    isSigDrawingRef.current = false;
    setIsSigDrawing(false);
    const stroke = currentSigStrokeRef.current;
    if (stroke.length > 1) setSigPoints(prev => [...prev, stroke]);
    currentSigStrokeRef.current = [];
    setCurrentSigStroke([]);
  };

  useEffect(() => {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const allStrokes = [...sigPoints, ...(currentSigStroke.length > 1 ? [currentSigStroke] : [])];
    for (const stroke of allStrokes) {
      ctx.beginPath();
      stroke.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  }, [sigPoints, currentSigStroke]);

  const placeSignature = async () => {
    if (sigPoints.length === 0) return;
    const allPoints = sigPoints.flat();
    const pad = 8;
    const minX = Math.max(0, Math.floor(Math.min(...allPoints.map(p => p.x)) - pad));
    const minY = Math.max(0, Math.floor(Math.min(...allPoints.map(p => p.y)) - pad));
    const maxX = Math.min(300, Math.ceil(Math.max(...allPoints.map(p => p.x)) + pad));
    const maxY = Math.min(100, Math.ceil(Math.max(...allPoints.map(p => p.y)) + pad));
    const cropW = Math.max(1, maxX - minX);
    const cropH = Math.max(1, maxY - minY);
    const out = document.createElement('canvas');
    out.width = cropW; out.height = cropH;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of sigPoints) {
      ctx.beginPath();
      stroke.forEach((p, i) => i === 0 ? ctx.moveTo(p.x - minX, p.y - minY) : ctx.lineTo(p.x - minX, p.y - minY));
      ctx.stroke();
    }
    const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'));
    if (!blob) return;
    const data = new Uint8Array(await blob.arrayBuffer());
    const w = 150; const h = Math.max(24, Math.min(75, w * (cropH / cropW)));
    const cx = pageSize.width / 2; const cy = pageSize.height / 2;
    const imageKey = putImage(data, 'png');
    setAnnotations(prev => [...prev, { id: crypto.randomUUID(), type: 'signature', x: cx - w / 2, y: cy - h / 2, width: w, height: h, imageKey, imageType: 'png' }]);
    setSigPoints([]);
  };

  const removeAnnotation = (id: string) => setAnnotations(prev => prev.filter(a => a.id !== id));
  const handleSave = () => onSave(annotations);

  const stopAll = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };

  const renderSelectionToolbar = (ann: Annotation) => (
    <div
      onMouseDown={stopAll}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      style={{
        position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4,
        background: 'rgba(30,30,30,0.95)', borderRadius: 6, padding: '4px 8px',
        zIndex: 30, whiteSpace: 'nowrap',
      }}>
      <button onMouseDown={stopAll}
        onClick={(e) => { stopAll(e); scaleAnnotation(ann.id, -SCALE_STEP_PX); }}
        style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Minus size={12} />
      </button>
      <span style={{ color: 'white', fontSize: 11, minWidth: 30, textAlign: 'center' }}>
        {Math.round(ann.width)}×{Math.round(ann.height)}
      </span>
      <button onMouseDown={stopAll}
        onClick={(e) => { stopAll(e); scaleAnnotation(ann.id, SCALE_STEP_PX); }}
        style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Plus size={12} />
      </button>
      <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
      <button onMouseDown={stopAll}
        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onClick={(e) => { stopAll(e); removeAnnotation(ann.id); setSelectedId(null); }}
        style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(220,50,50,0.8)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Trash2 size={12} />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[1000] bg-black/85 flex flex-col items-center">
      <div className="flex items-center gap-4 p-4 flex-wrap justify-center">
        {mode === 'text' && (
          <>
            <Input value={newText} onChange={e => setNewText(e.target.value)} placeholder="Text" className="w-[200px] h-7 text-xs bg-white/10 border-white/20 text-white" />
            <div className="flex gap-1 items-center">
              <span className="text-white text-xs">Size: {newFontSize}</span>
              <div className="w-20">
                <Slider value={[newFontSize]} onValueChange={v => setNewFontSize(v[0])} min={8} max={48} step={1} />
              </div>
            </div>
            <ColorPalette colors={COLORS} active={newColor} onChange={setNewColor} />
            <span className="text-white/60 text-xs">Click to place text</span>
          </>
        )}
        {mode === 'highlight' && (
          <>
            <ColorPalette colors={HIGHLIGHT_COLORS} active={highlightColor} onChange={setHighlightColor} />
            <div className="flex gap-1 items-center">
              <span className="text-white text-xs">Opacity: {Math.round(highlightOpacity * 100)}%</span>
              <div className="w-20">
                <Slider value={[highlightOpacity]} onValueChange={v => setHighlightOpacity(v[0])} min={0.1} max={0.8} step={0.05} />
              </div>
            </div>
            <span className="text-white/60 text-xs">Draw rectangles to highlight</span>
          </>
        )}
        {mode === 'stamp' && (
          <>
            <Button variant="secondary" size="mini" onClick={() => stampInputRef.current?.click()}>
              <ImageIcon size={14} className="mr-1" /> Upload Image
            </Button>
            <span className="text-white/60 text-xs">Upload an image, then drag to reposition & resize</span>
            <input ref={stampInputRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) handleStampFile(e.target.files[0]); }} />
          </>
        )}
        {mode === 'signature' && <span className="text-white/60 text-xs">Draw your signature below, then place it on the page</span>}
        <span className="text-white/50">|</span>
        <span className="text-white text-xs">{annotations.filter(a => a.type === mode).length} {mode}(s)</span>
        <Button variant="secondary" size="mini" onClick={() => setAnnotations(prev => prev.filter(a => a.type !== mode))}>Clear {mode}s</Button>
        <Button size="mini" onClick={handleSave}>Save</Button>
        <Button variant="ghost" size="mini" onClick={onClose}><X size={16} className="text-white" /></Button>
      </div>

      {mode === 'signature' && (
        <div className="flex gap-4 items-center mb-4">
          <div className="bg-white rounded-lg border-2 border-white/30">
            <canvas ref={sigCanvasRef} width={300} height={100} className="cursor-crosshair block rounded-lg"
              onPointerDown={handleSigDown} onPointerMove={handleSigMove} onPointerUp={handleSigUp} onPointerCancel={handleSigUp} />
          </div>
          <div className="flex flex-col gap-1">
            <Button variant="secondary" size="mini" onClick={placeSignature} disabled={sigPoints.length === 0}>Place Signature</Button>
            <Button variant="ghost" size="mini" onClick={() => { if (sigPoints.length > 0) setSigPoints(prev => prev.slice(0, -1)); }}>
              <Undo2 size={12} className="mr-1" /> Undo Stroke
            </Button>
            <Button variant="ghost" size="mini" onClick={() => setSigPoints([])}>Clear Pad</Button>
          </div>
        </div>
      )}

      <div ref={containerRef} className="relative"
        style={{ cursor: mode === 'signature' ? 'default' : 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}>
        <canvas ref={canvasRef} className="block rounded" />
        {annotations.map(ann => {
          const s = toScreen(ann.x, ann.y);
          const sw = ann.width * scaleX;
          const sh = ann.height * scaleY;
          const screenTop = s.y - sh;
          const isActive = draggingId === ann.id;
          const isSelected = selectedId === ann.id;

          if (ann.type === 'text' && ann.text) {
            const fontSize = ann.fontSize || 16;
            const stopAll = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
            return (
              <div key={ann.id} style={{ position: 'absolute', left: s.x, top: screenTop, color: ann.color || '#000', fontSize: `${fontSize * scaleY}px`, fontFamily: 'Helvetica, Arial, sans-serif', whiteSpace: 'nowrap', cursor: isActive ? 'grabbing' : 'pointer', userSelect: 'none', outline: isSelected ? '1px dashed rgba(255,255,255,0.8)' : 'none', outlineOffset: 4, padding: '2px 4px' }}>
                {ann.text}
                {isSelected && (
                  <div
                    onMouseDown={stopAll}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                    style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(30,30,30,0.95)', borderRadius: 6, padding: '4px 8px', zIndex: 30, whiteSpace: 'nowrap' }}>
                    <button
                      onMouseDown={stopAll}
                      onClick={(e) => { stopAll(e); setAnnotations(prev => prev.map(a => a.id === ann.id ? { ...a, fontSize: Math.max(8, (a.fontSize || 16) - 2), height: Math.max(8, (a.fontSize || 16) - 2) * 1.2 } : a)); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 'bold' }}>
                      <Minus size={12} />
                    </button>
                    <span style={{ color: 'white', fontSize: 12, minWidth: 20, textAlign: 'center' }}>{fontSize}</span>
                    <button
                      onMouseDown={stopAll}
                      onClick={(e) => { stopAll(e); setAnnotations(prev => prev.map(a => a.id === ann.id ? { ...a, fontSize: Math.min(72, (a.fontSize || 16) + 2), height: Math.min(72, (a.fontSize || 16) + 2) * 1.2 } : a)); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 'bold' }}>
                      <Plus size={12} />
                    </button>
                    <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
                    <button
                      onMouseDown={stopAll}
                      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                      onClick={(e) => { stopAll(e); removeAnnotation(ann.id); setSelectedId(null); }}
                      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'rgba(220,50,50,0.8)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          }
          if (ann.type === 'highlight') {
            return (
              <div key={ann.id} style={{
                position: 'absolute', left: s.x, top: screenTop, width: sw, height: sh,
                backgroundColor: ann.highlightColor || '#FFFF00',
                opacity: isSelected ? 1 : (ann.highlightOpacity || 0.4),
                cursor: isActive ? 'grabbing' : 'pointer', borderRadius: 2,
                outline: isSelected ? '2px solid #4CAF7D' : 'none', outlineOffset: 2,
              }}>
                {isSelected && (
                  <div style={{ position: 'absolute', inset: 0, backgroundColor: ann.highlightColor || '#FFFF00', opacity: ann.highlightOpacity || 0.4, borderRadius: 2, pointerEvents: 'none' }} />
                )}
                {isSelected && renderSelectionToolbar(ann)}
              </div>
            );
          }
          // Resolve image bytes: imageKey first (current), legacy inline fields second.
          const imgBytes = ann.imageKey ? getImage(ann.imageKey)?.bytes
            : ann.type === 'stamp' ? ann.imageData : ann.signatureData;
          const imgType = ann.imageKey ? (getImage(ann.imageKey)?.type ?? 'png')
            : (ann.type === 'stamp' ? (ann.imageType ?? 'png') : 'png');
          if ((ann.type === 'stamp' || ann.type === 'signature') && imgBytes) {
            const mime = imgType === 'png' ? 'image/png' : 'image/jpeg';
            const blob = new Blob([imgBytes.buffer as ArrayBuffer], { type: mime });
            const url = URL.createObjectURL(blob);
            return (
              <div key={ann.id} style={{
                position: 'absolute', left: s.x, top: screenTop, width: sw, height: sh,
                cursor: isActive ? 'grabbing' : 'pointer',
                outline: isSelected ? '2px dashed rgba(76,175,125,0.8)' : 'none', outlineOffset: 4,
              }}>
                <img src={url} alt="" className="w-full h-full object-contain pointer-events-none" />
                {isSelected && renderSelectionToolbar(ann)}
              </div>
            );
          }
          return null;
        })}
        {isDrawing && mode === 'highlight' && (() => {
          const x = Math.min(drawStart.x, drawCurrent.x);
          const y = Math.min(drawStart.y, drawCurrent.y);
          const w = Math.abs(drawCurrent.x - drawStart.x);
          const h = Math.abs(drawCurrent.y - drawStart.y);
          return <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, backgroundColor: highlightColor, opacity: highlightOpacity, border: '1px dashed rgba(0,0,0,0.3)', pointerEvents: 'none' }} />;
        })()}
      </div>
    </div>
  );
};

export default AnnotationOverlay;

import { useCallback, useRef, useState } from 'react';

interface HistoryState<T> {
  current: T;
  set: (val: T | ((prev: T) => T)) => void;
  /** Update without pushing onto the undo stack (incidental/derived changes). */
  update: (val: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  /** Coalesce all set() calls until endCoalesce() into a single history entry. */
  beginCoalesce: () => void;
  endCoalesce: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory<T>(initial: T, maxHistory = 100): HistoryState<T> {
  const [current, setCurrent] = useState<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const coalesceRef = useRef<{ active: boolean; baseline: T | null }>({ active: false, baseline: null });
  // Re-render trigger for canUndo/canRedo recomputation
  const [, force] = useState(0);
  const tick = useCallback(() => force(v => v + 1), []);

  const set = useCallback((val: T | ((prev: T) => T)) => {
    setCurrent(prev => {
      const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val;
      if (Object.is(next, prev)) return prev;
      if (coalesceRef.current.active) {
        // First set inside a coalesce window: capture baseline; subsequent sets just update value
        if (coalesceRef.current.baseline === null) coalesceRef.current.baseline = prev;
      } else {
        pastRef.current = [...pastRef.current.slice(-(maxHistory - 1)), prev];
        futureRef.current = [];
      }
      return next;
    });
    tick();
  }, [maxHistory, tick]);

  const update = useCallback((val: T | ((prev: T) => T)) => {
    setCurrent(prev => {
      const next = typeof val === 'function' ? (val as (p: T) => T)(prev) : val;
      return Object.is(next, prev) ? prev : next;
    });
  }, []);

  const undo = useCallback(() => {
    setCurrent(prev => {
      if (pastRef.current.length === 0) return prev;
      const previous = pastRef.current[pastRef.current.length - 1];
      pastRef.current = pastRef.current.slice(0, -1);
      futureRef.current = [...futureRef.current, prev];
      return previous;
    });
    tick();
  }, [tick]);

  const redo = useCallback(() => {
    setCurrent(prev => {
      if (futureRef.current.length === 0) return prev;
      const next = futureRef.current[futureRef.current.length - 1];
      futureRef.current = futureRef.current.slice(0, -1);
      pastRef.current = [...pastRef.current, prev];
      return next;
    });
    tick();
  }, [tick]);

  const beginCoalesce = useCallback(() => {
    coalesceRef.current = { active: true, baseline: null };
  }, []);

  const endCoalesce = useCallback(() => {
    if (coalesceRef.current.active && coalesceRef.current.baseline !== null) {
      pastRef.current = [...pastRef.current.slice(-(maxHistory - 1)), coalesceRef.current.baseline];
      futureRef.current = [];
    }
    coalesceRef.current = { active: false, baseline: null };
    tick();
  }, [maxHistory, tick]);

  return {
    current,
    set,
    update,
    undo,
    redo,
    beginCoalesce,
    endCoalesce,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}

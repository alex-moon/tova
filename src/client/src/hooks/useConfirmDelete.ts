import { useCallback, useEffect, useRef, useState } from 'react';
import AuthService from '../services/auth';
import { useAuth } from './useAuth';

export type DeleteTarget = 'chat' | 'file';

type ConfirmState = {
  armedId: string | null;
  arm: (id: string) => void;
  onYes: () => void;
  onAlways: () => Promise<void>;
  onNo: () => void;
};

// Inline destructive-confirmation plumbing (issue #59). One instance per
// surface (Sidebar chat rows / AssetLibrary asset cards): the surfaces are
// disjoint, so a single armed id per surface is enough. Arm state resets on
// Escape; only one row is armed at a time.
export const useConfirmDelete = (
  target: DeleteTarget,
  deleteFn: (id: string) => void,
): ConfirmState => {
  const { user, updateUser } = useAuth();
  const [armedId, setArmedId] = useState<string | null>(null);
  // Synchronous mirror of armedId: the async "Always" path must be able to
  // tell whether the arm survived its in-flight PATCH. If the user hits No /
  // Escape (or arms another row) while the preference call is pending, the
  // cancellation must win and the delete must not fire.
  const armedIdRef = useRef<string | null>(null);
  const setArm = useCallback((id: string | null) => {
    armedIdRef.current = id;
    setArmedId(id);
  }, []);
  const confirmEnabled = user?.confirmDeletes?.[target] ?? true;

  const arm = useCallback(
    (id: string) => {
      if (confirmEnabled) {
        setArm(id);
      } else {
        deleteFn(id);
      }
    },
    [deleteFn, confirmEnabled, setArm],
  );

  const reset = useCallback(() => setArm(null), [setArm]);
  const runDelete = useCallback(
    (id: string) => {
      setArm(null);
      deleteFn(id);
    },
    [deleteFn, setArm],
  );

  const onYes = useCallback(() => {
    if (armedIdRef.current === null) return;
    runDelete(armedIdRef.current);
  }, [runDelete]);

  // "Always" persists the granular preference (confirm off for this target),
  // mirrors it into auth state, then deletes. If the preference PATCH fails
  // (offline blip), fall back to a plain delete so the row cannot strand in
  // confirm state.
  const onAlways = useCallback(async () => {
    const id = armedIdRef.current;
    if (id === null) return;
    try {
      const updated = await AuthService.updateProfile({ confirmDeletes: { [target]: false } });
      updateUser(updated);
    } catch {
      // Fall through to the delete below.
    }
    // Cancellation during the PATCH (No, Escape, another row armed) wins over
    // the pending delete.
    if (armedIdRef.current !== id) return;
    runDelete(id);
  }, [target, updateUser, runDelete]);

  useEffect(() => {
    if (armedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArm(null);
    };
    // Clicking anywhere outside the armed card (plan: "clicking elsewhere
    // restores the row") resets it without touching data. Another row's
    // trash click first lands here (reset), then arms the new row — so the
    // single-armed invariant holds.
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      const element = e.target.closest('[data-testid^="confirm-delete-"]');
      if (element) return;
      setArm(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [armedId, setArm]);

  return { armedId, arm, onYes, onAlways, onNo: reset };
};

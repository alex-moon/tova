import { useCallback, useEffect, useState } from 'react';
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

// Inline destructive-confirmation plumbing; one instance per surface, a single armed id per surface, Escape resets.
// @see #59
export const useConfirmDelete = (
  target: DeleteTarget,
  deleteFn: (id: string) => void,
): ConfirmState => {
  const { user, updateUser } = useAuth();
  const [armedId, setArmedId] = useState<string | null>(null);
  const confirmEnabled = user?.confirmDeletes?.[target] ?? true;

  const arm = useCallback(
    (id: string) => {
      if (confirmEnabled) {
        setArmedId(id);
      } else {
        deleteFn(id);
      }
    },
    [deleteFn, confirmEnabled],
  );

  const reset = useCallback(() => setArmedId(null), []);
  const runDelete = useCallback(
    (id: string) => {
      setArmedId(null);
      deleteFn(id);
    },
    [deleteFn],
  );

  const onYes = useCallback(() => {
    if (armedId === null) return;
    runDelete(armedId);
  }, [armedId, runDelete]);

  // "Always" persists the granular preference, mirrors it into auth state, then deletes; a failed PATCH falls back to a plain delete.
  const onAlways = useCallback(async () => {
    if (armedId === null) return;
    const id = armedId;
    try {
      const updated = await AuthService.updateProfile({ confirmDeletes: { [target]: false } });
      updateUser(updated);
    } catch {
      // Fall through to the delete below.
    }
    runDelete(id);
  }, [armedId, target, updateUser, runDelete]);

  useEffect(() => {
    if (armedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmedId(null);
    };
    // Outside clicks reset the armed row without touching data; another row's trash click resets here, then arms the new row.
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      const element = e.target.closest('[data-testid^="confirm-delete-"]');
      if (element) return;
      setArmedId(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [armedId]);

  return { armedId, arm, onYes, onAlways, onNo: reset };
};

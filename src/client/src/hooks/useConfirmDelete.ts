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

  // "Always" persists the granular preference (confirm off for this target),
  // mirrors it into auth state, then deletes. If the preference PATCH fails
  // (offline blip), fall back to a plain delete so the row cannot strand in
  // confirm state.
  const onAlways = useCallback(async () => {
    if (armedId === null) return;
    const id = armedId;
    try {
      const updated = await AuthService.updateProfile({ confirmDeletes: { [target]: false } });
      updateUser({
        ...updated,
        confirmDeletes: {
          chat: updated.confirmDeletes?.chat ?? true,
          file: updated.confirmDeletes?.file ?? true,
          ...(target === 'chat' ? { chat: false } : { file: false }),
        },
      });
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armedId]);

  return { armedId, arm, onYes, onAlways, onNo: reset };
};

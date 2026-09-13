import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import AuthService, { AuthError } from '../services/auth';
import { useAuth } from '../hooks/useAuth';

interface ProfileModalProps {
  onClose: () => void;
}

const PREFERRED_NAME_LIMIT = 100;
const SYSTEM_PROMPT_LIMIT = 4000;

const ProfileModal: React.FC<ProfileModalProps> = ({ onClose }) => {
  const { user, updateUser } = useAuth();
  const [preferredName, setPreferredName] = useState(user?.preferredName ?? '');
  const [systemPrompt, setSystemPrompt] = useState(user?.systemPrompt ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const displayName = user.preferredName ?? user.name ?? user.email;

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await AuthService.updateProfile({
        preferredName: preferredName.trim(),
        systemPrompt,
      });
      updateUser(next);
      onClose();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="profile-modal"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-xl font-semibold">Profile</h2>
          <Button variant="ghost" size="icon" aria-label="Close profile" onClick={onClose}>
            <X />
          </Button>
        </div>
        <dl className="mb-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Full name</dt>
            <dd data-testid="profile-name">{displayName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Avatar</dt>
            <dd className="truncate" data-testid="profile-avatar">
              {user.avatarUrl ? 'Set by Google' : 'None'}
            </dd>
          </div>
        </dl>
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block">Preferred name</span>
            <Input
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              maxLength={PREFERRED_NAME_LIMIT}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block">System prompt</span>
            <textarea
              data-testid="profile-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              maxLength={SYSTEM_PROMPT_LIMIT}
              rows={5}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            />
          </label>
        </div>
        {error && (
          <div
            data-testid="profile-error"
            className="mt-3 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending} data-testid="profile-save">
            {pending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ProfileModal;

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Theme } from '@/theme';
import AuthService, { AuthError } from '../services/auth';
import { persistTheme, resolveTheme } from '../theme';
import { useAuth } from '../hooks/useAuth';
import McpServersSection from './McpServersSection';

const PREFERRED_NAME_LIMIT = 20;
const CUSTOM_INSTRUCTIONS_LIMIT = 4000;
// Must match the server-side literal (issue #143) exactly: a typo simply
// disables the destructive button, so there is no other failure path.
const FACTORY_RESET_CONFIRM = 'RESET';

const ThemeChoice: React.FC<{
  value: Theme;
  onChange: (next: Theme) => void;
}> = ({ value, onChange }) => (
  <div className="flex gap-2" role="radiogroup" aria-label="Theme">
    {(['light', 'dark'] as Theme[]).map((option) => (
      <button
        key={option}
        type="button"
        role="radio"
        aria-checked={value === option}
        data-testid={`theme-option-${option}`}
        onClick={() => onChange(option)}
        className={`rounded-lg border px-3 py-1.5 text-sm capitalize transition-colors ${
          value === option
            ? 'border-ring bg-accent text-accent-foreground'
            : 'border-border hover:bg-accent hover:text-accent-foreground'
        }`}
      >
        {option}
      </button>
    ))}
  </div>
);

const StartupChatChoice: React.FC<{
  value: 'recent' | 'new';
  onChange: (next: 'recent' | 'new') => void;
}> = ({ value, onChange }) => (
  <div className="flex gap-2" role="radiogroup" aria-label="When Tova opens">
    {(
      [
        ['recent', 'Most recent chat'],
        ['new', 'New chat'],
      ] as const
    ).map(([option, label]) => (
      <button
        key={option}
        type="button"
        role="radio"
        aria-checked={value === option}
        data-testid={`startup-chat-option-${option}`}
        onClick={() => onChange(option)}
        className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
          value === option
            ? 'border-ring bg-accent text-accent-foreground'
            : 'border-border hover:bg-accent hover:text-accent-foreground'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
);

const ProfileView = () => {
  const { user, updateUser } = useAuth();
  const initialTheme = (
    user?.theme === 'light' || user?.theme === 'dark' ? user.theme : resolveTheme()
  ) as Theme;
  const [preferredName, setPreferredName] = useState(user?.preferredName ?? '');
  const [customInstructions, setCustomInstructions] = useState(user?.customInstructions ?? '');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Startup-chat preference (issue #96): null/absent resolves to the product
  // default 'recent'.
  const initialStartupChat = user?.startupChat ?? 'recent';
  const [startupChat, setStartupChat] = useState<'recent' | 'new'>(initialStartupChat);
  const initialConfirmDeletes = {
    chat: user?.confirmDeletes?.chat ?? true,
    file: user?.confirmDeletes?.file ?? true,
  };
  const [confirmDeletes, setConfirmDeletes] = useState(initialConfirmDeletes);
  // Zero-data retention (issue #116): off unless the account explicitly
  // enabled it; enabling is forward-looking — saved chats stay until deleted.
  const initialZdr = Boolean(user?.zdr);
  const [zdr, setZdr] = useState(initialZdr);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Factory reset (issue #143): enabled only on the exact typed match, and the
  // server enforces it too — the client check is just UX.
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetting, setResetting] = useState(false);

  if (!user) return null;

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      const { failedObjects } = await AuthService.factoryReset(resetConfirm);
      if (failedObjects.length > 0) {
        toast.warning(`Factory reset: ${failedObjects.length} stored file(s) could not be deleted`);
      } else {
        toast.success('Factory reset complete');
      }
      // Full reload so every piece of app state re-reads the now-empty data.
      window.location.reload();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong.');
      setResetting(false);
    }
  };

  const displayName = user.preferredName ?? user.name ?? user.email;

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await AuthService.updateProfile({
        preferredName: preferredName.trim(),
        customInstructions,
        // Only patched when the choice actually moved, so a plain profile
        // edit cannot silently pin the device's theme onto the account.
        ...(theme !== initialTheme ? { theme } : {}),
        // Only patched when the choice actually moved (issue #96).
        ...(startupChat !== initialStartupChat ? { startupChat } : {}),
        // Only patched when a toggle moved, so an unrelated profile edit
        // cannot touch delete-confirmation prefs (issue #59).
        ...(confirmDeletes.chat !== initialConfirmDeletes.chat ||
        confirmDeletes.file !== initialConfirmDeletes.file
          ? { confirmDeletes }
          : {}),
        ...(zdr !== initialZdr ? { zdr } : {}),
      });
      // The saved choice rides the mirror immediately so pre-auth pages and
      // reloads paint it without waiting on the profile round-trip.
      if (theme !== initialTheme) persistTheme(theme);
      updateUser(next);
      // A view cannot "close" on save like the old modal did: stay on
      // /profile and confirm with a toast instead.
      toast.success('Profile saved');
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="profile-view"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      <div className="shrink-0 px-6 pt-6">
        <h2 className="font-heading text-xl font-semibold">Profile</h2>
        {error && (
          <div
            data-testid="profile-error"
            className="mt-3 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
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
          <div className="text-sm">
            <span className="mb-1 block">Theme</span>
            <ThemeChoice value={theme} onChange={setTheme} />
          </div>
          <div className="text-sm">
            <span className="mb-1 block">When Tova opens</span>
            <StartupChatChoice value={startupChat} onChange={setStartupChat} />
          </div>
          <label className="block text-sm">
            <span className="mb-1 block">Custom instructions</span>
            <textarea
              data-testid="profile-custom-instructions"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              maxLength={CUSTOM_INSTRUCTIONS_LIMIT}
              rows={5}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            />
          </label>
          <McpServersSection />
          <fieldset className="text-sm">
            <legend className="mb-1 block">Delete confirmations</legend>
            {(['chat', 'file'] as const).map((target) => (
              <label key={target} className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`profile-confirm-delete-${target}`}
                  checked={confirmDeletes[target]}
                  onChange={(e) =>
                    setConfirmDeletes((prev) => ({ ...prev, [target]: e.target.checked }))
                  }
                />
                Ask before deleting {target === 'chat' ? 'chats' : 'files'}
              </label>
            ))}
          </fieldset>
          <fieldset className="text-sm" data-testid="profile-privacy">
            <legend className="mb-1 block">Privacy</legend>
            <p className="mb-2 text-muted-foreground">
              Your chats and files are never used to train models — by anyone, ever.
            </p>
            <label className="mt-1 flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="profile-zdr"
                checked={zdr}
                onChange={(e) => setZdr(e.target.checked)}
              />
              Zero data retention
            </label>
            <p className="mt-1 text-muted-foreground">
              When on, nothing sent or attached in chat is stored — chats and attached files vanish
              when the conversation ends. Files uploaded in Assets are kept so you can reuse them;
              they are deleted only when you delete them.
            </p>
          </fieldset>
          <fieldset className="text-sm" data-testid="profile-danger-zone">
            <legend className="mb-1 block">Danger zone</legend>
            <p className="mb-2 text-muted-foreground">
              Factory reset permanently wipes every chat, message, uploaded file and derived trace
              for this account. Nothing survives — type {FACTORY_RESET_CONFIRM} to confirm.
            </p>
            <div className="flex items-center gap-2">
              <Input
                data-testid="profile-reset-confirm"
                placeholder={FACTORY_RESET_CONFIRM}
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                className="max-w-40"
              />
              <Button
                variant="destructive"
                data-testid="profile-factory-reset"
                disabled={resetConfirm !== FACTORY_RESET_CONFIRM || resetting}
                onClick={reset}
              >
                {resetting ? 'Resetting...' : 'Factory reset'}
              </Button>
            </div>
          </fieldset>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={save} disabled={pending} data-testid="profile-save">
            {pending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ProfileView;

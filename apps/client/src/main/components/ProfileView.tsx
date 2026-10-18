import React, { useState } from 'react';
import { toast } from 'sonner';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Theme } from '@/theme';
import AuthService, { AuthError } from '../services/auth';
import { persistTheme, resolveTheme } from '../theme';
import { useAuth } from '../hooks/useAuth';

const PREFERRED_NAME_LIMIT = 20;
const CUSTOM_INSTRUCTIONS_LIMIT = 4000;
// Must match the server literal exactly; a typo just disables the button.
// @see #143
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
  // Null/absent resolves to the product default 'recent'.
  // @see #96
  const initialStartupChat = user?.startupChat ?? 'recent';
  const [startupChat, setStartupChat] = useState<'recent' | 'new'>(initialStartupChat);
  const initialConfirmDeletes = {
    chat: user?.confirmDeletes?.chat ?? true,
    file: user?.confirmDeletes?.file ?? true,
  };
  const [confirmDeletes, setConfirmDeletes] = useState(initialConfirmDeletes);
  // Profile alias of the account's incognito flag; forward-looking.
  // @see #144
  const initialIncognito = Boolean(user?.incognitoByDefault ?? user?.zdr);
  const [incognito, setIncognito] = useState(initialIncognito);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enabled only on the exact typed match; the server enforces it too.
  // @see #143
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
        // Let the warning be readable before the full reload clears the view.
        window.setTimeout(() => window.location.reload(), 5000);
        return;
      }
      toast.success('Factory reset complete');
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
        // Only patched when the choice moved, so an edit cannot pin the theme.
        ...(theme !== initialTheme ? { theme } : {}),
        // @see #96
        ...(startupChat !== initialStartupChat ? { startupChat } : {}),
        // Only patched when a toggle moved; an edit can't touch delete prefs.
        // @see #59
        ...(confirmDeletes.chat !== initialConfirmDeletes.chat ||
        confirmDeletes.file !== initialConfirmDeletes.file
          ? { confirmDeletes }
          : {}),
        ...(incognito !== initialIncognito ? { incognitoByDefault: incognito } : {}),
      });
      // The saved choice mirrors immediately so reloads paint it at once.
      if (theme !== initialTheme) persistTheme(theme);
      updateUser(next);
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
      <div className="shrink-0 px-6">
        <div className="flex h-14 items-center">
          <h2 className="font-heading text-xl font-semibold">Profile</h2>
        </div>
        {error && (
          <div
            data-testid="profile-error"
            className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6 ambient-wash recessed-frame">
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
          <a
            href="/connectors"
            data-testid="profile-connectors-link"
            className="flex items-center justify-between rounded-lg border border-border p-3 text-sm transition-colors hover:bg-accent"
          >
            <span>
              <span className="block font-medium">Connectors</span>
              <span className="block text-xs text-muted-foreground">
                Link your services — Notion, Slack, Dropbox and more.
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </a>
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
                data-testid="profile-incognito"
                checked={incognito}
                onChange={(e) => setIncognito(e.target.checked)}
              />
              Incognito by default
            </label>
            <p className="mt-1 text-muted-foreground">
              When on, nothing sent or attached in chat is stored — chats and attached files vanish
              when the conversation ends. Files uploaded in Assets are kept so you can reuse them;
              they are deleted only when you delete them. New chats are incognito. In an incognito
              chat, nothing sent or attached is stored — it vanishes when the conversation ends.
              Files uploaded in Assets are kept so you can reuse them; they are deleted only when
              you delete them.
              {incognito ? ' Turning this on removes your existing chats from storage.' : ''}
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
      </div>
      {/* Pinned below the scroll pane so Save stays reachable regardless of scroll position. */}
      {/* @see #191 */}
      <div className="flex shrink-0 justify-end border-t border-border px-6 py-3 panel-surface">
        <Button onClick={save} disabled={pending} data-testid="profile-save">
          {pending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
};

export default ProfileView;

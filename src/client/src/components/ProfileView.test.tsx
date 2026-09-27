import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AuthContext } from '../context/AuthContext';
import ProfileView from './ProfileView';
import { AuthError } from '../services/auth';
import { COOKIE_NAME, STORAGE_KEY } from '../theme';
import { toast } from 'sonner';
import type { User } from '../context/AuthContext';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

const updateProfile = vi.fn();
const factoryReset = vi.fn();

vi.mock('../services/auth', () => ({
  default: {
    updateProfile: (...args: unknown[]) => updateProfile(...args),
    factoryReset: (...args: unknown[]) => factoryReset(...args),
  },
  AuthError: class AuthError extends Error {
    name = 'AuthError';
  },
}));

const renderWithUser = (user: User, updateUser = vi.fn()) => {
  render(
    <AuthContext.Provider
      value={{
        user,
        loading: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        updateUser,
      }}
    >
      <ProfileView />
    </AuthContext.Provider>,
  );
  return { updateUser };
};

const user: User = {
  id: '1',
  email: 'a@b.c',
  role: 'user',
  permissions: [],
  name: 'Alex Moon',
  preferredName: 'Al',
  customInstructions: 'Be terse.',
};

const avatarUser: User = { ...user, avatarUrl: 'https://example.com/a.png' };

describe('ProfileView (issue #95)', () => {
  beforeEach(() => {
    updateProfile.mockReset();
  });

  afterEach(cleanup);

  it('renders prefilled from the context user', () => {
    renderWithUser(avatarUser);
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Al');
    expect(screen.getByTestId('profile-avatar')).toHaveTextContent('Set by Google');
    const nameInput = screen.getByLabelText(/preferred name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Al');
    const promptInput = screen.getByTestId('profile-custom-instructions') as HTMLTextAreaElement;
    expect(promptInput.value).toBe('Be terse.');
  });

  it('sends the trimmed PATCH payload and pushes the response into context', async () => {
    const next: User = { ...user, preferredName: 'Friendly Al' };
    updateProfile.mockResolvedValue(next);
    const { updateUser } = renderWithUser(user);

    fireEvent.change(screen.getByLabelText(/preferred name/i), {
      target: { value: '  Friendly Al  ' },
    });
    fireEvent.click(screen.getByTestId('profile-save'));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        preferredName: 'Friendly Al',
        customInstructions: 'Be terse.',
      }),
    );
    expect(updateUser).toHaveBeenCalledWith(next);
  });

  it('disables Save while a save is in flight and re-enables it after a failure', async () => {
    updateProfile.mockRejectedValue(new AuthError('Too long'));
    renderWithUser(user, vi.fn());

    fireEvent.click(screen.getByTestId('profile-save'));
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    expect(screen.getByTestId('profile-save')).toHaveTextContent('Saving...');

    await waitFor(() => expect(screen.getByTestId('profile-save')).toHaveTextContent(/^Save$/));
    expect(screen.getByTestId('profile-save')).not.toBeDisabled();
  });

  it('stays on /profile and confirms with a toast after a successful save (#95)', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser(user);

    fireEvent.click(screen.getByTestId('profile-save'));

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Profile saved'));
    expect(screen.getByTestId('profile-view')).toBeInTheDocument();
  });

  it('sends an empty string to clear a blanked field', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser(user, vi.fn());

    fireEvent.change(screen.getByTestId('profile-custom-instructions'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('profile-save'));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        preferredName: 'Al',
        customInstructions: '',
      }),
    );
  });

  it('patches confirmDeletes when a toggle moved and keeps unrelated edits out of it (#59)', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser(user);

    // Unchanged — a plain profile edit must not touch the pref.
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile).toHaveBeenLastCalledWith({
      preferredName: 'Al',
      customInstructions: 'Be terse.',
    });

    fireEvent.click(screen.getByTestId('profile-confirm-delete-chat'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith({
        preferredName: 'Al',
        customInstructions: 'Be terse.',
        confirmDeletes: { chat: false, file: true },
      }),
    );
  });

  it('writes the theme mirror when a changed theme saves successfully (#95)', async () => {
    updateProfile.mockResolvedValue(user);
    localStorage.clear();
    document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`;
    renderWithUser(user);

    fireEvent.click(screen.getByTestId('theme-option-dark'));
    fireEvent.click(screen.getByTestId('profile-save'));

    await waitFor(() => expect(screen.getByTestId('profile-save')).toHaveTextContent(/^Save$/));
    expect(document.cookie).toContain(`${COOKIE_NAME}=dark`);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('shows the API error and keeps the view open', async () => {
    updateProfile.mockRejectedValue(new AuthError('Too long'));
    renderWithUser(user, vi.fn());

    fireEvent.click(screen.getByTestId('profile-save'));

    expect(await screen.findByTestId('profile-error')).toHaveTextContent('Too long');
    expect(screen.getByTestId('profile-view')).toBeInTheDocument();
  });

  it('falls back to a generic message for non-AuthError failures', async () => {
    updateProfile.mockRejectedValue(new Error('boom'));
    renderWithUser(user, vi.fn());

    fireEvent.click(screen.getByTestId('profile-save'));

    expect(await screen.findByTestId('profile-error')).toHaveTextContent('Something went wrong.');
    expect(screen.getByTestId('profile-view')).toBeInTheDocument();
  });
});

describe('ProfileView theme choice (issue #53)', () => {
  beforeEach(() => {
    updateProfile.mockReset();
    // resolveTheme() reads the theme cookie and localStorage; both persist
    // across tests in this file (jsdom keeps them module-wide), so reset them.
    localStorage.clear();
    document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`;
  });

  afterEach(cleanup);

  it('saves a changed theme through the patch and keeps an unchanged choice out of it', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser(user);

    // Unchanged (light from resolveTheme) — a Save must not pin a theme.
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile).toHaveBeenLastCalledWith({
      preferredName: 'Al',
      customInstructions: 'Be terse.',
    });

    // Flipping to dark patches the theme.
    fireEvent.click(screen.getByTestId('theme-option-dark'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith({
        preferredName: 'Al',
        customInstructions: 'Be terse.',
        theme: 'dark',
      }),
    );
  });

  it('uses the admin-view substrate: non-scrolling root, scroller body, pinned header (#95)', () => {
    renderWithUser(avatarUser);

    const root = screen.getByTestId('profile-view');
    expect(root).toHaveClass('flex', 'h-full', 'w-full', 'flex-col');
    expect(root).not.toHaveClass('overflow-y-auto');

    // Body: the single overflow scroller holds the form.
    const scroller = root.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass('flex-1', 'min-h-0');
    expect(scroller).toContainElement(screen.getByTestId('profile-custom-instructions'));

    // Action bar (#191): the save button is pinned *outside* the scroller so it
    // stays reachable regardless of scroll position.
    const saveButton = screen.getByTestId('profile-save');
    expect(scroller!.contains(saveButton)).toBe(false);
    const actionBar = saveButton.closest('.shrink-0');
    expect(actionBar).not.toBeNull();
    expect(scroller!.contains(actionBar!)).toBe(false);

    // Header: pinned above the scroller, not inside it.
    const header = screen.getByText('Profile').closest('.shrink-0');
    expect(header).not.toBeNull();
    expect(header).toHaveClass('shrink-0');
    expect(scroller!.contains(header!)).toBe(false);
  });

  it('marks the active choice via aria-checked', () => {
    renderWithUser(user);

    expect(screen.getByTestId('theme-option-light')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByTestId('theme-option-dark'));
    expect(screen.getByTestId('theme-option-light')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('ProfileView startup choice (issue #96)', () => {
  beforeEach(() => {
    updateProfile.mockReset();
  });

  afterEach(cleanup);

  it('seeds "recent" when the user never saved a choice and omits an unchanged one', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser(user);

    expect(screen.getByTestId('startup-chat-option-recent')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile).toHaveBeenLastCalledWith({
      preferredName: 'Al',
      customInstructions: 'Be terse.',
    });
  });

  it('patches startupChat when it moves and keeps unrelated edits out of it', async () => {
    updateProfile.mockResolvedValue(user);
    renderWithUser({ ...user, startupChat: 'new' });

    // Seeded to 'new'; saving without touching it must not patch the key.
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(updateProfile).toHaveBeenLastCalledWith({
      preferredName: 'Al',
      customInstructions: 'Be terse.',
    });

    fireEvent.click(screen.getByTestId('startup-chat-option-recent'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith({
        preferredName: 'Al',
        customInstructions: 'Be terse.',
        startupChat: 'recent',
      }),
    );
  });
});

describe('ProfileView factory reset (issue #143)', () => {
  beforeEach(() => {
    updateProfile.mockReset();
    factoryReset.mockReset();
  });

  afterEach(cleanup);

  it('keeps the destructive button disabled until the exact confirm string is typed', () => {
    renderWithUser(user);

    expect(screen.getByTestId('profile-factory-reset')).toBeDisabled();
    fireEvent.change(screen.getByTestId('profile-reset-confirm'), { target: { value: 'reset' } });
    expect(screen.getByTestId('profile-factory-reset')).toBeDisabled();
    fireEvent.change(screen.getByTestId('profile-reset-confirm'), { target: { value: 'RESET' } });
    expect(screen.getByTestId('profile-factory-reset')).not.toBeDisabled();
    expect(factoryReset).not.toHaveBeenCalled();
  });

  it('POSTs the typed confirm string and confirms with a toast on success', async () => {
    factoryReset.mockResolvedValue({ reset: true, failedObjects: [] });
    renderWithUser(user);

    fireEvent.change(screen.getByTestId('profile-reset-confirm'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByTestId('profile-factory-reset'));

    await waitFor(() => expect(factoryReset).toHaveBeenCalledWith('RESET'));
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Factory reset complete'),
    );
    expect(screen.getByTestId('profile-factory-reset')).toBeDisabled();
  });

  it('warns (not success) when stored file deletions failed', async () => {
    factoryReset.mockResolvedValue({ reset: true, failedObjects: ['k1', 'k2'] });
    renderWithUser(user);

    fireEvent.change(screen.getByTestId('profile-reset-confirm'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByTestId('profile-factory-reset'));

    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        'Factory reset: 2 stored file(s) could not be deleted',
      ),
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('shows the API error and keeps the view open when the server refuses', async () => {
    factoryReset.mockRejectedValue(new AuthError('Type RESET to confirm the factory reset'));
    renderWithUser(user);

    fireEvent.change(screen.getByTestId('profile-reset-confirm'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByTestId('profile-factory-reset'));

    expect(await screen.findByTestId('profile-error')).toHaveTextContent(
      'Type RESET to confirm the factory reset',
    );
    expect(screen.getByTestId('profile-view')).toBeInTheDocument();
  });
});

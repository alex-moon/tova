import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AuthContext } from '../context/AuthContext';
import ProfileModal from './ProfileModal';
import { AuthError } from '../services/auth';
import type { User } from '../context/AuthContext';
import { COOKIE_NAME } from '../theme';

const updateProfile = vi.fn();

vi.mock('../services/auth', () => ({
  default: {
    updateProfile: (...args: unknown[]) => updateProfile(...args),
  },
  AuthError: class AuthError extends Error {
    name = 'AuthError';
  },
}));

const renderWithUser = (user: User, updateUser = vi.fn()) => {
  const onClose = vi.fn();
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
      <ProfileModal onClose={onClose} />
    </AuthContext.Provider>,
  );
  return { updateUser, onClose };
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

describe('ProfileModal (issue #35)', () => {
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
    const { updateUser, onClose } = renderWithUser(user);

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
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateUser).toHaveBeenCalledWith(next);
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

  it('shows the API error and keeps the modal open', async () => {
    updateProfile.mockRejectedValue(new AuthError('Too long'));
    renderWithUser(user, vi.fn());

    fireEvent.click(screen.getByTestId('profile-save'));

    expect(await screen.findByTestId('profile-error')).toHaveTextContent('Too long');
    expect(screen.getByTestId('profile-modal')).toBeInTheDocument();
  });

  it('falls back to a generic message for non-AuthError failures', async () => {
    updateProfile.mockRejectedValue(new Error('boom'));
    renderWithUser(user, vi.fn());

    fireEvent.click(screen.getByTestId('profile-save'));

    expect(await screen.findByTestId('profile-error')).toHaveTextContent('Something went wrong.');
    expect(screen.getByTestId('profile-modal')).toBeInTheDocument();
  });
});

describe('ProfileModal theme choice (issue #53)', () => {
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

  it('keeps the body in a scrollable region inside a height-capped panel (issue #79)', () => {
    renderWithUser(avatarUser);

    const overlay = screen.getByTestId('profile-modal');
    expect(overlay).toHaveClass('p-4');

    // Panel: height-capped flex column, so the body can scroll instead of clipping.
    const name = screen.getByTestId('profile-name');
    const panel = name.closest('.max-h-\\[85dvh\\]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('flex', 'flex-col');

    // Body: overflow scroller between the pinned header and the pinned footer.
    const scroller = name.closest('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass('flex-1');
    expect(panel!.contains(scroller)).toBe(true);
    expect(scroller).toContainElement(screen.getByTestId('profile-save'));
    expect(screen.getByLabelText(/close profile/i)).toBe(
      panel!.querySelector('.shrink-0')?.querySelector('button'),
    );
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

describe('ProfileModal startup choice (issue #96)', () => {
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

  it('marks the active choice via aria-checked', () => {
    renderWithUser(user);

    fireEvent.click(screen.getByTestId('startup-chat-option-new'));
    expect(screen.getByTestId('startup-chat-option-recent')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByTestId('startup-chat-option-new')).toHaveAttribute('aria-checked', 'true');
  });
});

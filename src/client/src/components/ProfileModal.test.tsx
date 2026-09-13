import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AuthContext } from '../context/AuthContext';
import ProfileModal from './ProfileModal';
import { AuthError } from '../services/auth';
import type { User } from '../context/AuthContext';

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

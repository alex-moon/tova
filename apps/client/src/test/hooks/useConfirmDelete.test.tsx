import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { useConfirmDelete } from '../../main/hooks/useConfirmDelete';
import { AuthContext } from '../../main/context/AuthContext';
import type { User } from '../../main/context/AuthContext';

vi.mock('../../main/services/auth', () => ({
  default: { updateProfile: vi.fn() },
}));

import AuthServiceMod from '../../main/services/auth';

const Harness: React.FC<{
  target: 'chat' | 'file';
  deleteFn: (id: string) => void;
  user: User | null;
  updateUser?: (u: User) => void;
}> = ({ target, deleteFn, user, updateUser }) => (
  <AuthContext.Provider
    value={{
      user,
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      updateUser: updateUser ?? vi.fn(),
    }}
  >
    {user && <Inner target={target} deleteFn={deleteFn} />}
  </AuthContext.Provider>
);

const Inner: React.FC<{ target: 'chat' | 'file'; deleteFn: (id: string) => void }> = ({
  target,
  deleteFn,
}) => {
  const { armedId, arm, onYes, onAlways, onNo } = useConfirmDelete(target, deleteFn);
  // Container mirrors the real armed card's data-testid so the hook's
  // pointerdown `closest('[data-testid^="confirm-delete-"]')` guard is
  // exercised through the same path the components use.
  return (
    <div data-testid={armedId ? `confirm-delete-${target}-${armedId}` : 'unarmed'}>
      <div data-testid="armed">{armedId ?? 'none'}</div>
      <button type="button" onClick={() => arm('u1')}>
        arm
      </button>
      <button type="button" onClick={() => arm('u2')}>
        arm-two
      </button>
      <button type="button" onClick={onYes}>
        yes
      </button>
      <button type="button" onClick={() => void onAlways()}>
        always
      </button>
      <button type="button" onClick={onNo}>
        no
      </button>
    </div>
  );
};

const user = (confirmDeletes?: { chat: boolean; file: boolean }): User => ({
  id: 'u1',
  email: 'a@b.c',
  role: 'user',
  permissions: [],
  confirmDeletes,
});

const renderHarness = (opts: {
  target: 'chat' | 'file';
  deleteFn: (id: string) => void;
  user: User | null;
  updateUser?: (u: User) => void;
}) =>
  render(
    <Harness
      target={opts.target}
      deleteFn={opts.deleteFn}
      user={opts.user}
      updateUser={opts.updateUser}
    />,
  );

describe('useConfirmDelete (issue #59)', () => {
  afterEach(cleanup);

  it('arm → yes deletes and clears arm state', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u1');
    fireEvent.click(screen.getByRole('button', { name: 'yes' }));
    expect(deleteFn).toHaveBeenCalledWith('u1');
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
  });

  it('arm → no clears arm state without deleting', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    fireEvent.click(screen.getByRole('button', { name: 'no' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('arm → always persists the preference then deletes', async () => {
    vi.mocked(AuthServiceMod.updateProfile).mockResolvedValue({
      ...user({ chat: false, file: true }),
    });
    const deleteFn = vi.fn();
    const updateUser = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user(), updateUser });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'always' }));
    });
    expect(AuthServiceMod.updateProfile).toHaveBeenCalledWith({ confirmDeletes: { chat: false } });
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ confirmDeletes: { chat: false, file: true } }),
    );
    expect(deleteFn).toHaveBeenCalledWith('u1');
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
  });

  it('always falls back to a plain delete when the PATCH fails', async () => {
    vi.mocked(AuthServiceMod.updateProfile).mockRejectedValue(new Error('offline'));
    const deleteFn = vi.fn();
    renderHarness({ target: 'file', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'always' }));
    });
    expect(deleteFn).toHaveBeenCalledWith('u1');
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
  });

  it('deletes immediately when the granular preference is off', () => {
    const deleteFn = vi.fn();
    renderHarness({
      target: 'file',
      deleteFn,
      user: user({ chat: true, file: false }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(deleteFn).toHaveBeenCalledWith('u1');
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
  });

  it('Escape disarms instead of deleting', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u1');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('pointerdown outside the armed card disarms instead of deleting', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u1');
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('armed')).toHaveTextContent('none');
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('pointerdown inside the armed card does not disarm', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'file', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u1');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'yes' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u1');
    fireEvent.click(screen.getByRole('button', { name: 'yes' }));
    expect(deleteFn).toHaveBeenCalledWith('u1');
  });

  it('arming another row switches the armed id (single-armed invariant)', () => {
    const deleteFn = vi.fn();
    renderHarness({ target: 'chat', deleteFn, user: user() });
    fireEvent.click(screen.getByRole('button', { name: 'arm' }));
    fireEvent.click(screen.getByRole('button', { name: 'arm-two' }));
    expect(screen.getByTestId('armed')).toHaveTextContent('u2');
    expect(screen.getByTestId('confirm-delete-chat-u2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'yes' }));
    expect(deleteFn).toHaveBeenCalledWith('u2');
    expect(deleteFn).not.toHaveBeenCalledWith('u1');
  });
});

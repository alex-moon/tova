import { decideTurn } from '../../main/services/zdrTurn';

describe('decideTurn (#144)', () => {
  const noSession = { incognito: false, sessionId: undefined };

  it('non-incognito turn persists normally with no cleanup', () => {
    expect(decideTurn(noSession)).toEqual({
      reject: false,
      persistWithHistoryReplay: false,
      requireEphemeralCleanup: false,
    });
  });

  it('non-incognito turn into a persisted chat persists normally', () => {
    expect(decideTurn({ incognito: false, sessionId: 'abc' })).toEqual({
      reject: false,
      persistWithHistoryReplay: false,
      requireEphemeralCleanup: false,
    });
  });

  it('incognito turn with no session suppresses persistence and requires cleanup', () => {
    expect(decideTurn({ incognito: true, sessionId: undefined })).toEqual({
      reject: false,
      persistWithHistoryReplay: true,
      requireEphemeralCleanup: true,
    });
  });

  it('incognito turn into a persisted chat is rejected', () => {
    expect(decideTurn({ incognito: true, sessionId: 'abc' })).toEqual({ reject: true });
  });

  // Only a truthy sessionId means "continuing a chat"; '' is the un-filled new-chat field.
  // @see #144
  it('incognito turn with an empty-string sessionId is treated as a new chat', () => {
    expect(decideTurn({ incognito: true, sessionId: '' })).toEqual({
      reject: false,
      persistWithHistoryReplay: true,
      requireEphemeralCleanup: true,
    });
  });

  it('any truthy sessionId string result (e.g. whitespace) rejects', () => {
    expect(decideTurn({ incognito: true, sessionId: ' ' })).toEqual({ reject: true });
  });
});

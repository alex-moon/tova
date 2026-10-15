import {
  EMBEDDING_MAX_CHARS,
  embeddingTextHash,
  truncateForEmbedding,
  withEmbedTitle,
  workspaceSliceText,
} from './workspaceEmbeddingText';

/*
 * #294: the shared embed-text derivation must match `collectWorkspaceSlices`
 * exactly; the hash is what makes the backfill idempotent.
 */

describe('workspaceSliceText (#294)', () => {
  it('derives chat text from the message content', () => {
    expect(workspaceSliceText({ kind: 'chat', content: '  hello there  ' })).toBe('hello there');
    expect(workspaceSliceText({ kind: 'chat', content: null })).toBe('');
  });

  it('prefers markdownExtracted over textExtracted for a file, then falls back', () => {
    expect(
      workspaceSliceText({ kind: 'file', markdownExtracted: '# Doc', textExtracted: 'raw' }),
    ).toBe('# Doc');
    expect(workspaceSliceText({ kind: 'file', markdownExtracted: '', textExtracted: 'raw' })).toBe(
      'raw',
    );
    expect(workspaceSliceText({ kind: 'file', markdownExtracted: null, textExtracted: null })).toBe(
      '',
    );
  });

  it('joins task user/assistant events in order and skips system + blanks', () => {
    const text = workspaceSliceText({
      kind: 'task',
      events: [
        { role: 'user', content: 'do the thing' },
        { role: 'system', content: 'paused' },
        { role: 'assistant', content: 'working' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'done' },
      ],
    });
    expect(text).toBe('do the thing\nworking\ndone');
  });

  it('returns an empty string for a task with no embeddable events', () => {
    expect(workspaceSliceText({ kind: 'task', events: [] })).toBe('');
  });

  // #309: the filename rides the embed text so title-only references
  // ("that AGI file") are semantically retrievable.
  it('folds the filename above the file content (#309)', () => {
    expect(
      workspaceSliceText({
        kind: 'file',
        filename: 'agi-final.md',
        textExtracted: 'The rollout completes in three phases.',
      }),
    ).toBe('agi-final.md\nThe rollout completes in three phases.');
  });

  it('passes content through unchanged when the filename is absent or blank (#309)', () => {
    expect(workspaceSliceText({ kind: 'file', filename: null, textExtracted: 'raw text' })).toBe(
      'raw text',
    );
    expect(workspaceSliceText({ kind: 'file', filename: '   ', textExtracted: 'raw text' })).toBe(
      'raw text',
    );
  });

  it('changes the hash when the filename changes, so a rename re-embeds (#309)', () => {
    const a = truncateForEmbedding(withEmbedTitle('agi-final.md', 'content')).text;
    const b = truncateForEmbedding(withEmbedTitle('agi-final-v2.md', 'content')).text;
    expect(embeddingTextHash(a, 'm')).not.toBe(embeddingTextHash(b, 'm'));
  });
});

describe('truncateForEmbedding (#294)', () => {
  it('leaves a short text untouched and reports no truncation', () => {
    expect(truncateForEmbedding('short')).toEqual({ text: 'short', truncated: false });
  });

  it('cuts to the cap and reports truncation', () => {
    const long = 'x'.repeat(EMBEDDING_MAX_CHARS + 10);
    const result = truncateForEmbedding(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(EMBEDDING_MAX_CHARS);
  });
});

describe('embeddingTextHash (#294)', () => {
  it('is stable for the same text and model', () => {
    const a = embeddingTextHash('hello', 'BAAI/bge-base-en-v1.5');
    const b = embeddingTextHash('hello', 'BAAI/bge-base-en-v1.5');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the text and with the model', () => {
    const base = embeddingTextHash('hello', 'BAAI/bge-base-en-v1.5');
    expect(embeddingTextHash('hello!', 'BAAI/bge-base-en-v1.5')).not.toBe(base);
    expect(embeddingTextHash('hello', 'BAAI/bge-m3')).not.toBe(base);
  });
});

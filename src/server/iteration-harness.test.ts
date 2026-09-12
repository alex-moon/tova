import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractJsonVerdict,
  validateCheck,
  validateLoopDecision,
  validateTriage,
  loadLoopState,
} from '../../scripts/iteration';

describe('iteration harness (issue #37)', () => {
  describe('verdict extraction', () => {
    it('extracts the last JSON object line', () => {
      const out = 'thinking...\nmore prose\n{"kind":"issue","issue":34}';
      expect(extractJsonVerdict(out)).toEqual({ kind: 'issue', issue: 34 });
    });

    it('skips unparsable trailing lines and keeps scanning', () => {
      const out = '{"kind":"none"}\nand then some chatter';
      expect(extractJsonVerdict(out)).toEqual({ kind: 'none' });
    });

    it('returns null when no JSON object exists', () => {
      expect(extractJsonVerdict('ISSUE:34\nDECISION:END - all done')).toBeNull();
    });

    it('rejects arrays as verdicts', () => {
      expect(extractJsonVerdict('[1,2]')).toBeNull();
    });
  });

  describe('verdict validators', () => {
    it('triage verdict', () => {
      expect(validateTriage({ kind: 'none' })).toBeNull();
      expect(validateTriage({ kind: 'issue', issue: 34 })).toBeNull();
      expect(validateTriage({ kind: 'issue', issue: 0 })).not.toBeNull();
      expect(validateTriage({ kind: 'bogus' })).not.toBeNull();
      expect(validateTriage('ISSUE:34')).not.toBeNull();
    });

    it('loop decision verdict', () => {
      expect(validateLoopDecision({ decision: 'CONTINUE' })).toBeNull();
      expect(validateLoopDecision({ decision: 'END', reason: 'done' })).toBeNull();
      expect(validateLoopDecision({ decision: 'END' })).not.toBeNull();
      expect(validateLoopDecision({ decision: 'MAYBE' })).not.toBeNull();
    });

    it('limited-check verdict', () => {
      expect(validateCheck({ verdict: 'NONE' })).toBeNull();
      expect(validateCheck({ verdict: 'NEW', info: 'answer landed' })).toBeNull();
      expect(validateCheck({ verdict: 'NEW' })).not.toBeNull();
      expect(validateCheck({ verdict: 'MAYBE' })).not.toBeNull();
    });
  });

  describe('loop state', () => {
    it('round-trips the exact shell-version shape', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iter-state-'));
      const state = {
        strikes: 2,
        decidedAt: '2026-09-12T10:00:00Z',
        reason: 'all done',
        mode: 'decision' as const,
      };
      fs.writeFileSync(path.join(dir, 'loop-state.json'), JSON.stringify(state, null, 2));
      const loaded = loadLoopState(dir);
      expect(loaded).toEqual(state);
      expect(fs.readFileSync(path.join(dir, 'loop-state.json'), 'utf8')).toContain(
        '"mode": "decision"',
      );
      fs.rmSync(dir, { recursive: true });
    });

    it('returns null for malformed or missing state files', () => {
      expect(loadLoopState(path.join(os.tmpdir(), 'does-not-exist-at-all'))).toBeNull();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iter-state-'));
      fs.writeFileSync(path.join(dir, 'loop-state.json'), 'not json');
      expect(loadLoopState(dir)).toBeNull();
      fs.rmSync(dir, { recursive: true });
    });
  });
});

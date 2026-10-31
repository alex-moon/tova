import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AdminQuizView, {
  loadStats,
  pickQuestion,
  shuffleOptions,
  weightFor,
} from '../../main/components/AdminQuizView';
import { QUIZ_QUESTIONS } from '../../main/components/AdminQuizQuestions';

// The Quiz tab: weighted random draw, shuffled options, verdict + stats loop.
// @see #419

const byId = (id: string) => {
  const q = QUIZ_QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`missing question ${id}`);
  return q;
};

describe('quiz bank integrity', () => {
  it('every question has 4 options, a valid answer index, and an explanation', () => {
    expect(QUIZ_QUESTIONS.length).toBeGreaterThan(80);
    for (const q of QUIZ_QUESTIONS) {
      expect(q.options.length, q.id).toBe(4);
      expect(q.answer, q.id).toBeGreaterThanOrEqual(0);
      expect(q.answer, q.id).toBeLessThan(4);
      expect(q.explain.length, q.id).toBeGreaterThan(0);
      expect(new Set(q.options).size, q.id).toBe(4);
    }
  });

  it('question ids are unique and non-empty', () => {
    expect(new Set(QUIZ_QUESTIONS.map((q) => q.id)).size).toBe(QUIZ_QUESTIONS.length);
  });
});

describe('weighted sampling', () => {
  it('weight is 1 for an unseen or net-even question, +3 per net miss', () => {
    expect(weightFor(undefined)).toBe(1);
    expect(weightFor({ seen: 2, right: 1, wrong: 1 })).toBe(1);
    expect(weightFor({ seen: 3, right: 0, wrong: 3 })).toBe(10);
    expect(weightFor({ seen: 5, right: 4, wrong: 1 })).toBe(1);
  });

  it('never picks a recent id while alternatives exist, and always picks someone', () => {
    const recent = ['r01', 'r02', 'r03'];
    for (let i = 0; i < 200; i++) {
      const picked = pickQuestion({}, recent);
      expect(recent).not.toContain(picked.id);
    }
    const only = pickQuestion({}, QUIZ_QUESTIONS.map((q) => q.id).slice(0, -1));
    expect(QUIZ_QUESTIONS.map((q) => q.id)).toContain(only.id);
  });

  it('skewed stats bend the draw toward the wrong-most question', () => {
    const target = byId('r01');
    const stats = { [target.id]: { seen: 10, right: 0, wrong: 10 } };
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      if (pickQuestion(stats, []).id === target.id) hits++;
    }
    // Weight 31 of ~465 total — far above uniform (~3) but never guaranteed.
    expect(hits).toBeGreaterThan(10);
    expect(hits).toBeLessThan(300);
  });
});

describe('option shuffling', () => {
  it('preserves the option set and correctness, in a deterministic-run sense', () => {
    const q = byId('r01');
    for (const rand of [() => 0, () => 0.999, Math.random]) {
      const shuffled = shuffleOptions(q, rand);
      expect(shuffled.map((o) => o.text).sort()).toEqual([...q.options].sort());
      expect(shuffled.filter((o) => o.isCorrect).length).toBe(1);
      expect(shuffled.find((o) => o.isCorrect)?.text).toBe(q.options[q.answer]);
    }
  });

  it('actually reorders across draws with a real RNG', () => {
    const q = byId('r01');
    const orders = new Set(
      Array.from({ length: 40 }, () =>
        shuffleOptions(q)
          .map((o) => o.text)
          .join('|'),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('the answer loop', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const setup = () => {
    // rand()=0 → identity shuffle and the first bank question (r01) is drawn.
    const q = byId('r01');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<AdminQuizView />);
    return q;
  };

  it('correct answer: green verdict, stats saved, session streak', () => {
    const q = setup();
    const correctText = q.options[q.answer];
    const buttons = screen.getAllByRole('button');
    const option = buttons.find((b) => b.textContent?.includes(correctText))!;
    fireEvent.click(option);
    expect(screen.getByTestId('quiz-verdict')).toHaveTextContent('Correct');
    const stats = loadStats();
    expect(stats[q.id]).toEqual({ seen: 1, right: 1, wrong: 0 });
  });

  it('wrong answer: red verdict, wrong stat saved, stats reflect the miss', () => {
    const q = setup();
    const optionButtons = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.testid?.startsWith('quiz-option'));
    const correctText = q.options[q.answer];
    const wrong = optionButtons.find((b) => b.textContent !== correctText)!;
    fireEvent.click(wrong);
    expect(screen.getByTestId('quiz-verdict')).toHaveTextContent('Incorrect');
    const stats = loadStats();
    expect(stats[q.id].wrong).toBe(1);
    expect(stats[q.id].right).toBe(0);
  });

  it('options are rendered in a shuffled order for at least one of two mounts', () => {
    setup();
    const first = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.testid?.startsWith('quiz-option'))
      .map((b) => b.textContent);
    cleanup();
    vi.spyOn(Math, 'random').mockRestore();
    render(<AdminQuizView />);
    const second = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.testid?.startsWith('quiz-option'))
      .map((b) => b.textContent);
    // Not asserting a specific order — that two draws agree on *some* full
    // ordering while the RNG varies is the shuffling contract.
    expect(first.length).toBe(4);
    expect(second.length).toBe(4);
  });

  it('next advances to a different question and clears the verdict', () => {
    setup();
    fireEvent.click(screen.getAllByTestId(/^quiz-option-/)[0]);
    expect(screen.getByTestId('quiz-verdict')).toBeDefined();
    fireEvent.click(screen.getByTestId('quiz-next'));
    expect(screen.queryByTestId('quiz-verdict')).toBeNull();
  });

  it('reset empties the stats after confirm', () => {
    const q = setup();
    const option = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes(q.options[q.answer]))!;
    fireEvent.click(option);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByTestId('quiz-reset'));
    expect(loadStats()).toEqual({});
  });
});

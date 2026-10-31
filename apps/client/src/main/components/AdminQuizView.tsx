import { useCallback, useEffect, useMemo, useState } from 'react';
import { QUIZ_QUESTIONS, type QuizQuestion } from './AdminQuizQuestions';

// Admin "Quiz" tab: backend flash cards for #419. Client-only — stats live in
// localStorage, the bank is static. Janky-tolerant by request; the fast loop
// (answer → verdict → next) is the product.
// @see #419

const STATS_KEY = 'tova-quiz-stats-v1';

type QStats = { seen: number; right: number; wrong: number };
type StatsMap = Record<string, QStats>;

export const loadStats = (): StatsMap => {
  try {
    const raw = JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}') as StatsMap;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
};

const saveStats = (stats: StatsMap) => {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Private mode / full quota: the session still works, stats just don't persist.
  }
};

// Net-miss weighting: every question keeps nonzero probability (still random),
// each net miss triples the weight, and answering correctly as often as wrongly
// normalizes it — mastered questions stop dominating.
// @see #419
export const weightFor = (s: QStats | undefined): number =>
  1 + Math.max(0, (s?.wrong ?? 0) - (s?.right ?? 0)) * 3;

export const pickQuestion = (
  stats: StatsMap,
  recentIds: string[],
  rand: () => number = Math.random,
): QuizQuestion => {
  const candidates = QUIZ_QUESTIONS.filter((q) => !recentIds.includes(q.id));
  const pool = candidates.length > 0 ? candidates : QUIZ_QUESTIONS;
  const total = pool.reduce((sum, q) => sum + weightFor(stats[q.id]), 0);
  let roll = rand() * total;
  for (const q of pool) {
    roll -= weightFor(stats[q.id]);
    if (roll <= 0) return q;
  }
  return pool[pool.length - 1];
};

export type ShuffledOption = { text: string; isCorrect: boolean };

export const shuffleOptions = (
  q: QuizQuestion,
  rand: () => number = Math.random,
): ShuffledOption[] => {
  const opts = q.options.map((text, i) => ({ text, isCorrect: i === q.answer }));
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  return opts;
};

const pct = (right: number, wrong: number): string =>
  right + wrong === 0 ? '—' : `${Math.round((right / (right + wrong)) * 100)}%`;

const AdminQuizView = () => {
  const [stats, setStats] = useState<StatsMap>(() => loadStats());
  const [initial] = useState(() => pickQuestion(loadStats(), []));
  const [currentId, setCurrentId] = useState(initial.id);
  const [current, setCurrent] = useState(() => shuffleOptions(initial));
  const [selected, setSelected] = useState<number | null>(null);
  const [recent, setRecent] = useState<string[]>(() => [initial.id]);
  const [session, setSession] = useState({ right: 0, wrong: 0, streak: 0, best: 0 });

  const question = useMemo(
    () => QUIZ_QUESTIONS.find((q) => q.id === currentId) ?? null,
    [currentId],
  );
  const answered = selected !== null;

  const next = useCallback(
    (s: StatsMap) => {
      const q = pickQuestion(s, recent);
      setRecent((prev) => [...prev.slice(-2), q.id]);
      setCurrentId(q.id);
      setCurrent(shuffleOptions(q));
      setSelected(null);
    },
    [recent],
  );

  const answer = (index: number) => {
    if (answered || !question) return;
    setSelected(index);
    const correct = current?.[index]?.isCorrect ?? false;
    const prev = stats[question.id] ?? { seen: 0, right: 0, wrong: 0 };
    const updated: StatsMap = {
      ...stats,
      [question.id]: {
        seen: prev.seen + 1,
        right: prev.right + (correct ? 1 : 0),
        wrong: prev.wrong + (correct ? 0 : 1),
      },
    };
    setStats(updated);
    saveStats(updated);
    setSession((s) => {
      const streak = correct ? s.streak + 1 : 0;
      return {
        right: s.right + (correct ? 1 : 0),
        wrong: s.wrong + (correct ? 0 : 1),
        streak,
        best: Math.max(s.best, streak),
      };
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '4' && !answered && current) {
        const index = Number(e.key) - 1;
        if (index < current.length) answer(index);
      } else if ((e.key === ' ' || e.key === 'Enter') && answered) {
        e.preventDefault();
        next(stats);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const totals = Object.values(stats).reduce(
    (acc, s) => ({ right: acc.right + s.right, wrong: acc.wrong + s.wrong }),
    { right: 0, wrong: 0 },
  );
  const isCorrect = answered && (current?.[selected]?.isCorrect ?? false);
  const qStats = question ? stats[question.id] : undefined;

  const reset = () => {
    if (!window.confirm('Reset all quiz stats? This cannot be undone.')) return;
    const emptied: StatsMap = {};
    setStats(emptied);
    saveStats(emptied);
  };

  return (
    <section data-testid="admin-quiz-section" className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="font-heading text-lg font-semibold">Quiz</h3>
        <p className="text-xs text-muted-foreground" data-testid="quiz-accuracy">
          all-time {pct(totals.right, totals.wrong)} ({totals.right}✓/{totals.wrong}✗)
        </p>
        <p className="text-xs text-muted-foreground" data-testid="quiz-streak">
          streak {session.streak} · best {session.best} · this run {session.right}✓/
          {session.wrong}✗
        </p>
        <button
          data-testid="quiz-reset"
          onClick={reset}
          className="ml-auto rounded-lg border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Reset stats
        </button>
      </div>

      {question && current && (
        <div className="rounded-xl border border-border bg-card p-4">
          <span className="inline-block rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {question.category}
          </span>
          <p data-testid="quiz-question" className="mt-3 text-base font-medium break-words">
            {question.q}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {current.map((opt, i) => {
              const picked = selected === i;
              const style = !answered
                ? 'border-border hover:bg-accent hover:text-accent-foreground'
                : opt.isCorrect
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600'
                  : picked
                    ? 'border-destructive bg-destructive/10 text-destructive'
                    : 'border-border text-muted-foreground';
              return (
                <button
                  key={i}
                  data-testid={`quiz-option-${i}`}
                  onClick={() => answer(i)}
                  disabled={answered}
                  className={`w-full rounded-lg border px-3 py-3 text-left text-sm transition-colors break-words disabled:cursor-default ${style}`}
                >
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{i + 1}</span>
                  {opt.text}
                </button>
              );
            })}
          </div>

          {answered && (
            <div className="mt-4 flex flex-col gap-2">
              <p
                data-testid="quiz-verdict"
                className={`text-base font-semibold ${isCorrect ? 'text-emerald-600' : 'text-destructive'}`}
              >
                {isCorrect ? '✓ Correct' : '✗ Incorrect'}
              </p>
              <p data-testid="quiz-explain" className="text-sm text-muted-foreground break-words">
                {question.explain}
              </p>
              {qStats && (
                <p className="text-xs text-muted-foreground">
                  lifetime: {qStats.right}✓ / {qStats.wrong}✗ · weight {weightFor(qStats)}
                </p>
              )}
              <button
                data-testid="quiz-next"
                onClick={() => next(stats)}
                className="self-start rounded-lg border border-primary bg-primary px-4 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Next question
              </button>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {QUIZ_QUESTIONS.length} questions on the backend pipeline. Wrong answers come back more
        often (weighted, still random). Keys 1–4 answer, Space advances.
      </p>
    </section>
  );
};

export default AdminQuizView;

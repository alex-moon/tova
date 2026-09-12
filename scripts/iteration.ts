#!/usr/bin/env node
/**
 * Typed TypeScript harness for the iteration loop over GitHub issues.
 * Typed iteration-loop harness over GitHub issues (issue #37): same phase body
 * (triage -> plan-write -> plan-review -> implement -> critic ->
 * pr-review-rectify -> pr-decision), same loop-state semantics, but with
 * typed state, structured JSON agent verdicts (validated, one retry, then a
 * logged hard failure), and one state snapshot gathered per pass and
 * injected into every phase prompt.
 *
 * Usage:
 *   npx tsx scripts/iteration.ts [--once] [priority-issue-number]
 *
 * Env: STRIKE_LIMIT (default 3), PASS_INTERVAL (seconds between passes, 900).
 * Strikes: a shutdown decision or an ISSUE:NONE triage is checked no more often
 * than once per pass. After the third strike the loop waits one final interval,
 * performs one last strike-free check, and only downs tools if nothing new
 * arrived - so from the first strike the loop keeps going for roughly an hour.
 * Requires: gh (authenticated), git, opencode on PATH; run from the repo root.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---- Types -----------------------------------------------------------------

interface LoopState {
  strikes: number;
  decidedAt: string | null;
  reason: string | null;
  mode: 'decision' | 'strikes';
}

interface IssueComment {
  by: string;
  at: string;
  body: string;
}

interface IssueInfo {
  number: number;
  title: string;
  updatedAt: string;
  comments: IssueComment[];
}

interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
}

interface PendingReviewFeedback {
  pr: number;
  reviews: { author: string; comments: { body: string; path: string; line: number | null }[] }[];
}

interface PlanDoc {
  issue: number;
  file: string;
  content: string;
}

interface PassSnapshot {
  gatheredAt: string;
  issues: IssueInfo[];
  openPrs: PrInfo[];
  pendingReviewComments: PendingReviewFeedback[];
  planDocs: PlanDoc[];
}

type TriageVerdict = { kind: 'issue'; issue: number } | { kind: 'none' };
type LoopDecisionVerdict = { decision: 'CONTINUE' | 'END'; reason?: string };
type CheckVerdict = { verdict: 'NEW' | 'NONE'; info?: string };

const TRIAGE_SCHEMA = '{"kind":"issue","issue":<number>} or {"kind":"none"}';
const LOOP_DECISION_SCHEMA =
  '{"decision":"CONTINUE"} or {"decision":"END","reason":"<short reason>"}';
const CHECK_SCHEMA = '{"verdict":"NEW","info":"<one short reason>"} or {"verdict":"NONE"}';

// ---- CLI / env ---------------------------------------------------------------

const REPO = 'alex-moon/tova';
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT ?? '3') || 3;
const PASS_INTERVAL = Number(process.env.PASS_INTERVAL ?? '900') || 900;

let ONCE = false;
let PRIORITY: number | undefined;

/** Parses `[--once] [priority-issue-number]`; called once, only when the script is executed directly. */
function initCli(): void {
  ONCE = process.argv.includes('--once');
  const priorityArgs = process.argv.slice(2).filter((a) => a !== '--once');
  if (priorityArgs.length > 1) {
    fail('Too many arguments: pass at most one issue number');
  }
  PRIORITY = priorityArgs[0] === undefined ? undefined : Number(priorityArgs[0]);
  if (PRIORITY !== undefined && (!Number.isInteger(PRIORITY) || PRIORITY <= 0)) {
    fail(`Priority must be an issue number, got: ${String(priorityArgs[0])}`);
  }
}

// ---- Logging -------------------------------------------------------------------

const LOG_DIR = 'logs';
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(
  LOG_DIR,
  `iteration-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.log`,
);

function log(msg: string): void {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---- Process helpers -------------------------------------------------------------

function git(args: string[], mustSucceed = false): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (mustSucceed) throw err;
    return '';
  }
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghAllowFail(args: string[], what: string): string {
  try {
    return gh(args);
  } catch (err) {
    log(`${what} failed: ${(err as Error).message}`);
    return '';
  }
}

function sleepSeconds(s: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
}

// ---- Loop state -------------------------------------------------------------------

const STATE_DIR = '.iteration';
const STATE_FILE = path.join(STATE_DIR, 'loop-state.json');

export function loadLoopState(dir: string = STATE_DIR): LoopState | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'loop-state.json'), 'utf8'),
    ) as Partial<LoopState>;
    const mode = raw.mode === 'decision' || raw.mode === 'strikes' ? raw.mode : null;
    if (mode === null) return null;
    return {
      strikes: typeof raw.strikes === 'number' ? raw.strikes : 0,
      decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : null,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      mode,
    };
  } catch {
    return null;
  }
}

function writeLoopState(
  strikes: number,
  mode: LoopState['mode'],
  decidedAt: string | null,
  reason: string | null,
): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ strikes, decidedAt, reason, mode }, null, 2)}\n`,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Registers a strike; returns true to keep looping, false when the limit is exhausted. */
function addStrike(mode: LoopState['mode'], reason: string): boolean {
  const prev = loadLoopState();
  const strikes = (prev?.strikes ?? 0) + 1;
  if (prev?.decidedAt) {
    writeLoopState(strikes, mode, prev.decidedAt, prev.reason);
  } else {
    writeLoopState(strikes, mode, nowIso(), reason);
  }
  log(`Strike ${strikes}/${STRIKE_LIMIT}: ${reason}`);
  return strikes < STRIKE_LIMIT;
}

function clearShutdown(): void {
  try {
    fs.rmSync(STATE_FILE);
  } catch {
    // already gone
  }
  log('Decision overturned - new information in GitHub issues; resuming full work');
}

// ---- Verdict parsing / validation ---------------------------------------------------

/** Extract the last line of the output that parses as a JSON object. */
export function extractJsonVerdict(output: string): unknown | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

type Validator = (v: unknown) => string | null;

export function validateTriage(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return 'not a JSON object';
  if (r.kind === 'none') return null;
  if (r.kind === 'issue') {
    const n = asNum(r.issue);
    if (n === null || n <= 0) return '"issue" must be a positive integer when "kind" is "issue"';
    return null;
  }
  return `expected ${TRIAGE_SCHEMA}`;
}

export function validateLoopDecision(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return 'not a JSON object';
  if (r.decision === 'CONTINUE') return null;
  if (r.decision === 'END' && asStr(r.reason) !== null) return null;
  return `expected ${LOOP_DECISION_SCHEMA}`;
}

export function validateCheck(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return 'not a JSON object';
  if (r.verdict === 'NONE') return null;
  if (r.verdict === 'NEW' && asStr(r.info) !== null) return null;
  return `expected ${CHECK_SCHEMA}`;
}

function acceptAnyObject(v: unknown): string | null {
  if (asRecord(v) === null) return 'not a JSON object';
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

// ---- Agent runner --------------------------------------------------------------------

/**
 * Runs `opencode run --auto --title <title> <prompt>`, tees the transcript
 * to the pass log, then extracts and validates the final JSON verdict. On
 * invalid output the agent is retried exactly once with the schema included;
 * a second failure throws (a logged hard failure — never silently skipped).
 */
function agent<T>(title: string, prompt: string, validate: Validator, retrySchema: string): T {
  log(`phase: ${title}`);
  let output = runAgentRaw(title, prompt);
  let verdict = extractJsonVerdict(output);
  if (verdict !== null) {
    const err = validate(verdict);
    if (err === null) return verdict as T;
    log(`phase ${title}: invalid verdict (${err}); one retry with schema`);
    output = runAgentRaw(
      title,
      `${prompt}\n\nYour previous reply was rejected: ${err}\nFinal line MUST be a single JSON object matching: ${retrySchema}`,
    );
    verdict = extractJsonVerdict(output);
    if (verdict === null) throw new Error(`phase ${title}: retry produced no JSON verdict`);
    const err2 = validate(verdict);
    if (err2 !== null) throw new Error(`phase ${title}: retry verdict still invalid (${err2})`);
    return verdict as T;
  }
  log(`phase ${title}: no JSON verdict in output; one retry with schema`);
  output = runAgentRaw(
    title,
    `${prompt}\n\nYour previous reply had no parsable JSON verdict.\nFinal line MUST be a single JSON object matching: ${retrySchema}`,
  );
  verdict = extractJsonVerdict(output);
  if (verdict === null) throw new Error(`phase ${title}: retry produced no JSON verdict`);
  const err3 = validate(verdict);
  if (err3 !== null) throw new Error(`phase ${title}: retry verdict invalid (${err3})`);
  return verdict as T;
}

function runAgentRaw(title: string, prompt: string): string {
  let out = '';
  try {
    out = execFileSync('opencode', ['run', '--auto', '--title', title, prompt], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    log(`opencode phase ${title} exited non-zero`);
    out = String((err as { stdout?: unknown }).stdout ?? '');
  }
  fs.appendFileSync(LOG_FILE, `----- phase ${title} -----\n${out}\n----- end ${title} -----\n`);
  return out;
}

// ---- Per-pass snapshot gathering ------------------------------------------------------

let snapshot: PassSnapshot | null = null;
let currentBranch = 'main';

function fetchIssues(): IssueInfo[] {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'number,title,updatedAt',
  ]);
  const list = JSON.parse(raw) as { number: number; title: string; updatedAt: string }[];
  return list.map((i) => {
    const commentsRaw = ghAllowFail(
      ['api', `repos/${REPO}/issues/${i.number}/comments?per_page=50`],
      `comment fetch for #${i.number}`,
    );
    let comments: IssueComment[] = [];
    if (commentsRaw.trim() !== '') {
      try {
        comments = (
          JSON.parse(commentsRaw) as {
            body: string;
            user: { login: string };
            created_at: string;
          }[]
        ).map((c) => ({ by: c.user.login, at: c.created_at, body: c.body }));
      } catch {
        log(`comments for #${i.number} unparsable; treating as none`);
      }
    }
    return { number: i.number, title: i.title, updatedAt: i.updatedAt, comments };
  });
}

function fetchOpenPrs(): PrInfo[] {
  const raw = ghAllowFail(
    [
      'pr',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--json',
      'number,title,headRefName,updatedAt',
    ],
    'pr list',
  );
  if (raw.trim() === '') return [];
  try {
    return JSON.parse(raw) as PrInfo[];
  } catch {
    log('gh pr list returned unparsable JSON');
    return [];
  }
}

/**
 * PENDING reviews are invisible to the REST comment endpoints; read them via
 * the same GraphQL approach the shell version used for pr-review-rectify.
 */
function fetchPendingReviewComments(prNumbers: number[]): PendingReviewFeedback[] {
  return prNumbers.flatMap((pr) => {
    const query =
      '{ repository(owner: "alex-moon", name: "tova") { pullRequest(number: ' +
      pr +
      ') { reviews(states: PENDING, first: 10) { nodes { author { login } comments(first: 50) { nodes { body path line } } } } } } }';
    const raw = ghAllowFail(
      ['api', 'graphql', '-f', `query=${query}`],
      `pending reviews for PR #${pr}`,
    );
    if (raw.trim() === '') return [];
    try {
      const parsed = JSON.parse(raw) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviews?: {
                nodes?: {
                  author?: { login?: string };
                  comments?: { nodes?: { body: string; path: string; line: number | null }[] };
                }[];
              };
            };
          };
        };
      };
      const nodes = parsed.data?.repository?.pullRequest?.reviews?.nodes ?? [];
      const reviews = nodes.map((n) => ({
        author: n.author?.login ?? 'unknown',
        comments: (n.comments?.nodes ?? []).map((c) => ({ ...c })),
      }));
      if (reviews.every((r) => r.comments.length === 0)) return [];
      return [{ pr, reviews }];
    } catch {
      log(`pending-review GraphQL read failed for PR #${pr}`);
      return [];
    }
  });
}

function readPlanDocs(issues: IssueInfo[]): PlanDoc[] {
  const docsDir = 'docs';
  if (!fs.existsSync(docsDir)) return [];
  const byIssue = new Set(issues.map((i) => i.number));
  const out: PlanDoc[] = [];
  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.startsWith('plan-') && f.endsWith('.md'))
    .sort();
  for (const f of files) {
    const m = /^plan-(\d+)-.*\.md$/.exec(f);
    if (!m) continue;
    const issue = Number(m[1]);
    if (!byIssue.has(issue)) continue;
    out.push({
      issue,
      file: path.join(docsDir, f),
      content: fs.readFileSync(path.join(docsDir, f), 'utf8'),
    });
  }
  return out;
}

function gatherSnapshot(): PassSnapshot {
  const issues = fetchIssues();
  const openPrs = fetchOpenPrs();
  return {
    gatheredAt: nowIso(),
    issues,
    openPrs,
    pendingReviewComments: fetchPendingReviewComments(openPrs.map((p) => p.number)),
    planDocs: readPlanDocs(issues),
  };
}

function refreshPlanDoc(issue: number): void {
  if (snapshot === null) return;
  const fresh = readPlanDocs([{ number: issue, title: '', updatedAt: '', comments: [] }]);
  if (fresh.length === 0) return;
  const doc = snapshot.planDocs.find((d) => d.issue === issue);
  if (doc) {
    doc.file = fresh[0].file;
    doc.content = fresh[0].content;
  } else {
    snapshot.planDocs.push(...fresh);
  }
}

function planDocFor(issue: number): PlanDoc | null {
  return snapshot?.planDocs.find((d) => d.issue === issue) ?? null;
}

function snapshotPromptText(issue: number | null): string {
  if (snapshot === null) {
    return 'PASS SNAPSHOT unavailable; re-fetch whatever you need with gh.\n';
  }
  const issues =
    issue === null ? snapshot.issues : snapshot.issues.filter((i) => i.number === issue);
  const prs =
    issue === null
      ? snapshot.openPrs
      : snapshot.openPrs.filter((p) => p.headRefName.includes(`tv/${issue}-`));
  const prNumbers = new Set(prs.map((p) => p.number));
  const pending = snapshot.pendingReviewComments.filter((c) =>
    issue === null ? true : prNumbersOf(prs).includes(c.pr),
  );
  const plans =
    issue === null ? snapshot.planDocs : snapshot.planDocs.filter((d) => d.issue === issue);
  return [
    `PASS SNAPSHOT (gathered ${snapshot.gatheredAt}) — this is the state gathered once per pass;`,
    'do not re-fetch it; individual gh calls for anything else you need remain available.',
    `openIssues=${JSON.stringify(issues)}`,
    `openPrs=${JSON.stringify(prs)}`,
    `pendingReviewComments=${JSON.stringify(pending)}`,
    `planDocs=${JSON.stringify(plans)}`,
    '',
  ]
    .join('\n')
    .trim();
}

function prNumbersOf(prs: PrInfo[]): number[] {
  return prs.map((p) => p.number);
}

// ---- Git helpers ---------------------------------------------------------------------

function hasChanges(): boolean {
  return git(['status', '--porcelain']).trim() !== '';
}

function commitAndPush(msg: string): void {
  if (hasChanges()) {
    git(['add', '-A']);
    git(['commit', '-m', msg]);
    git(['push', '-u', 'origin', currentBranch, '--quiet']);
    log(`Committed and pushed: ${msg}`);
  } else {
    log(`Nothing to commit for: ${msg}`);
  }
}

function commitPlan(issue: number): void {
  const status = git(['status', '--porcelain', '--', 'docs']);
  if (status.trim() === '') {
    log('No plan changes to commit');
    return;
  }
  git(['add', 'docs']);
  git(['commit', '-m', `docs: plan updates for #${issue}`]);
  git(['push', '-u', 'origin', currentBranch, '--quiet']);
  log('Committed and pushed plan updates');
  refreshPlanDoc(issue);
}

// ---- Shared prompt frame ---------------------------------------------------------------

function contextPrefix(issue: number): string {
  return `You are working in the repo /opt/tova on branch ${currentBranch} for GitHub issue #${issue}
in ${REPO}. The PASS SNAPSHOT below already holds the open issues with their comments, the
open PRs (including PENDING review comments read via GraphQL) and the plan docs; individual
gh calls for anything else remain available. Read docs/overview.md and docs/workflow.md for
background. Follow the repo's existing conventions. Do NOT commit or push - the
orchestrator does that. Before doing anything, confirm from the repo's own state (not just
issue comments) that this ticket is neither already done nor blocked on the user: if it is,
post the blocking reason as a gh issue comment on #${issue} and stop immediately without
doing any work.
`;
}

function snapshotBlock(issue: number | null): string {
  return `PASS SNAPSHOT delivered below. The harness gathered it once this pass; phases must
not re-run the same list gh calls (individual gh calls for anything unfinished keep working).

${snapshotPromptText(issue)}`;
}

// ---- Triage phase -----------------------------------------------------------------------

function triagePrompt(): string {
  const priorityNote =
    PRIORITY !== undefined
      ? `
The user has marked issue #${PRIORITY} as PRIORITY. Prefer it: if it is READY, pick it even
if other issues are smaller or more recently updated. You MAY pick a different issue only
when it directly supports the priority ticket (unblocks it or delivers a prerequisite the
priority ticket depends on) - in that case output the supporting issue's number. If the
priority issue is DONE or BLOCKED, classify it exactly as you would any other ticket.
`
      : '';
  return `You are triaging the open GitHub issues for repo ${REPO} and picking the
next one to work on. Do NOT trust issue state alone: judge each ticket from the repo itself.
The PASS SNAPSHOT has the open issues with their full comment conversations, the open PRs
(with PENDING review comments where present) and the plan docs per issue - you do NOT need
to re-run gh issue list / gh pr list; only post issue comments or fetch detail that is
genuinely missing.${priorityNote}
1. Classify each issue as exactly one of:
   - DONE:   the deliverable exists and is verified (green PR/checks or work landed on main);
             a branch 'feat/tv/<n>-...' carrying the ticket's deliverable with an open PR
             against main means the ticket is in review or done.
   - BLOCKED: progress requires something only the user can provide - an unanswered open
             question, an access request, or a decision the repo gives no basis to make.
   - READY:  work is possible now that could move the ticket forward.
   If an issue is BLOCKED and has no comment already stating that, post
   'gh issue comment <n> --repo ${REPO}' briefly stating why and what would unblock it
   (once per ticket; if an identical comment already exists, do not re-post).
2. If every open issue is DONE or BLOCKED, your final line is {"kind":"none"}.
3. Otherwise pick ONE issue: prefer tickets whose comments contain answers to previously
   raised open questions, then smaller well-scoped READY issues over sprawling ones.
   Never pick a DONE ticket, and never pick a BLOCKED ticket.
4. Final line MUST be the single JSON object: ${TRIAGE_SCHEMA}`;
}

function triagePhase(): TriageVerdict {
  const v = agent<TriageVerdict>(
    'triage-tickets',
    `${triagePrompt()}

${snapshotBlock(null)}`,
    validateTriage,
    TRIAGE_SCHEMA,
  );
  if (
    v.kind === 'issue' &&
    snapshot !== null &&
    !snapshot.issues.some((i) => i.number === v.issue)
  ) {
    throw new Error(`triage returned issue ${v.issue} which is not in the current snapshot`);
  }
  return v;
}

// ---- Branch helpers ------------------------------------------------------------------------

function ensureBranch(issue: number): string {
  const branches = git(['branch', '-a', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
  const match = branches.find((b) => b.includes(`tv/${issue}-`));
  if (match) {
    const branch = match.replace(/^origin\//, '');
    git(['checkout', branch]);
    const pulled = git(['pull', 'origin', branch, '--quiet']);
    if (pulled === '' && git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== branch) {
      log('pull failed; continuing with local state');
    }
    return branch;
  }
  const raw = ghAllowFail(
    ['issue', 'view', String(issue), '--repo', REPO, '--json', 'title'],
    `issue view for #${issue}`,
  );
  let title = '';
  try {
    title = (JSON.parse(raw) as { title: string }).title ?? '';
  } catch {
    // empty title falls through to the summary default
  }
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .join('-');
  const summary = words === '' ? 'iteration' : words;
  const branch = `feat/tv/${issue}-${summary}`;
  git(['checkout', '-b', branch, 'origin/main']);
  log(`Created branch ${branch}`);
  return branch;
}

function openPrForBranch(): number | null {
  const raw = ghAllowFail(
    ['pr', 'list', '--repo', REPO, '--head', currentBranch, '--state', 'open', '--json', 'number'],
    'pr list for branch',
  );
  if (raw.trim() === '') return null;
  try {
    const arr = JSON.parse(raw) as { number: number }[];
    return arr[0]?.number ?? null;
  } catch {
    return null;
  }
}

// ---- Pass body -------------------------------------------------------------------------------

interface PassOutcome {
  productive: boolean;
  stop: boolean;
}

function runPass(): PassOutcome {
  snapshot = gatherSnapshot();
  log(
    `Snapshot gathered: ${snapshot.issues.length} open issues, ${snapshot.openPrs.length} open PRs at ${snapshot.gatheredAt}`,
  );

  // ---- Phase 0: triage ----
  const pick = triagePhase();
  if (pick.kind === 'none') {
    log('Triage verdict: none');
    if (!addStrike('strikes', 'triage returned ISSUE:NONE')) {
      log(
        `All work blocked for ${STRIKE_LIMIT} consecutive strikes; downing tools pending final grace check`,
      );
      return { productive: false, stop: true };
    }
    return { productive: false, stop: false };
  }
  const ISSUE = pick.issue;
  log(`Triage verdict: ISSUE:${ISSUE}`);

  // ---- Branch ----
  currentBranch = ensureBranch(ISSUE);
  refreshPlanDoc(ISSUE);
  log(`Working branch: ${currentBranch}`);

  // ---- Phase 1: plan-write ----
  let plan = planDocFor(ISSUE);
  if (plan === null) {
    agent<unknown>(
      'plan-write',
      `${contextPrefix(ISSUE)}

Write a plan at docs/plan-${ISSUE}-<summary>.md (summary matches the branch name suffix). It
must be:
a) detailed: a motivation section linking the issue, decisions so far, and a checklist of
   small tasks each safely deliverable in a single commit;
b) honest: anything you are not sure about goes under an 'Open questions' section.
Avoid planning work that depends on an open question. Commit nothing; leave the file on disk.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    refreshPlanDoc(ISSUE);
    commitPlan(ISSUE);
  } else {
    log(`Plan doc already exists: ${planDocFor(ISSUE)?.file}`);
  }

  // ---- Phase 2: plan-review ----
  const planAfterWrite = planDocFor(ISSUE);
  if (planAfterWrite === null) {
    log('No plan file; skipping hardening');
  } else {
    agent<unknown>(
      'plan-review',
      `${contextPrefix(ISSUE)}

The plan is at ${planAfterWrite.file}. Review it and revise the file to make it:
a) more detailed: flesh out thin tasks into concrete steps; move anything already answered
   in the issue comments OUT of 'Open questions' and into the detailed plan;
b) more honest: criticise every assumption; move anything with ANY doubt into
   'Open questions', and make sure no planned task depends on an open question.
Post a gh issue comment on #${ISSUE} for any NEW open question not already in the issue
comments. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    commitPlan(ISSUE);
  }

  const planRef = planDocFor(ISSUE)?.file ?? 'no plan doc exists - work directly from the issue';

  // ---- Phase 3: implement ----
  if (hasChanges()) {
    log('Dirty worktree; skipping implement phase');
  } else {
    agent<unknown>(
      'implement',
      `${contextPrefix(ISSUE)}
The plan is at ${planRef}.

Read the issue comments in the PASS SNAPSHOT first for answers to open questions - do only
work that is no longer blocked by an open question. Deliver ONE stable, self-contained piece
of work: either a real deliverable for the ticket, or an intermediary that a later iteration
can build on. Verify it (relevant subset of npm run lint, npm test, npm run typecheck) before
leaving it in the working tree. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
  }
  commitAndPush(`feat: implement a deliverable for #${ISSUE}`);

  // ---- Phase 4: critic ----
  agent<unknown>(
    'critic',
    `${contextPrefix(ISSUE)}
The plan is at ${planRef}. Aggressively criticise the work delivered on this branch
(git log/diff vs origin/main). Try to break it: run the relevant tests and npm run ci,
look for bugs, edge cases, missed requirements, and plan drift. Then:
- write new tests where breaking potential exists;
- make any fixes or hardening changes that are within your reach;
- update the plan doc (${planRef}) with any new questions raised, under 'Open questions';
- post a gh issue comment on #${ISSUE} for any open question not already in the issue comments.
Commit nothing.
Final line MUST be the single JSON object: {}`,
    acceptAnyObject,
    '{}',
  );
  commitAndPush(`test/hardening: critic pass for #${ISSUE}`);

  // ---- Phase 4.5: address PR review comments ----
  const prNum = openPrForBranch();
  if (prNum !== null) {
    // Refresh pending-review data for this specific PR (reviews may have
    // arrived since the snapshot at the top of the pass).
    snapshot.pendingReviewComments = fetchPendingReviewComments([prNum]).concat(
      snapshot.pendingReviewComments.filter((p) => p.pr !== prNum),
    );
    agent<unknown>(
      'pr-review-rectify',
      `${contextPrefix(ISSUE)}

An open PR (#${prNum}) targets main for this branch. Read its review comments and rectify
them in the working tree:
- the PR and its reviews, including PENDING review comments, are in the PASS SNAPSHOT;
- address every actionable comment: make the requested change, or reply/post on the issue
  why it is handled elsewhere (e.g. split into its own ticket).
Verify with the relevant tests/npm run ci. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    commitAndPush(`fix: address PR review comments for #${prNum}`);
  }

  // ---- PR decision ----
  prDecisionPhase(ISSUE);

  log(`Pass complete for issue #${ISSUE} (${currentBranch})`);
  git(['checkout', 'main']);
  return { productive: true, stop: false };
}

function prDecisionPhase(issue: number): void {
  const planFile = planDocFor(issue)?.file;
  agent<unknown>(
    'pr-decision',
    `${contextPrefix(issue)}
${planFile ? `The plan is at ${planFile}.` : ''}

Decide whether this ticket is meaningfully done: a real deliverable exists, verification
passes, and remaining gaps are honest follow-ups documented in the plan. If yes: run
npm run ci; if it passes, open a PR targeting main (gh pr create --repo ${REPO} --base main
--head ${currentBranch}) with a short summary linking the plan file, and close out. If not
meaningfully done, do nothing except post any missing open questions as a gh issue comment
on #${issue}.
Final line MUST be the single JSON object: ${LOOP_DECISION_SCHEMA}`,
    validateLoopDecision,
    LOOP_DECISION_SCHEMA,
  );
}

// ---- Loop-decision agent -----------------------------------------------------------------

function decideLoop(): boolean {
  const v = agent<LoopDecisionVerdict>(
    'loop-decision',
    `You have just completed an iteration pass on the GitHub
issues of repo ${REPO}. Recent activity is visible in logs/iteration-*.log, plan docs
in docs/, open PRs and issue comments in GitHub. Decide whether the iteration loop should
CONTINUE or END.

END the loop when: all open issues are meaningfully done or blocked, and what remains needs
only the user (answers to open questions, access, decisions) with nothing actionable left.
Otherwise CONTINUE.

${snapshotBlock(null)}
Final line MUST be the single JSON object: ${LOOP_DECISION_SCHEMA}`,
    validateLoopDecision,
    LOOP_DECISION_SCHEMA,
  );
  if (v.decision === 'END') {
    const reason = v.reason ?? 'no reason given';
    log(`loop-decision recorded shutdown: ${reason}`);
    writeLoopState(0, 'decision', nowIso(), reason);
    return false;
  }
  log('loop-decision: continue');
  return true;
}

// ---- Limited shutdown check -----------------------------------------------------------------

/**
 * Returns 0: resume full work; 2: strike, skip work phases but keep looping;
 * 1: strikes exhausted, down tools. `countStrike=false` performs a strike-free
 * check (used for the final grace check before actually stopping).
 */
function checkShutdown(countStrike = true): 0 | 2 | 1 {
  const state = loadLoopState();
  if (state === null || state.mode !== 'decision' || state.decidedAt === null) return 0;
  const priorityNote =
    PRIORITY !== undefined
      ? `
Note: the user has marked issue #${PRIORITY} as PRIORITY - also check
whether it specifically now shows new information.`
      : '';
  const v = agent<CheckVerdict>(
    'loop-check',
    `A previous iteration of this loop has already decided that all
GitHub issues for repo ${REPO} are either meaningfully done or blocked.
Decision recorded at: ${state.decidedAt}
Reason: ${state.reason ?? ''}${priorityNote}

Perform a LIMITED check only - do not re-run full triage, do not do any work.
Look ONLY for new information in GitHub issues since ${state.decidedAt} that could change
that decision:
- new issue comments that ANSWER a previously blocking open question, add new
  requirements, or otherwise make meaningful work possible again;
- new open issues or new open PRs.
The PASS SNAPSHOT has the current open issues (with comments after the decision discussion),
open PRs and plan docs; you do NOT need to re-run gh issue list / pr list.

Final line MUST be the single JSON object: ${CHECK_SCHEMA}`,
    validateCheck,
    CHECK_SCHEMA,
  );
  if (v.verdict === 'NEW') {
    clearShutdown();
    return 0;
  }
  log(`No new information in GitHub issues since ${state.decidedAt}`);
  if (!countStrike) {
    log('Final grace check confirmed: nothing new; downing tools');
    return 1;
  }
  if (
    addStrike(
      'decision',
      `limited shutdown check found no new information since ${state.decidedAt}`,
    )
  ) {
    return 2;
  }
  log(`Decision exhausted ${STRIKE_LIMIT} strikes; one final grace check in ${PASS_INTERVAL}s`);
  return 1;
}

/**
 * Final grace period before downing tools: wait one more interval, run one
 * strike-free shutdown check, and resume the loop if new information arrived.
 * Returns true only when the loop should keep going.
 */
function graceResume(): boolean {
  if (ONCE) return false;
  sleepSeconds(PASS_INTERVAL);
  return checkShutdown(false) === 0;
}

// ---- Main loop -------------------------------------------------------------------------------

function mainLoop(): void {
  initCli();
  log(
    `Starting iteration harness (priority: ${PRIORITY === undefined ? 'none' : `#${PRIORITY}`}, once: ${ONCE})`,
  );
  while (true) {
    const state = loadLoopState();
    let stale = false;
    if (state !== null && state.mode === 'decision' && state.decidedAt !== null) {
      const outcome = checkShutdown();
      if (outcome === 1) {
        if (graceResume()) continue;
        log('Loop ended after shutdown decision exhausted its strikes');
        return;
      }
      if (outcome === 2) stale = true;
    }
    if (stale) {
      if (ONCE) return;
      log(`Shutdown in effect; next limited check in ${PASS_INTERVAL}s`);
      sleepSeconds(PASS_INTERVAL);
      continue;
    }

    let outcome: PassOutcome;
    try {
      outcome = runPass();
    } catch (err) {
      log(`Pass failed hard: ${(err as Error).message}`);
      git(['checkout', 'main']);
      if (loadLoopState()?.mode === 'decision') {
        writeLoopState(0, 'strikes', nowIso(), (err as Error).message);
      }
      return;
    }

    if (outcome.stop) {
      // Strikes exhausted via triage ISSUE:NONE; final grace check, then stop.
      if (graceResume()) continue;
      log('Loop ended: all work blocked and strikes exhausted');
      return;
    }

    if (outcome.productive) {
      let doContinue = false;
      try {
        doContinue = decideLoop();
      } catch (err) {
        log(`loop-decision failed hard: ${(err as Error).message}`);
        writeLoopState(0, 'strikes', nowIso(), `loop-decision failed: ${(err as Error).message}`);
      }
      if (!doContinue) {
        stale = true;
      }
    }
    if (stale && loadLoopState()?.mode === 'decision') {
      if (ONCE) return;
      log(`Shutdown in effect; next limited check in ${PASS_INTERVAL}s`);
      sleepSeconds(PASS_INTERVAL);
      continue;
    }
    if (ONCE) return;
    log(`Next pass in ${PASS_INTERVAL}s`);
    sleepSeconds(PASS_INTERVAL);
  }
}

if (require.main === module) {
  mainLoop();
}

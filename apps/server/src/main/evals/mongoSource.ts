/** Temporary Mongo eval source: synthetic eval user + seeded library. */
// @see #112
import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { User } from '../models/User';
import { extractUnits, type AssetUnit } from '../services/documentUnits';

// Stable 24-hex ObjectId so eval runs across sessions reuse one fixture user.
const EVAL_USER_ID_HEX = '6f61e78155a5b2c0d3e1f7a2';
export const evalUserId = new mongoose.Types.ObjectId(EVAL_USER_ID_HEX);
export const evalUserEmail = 'eval-fixture@tova.local';

// Content for the Bupa case: discoverable only inside the seeded file.
// @see #112
const BUPA_POLICY_TEXT = `Bupa Health Insurance — policy schedule PROV-2026-00318
Covered benefits:
- Fertility treatment: 60% coverage, up to £4,000 per cycle, requires GP referral.
- Physiotherapy: 6 sessions per year.
- Maternity: not covered on this plan.
Exclusions: pre-existing conditions declared at inception;
fertility cycles beyond the second are reduced to 40% coverage.`;

const FIXTURE_FILES: { filename: string; contentType: string; text: string }[] = [
  {
    filename: 'bupa-policy.md',
    contentType: 'text/markdown',
    text: BUPA_POLICY_TEXT,
  },
  {
    filename: 'utilities-notes.md',
    contentType: 'text/markdown',
    text: '# Utility bills\n\nBroadband contract renewals in November.',
  },
];

// Case A fixture: the answer is on page 58; filler forces a truncation.
// @see #159
export const SUPPORT_PHONE = '+44 20 7946 0812';
export const SUPPORT_PHONE_PAGE = 58;

const manualPageText = (index: number): string =>
  `Chapter continuation, page ${index}. This page discusses routine operation ` +
  `and maintenance item ${index} of the appliance manual, with placeholders for ` +
  'diagrams and troubleshooting tables across several sub-chapters. ' +
  `The service schedule for this interval (${index}) covers intake filters, drive ` +
  'belts, housing seals, and control-board firmware checks in sequence, each with ' +
  'its own torque values and inspection windows documented in the figures that ' +
  'follow this paragraph throughout the printed edition of the manual.';

const LONG_MANUAL_FILENAME = 'long-manual.md';
const LONG_MANUAL_PAGES = 60;

const longManualUnits = (): AssetUnit[] => {
  const units: AssetUnit[] = [];
  for (let index = 1; index <= LONG_MANUAL_PAGES; index++) {
    units.push({
      index,
      label: `Page ${index}`,
      text:
        index === SUPPORT_PHONE_PAGE
          ? // Phone sits beyond the 120-char `unitsOnly` preview: page identifiable, not given away.
            'Appendix: support contact details.\nThis appendix collects the published ' +
            'support channels for the appliance, last revised at this edition\u2019s ' +
            `release. Support phone number: ${SUPPORT_PHONE} ` +
            '(available weekdays 9am-6pm UK time).\nEmail: support@example.com'
          : manualPageText(index),
    });
  }
  return units;
};

// Case B fixture: six heading-2 sections (no H1), via real `extractUnits`.
// @see #159
const HANDBOOK_FILENAME = 'project-handbook.md';
const HANDBOOK_SECTIONS = [
  {
    title: 'Overview',
    body: 'Purpose, scope, and who this handbook applies to across the project.',
  },
  {
    title: 'Onboarding',
    body: 'First-week checklist, accounts to request, and the buddy assignment rule.',
  },
  {
    title: 'Expense policy',
    body: 'Receipt thresholds, submission deadlines, and the per-month cap.',
  },
  { title: 'Remote work', body: 'Core-hours overlap expectations and the equipment allowance.' },
  { title: 'Escalation', body: 'Who to contact for incidents, and the severity response matrix.' },
  { title: 'Glossary', body: 'Project terminology, acronyms, and the canonical artifact names.' },
];

const handbookText = (): string =>
  HANDBOOK_SECTIONS.map(
    (section, i) =>
      `## ${section.title}\n\n${section.body} Section ${i + 1} of the handbook, kept ` +
      'distinct from every other section so per-file generation is checkable.',
  ).join('\n\n');

interface FixtureWithUnits {
  filename: string;
  contentType: string;
  text: string;
  units: AssetUnit[];
}

const FIXTURE_ASSETS = (): FixtureWithUnits[] => [
  ...FIXTURE_FILES.map((file) => ({
    ...file,
    units: extractUnits(file.filename, file.text),
  })),
  {
    filename: LONG_MANUAL_FILENAME,
    contentType: 'text/markdown',
    text: longManualUnits()
      .map((u) => u.text)
      .join('\n\n'),
    units: longManualUnits(),
  },
  {
    filename: HANDBOOK_FILENAME,
    contentType: 'text/markdown',
    text: handbookText(),
    units: extractUnits(HANDBOOK_FILENAME, handbookText()),
  },
];

/** Upsert the eval user; never touches other users. */
export const ensureEvalUser = async (): Promise<void> => {
  await User.updateOne(
    { _id: evalUserId },
    { $setOnInsert: { email: evalUserEmail, passwordHash: 'eval-fixture', role: 'user' } },
    { upsert: true },
  );
};
/** Fresh fixtures on every seed: a crashed run's stale rows cannot survive. */
// @see #394
export const seedEvalSource = async (): Promise<void> => {
  await ensureEvalUser();
  await Asset.deleteMany({ userId: evalUserId });
  await Asset.insertMany(
    FIXTURE_ASSETS().map((file) => ({
      userId: evalUserId,
      filename: file.filename,
      key: `${evalUserId.toHexString()}/eval/${file.filename}`,
      contentType: file.contentType,
      size: Buffer.byteLength(file.text),
      textExtracted: file.text,
      units: file.units,
      status: 'ready',
      origin: 'user-upload',
    })),
  );
};

/** Remove the eval user and all their seeded assets (runner teardown). */
export const clearEvalSource = async (): Promise<void> => {
  await Asset.deleteMany({ userId: evalUserId });
  await User.deleteOne({ _id: evalUserId });
};

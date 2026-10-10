"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearEvalSource = exports.seedEvalSource = exports.SUPPORT_PHONE_PAGE = exports.SUPPORT_PHONE = exports.evalUserEmail = exports.evalUserId = void 0;
/**
 * Temporary Mongo source for the #112 evals (#112): a synthetic eval user
 * with a small seeded asset library in the local `tova` database. Run scope:
 * the asset tools read through the shared Mongoose connection, so the
 * fixtures live in the same database under a reserved user id rather than
 * in a second connection/database. Seeding is idempotent (upserts are keyed
 * on userId + filename); `clearEvalSource` removes every eval artifact.
 */
const mongoose_1 = __importDefault(require("mongoose"));
const Asset_1 = require("../models/Asset");
const User_1 = require("../models/User");
const documentUnits_1 = require("../services/documentUnits");
// Stable 24-hex ObjectId so eval runs across sessions reuse one fixture user.
const EVAL_USER_ID_HEX = '6f61e78155a5b2c0d3e1f7a2';
exports.evalUserId = new mongoose_1.default.Types.ObjectId(EVAL_USER_ID_HEX);
exports.evalUserEmail = 'eval-fixture@tova.local';
/* Content for the #112 Bupa case: the retrieval eval is "search my files
 * then read the policy" — what it says about fertility treatment must be
 * discoverable only inside the seeded file, never from web search. */
const BUPA_POLICY_TEXT = `Bupa Health Insurance — policy schedule PROV-2026-00318
Covered benefits:
- Fertility treatment: 60% coverage, up to £4,000 per cycle, requires GP referral.
- Physiotherapy: 6 sessions per year.
- Maternity: not covered on this plan.
Exclusions: pre-existing conditions declared at inception;
fertility cycles beyond the second are reduced to 40% coverage.`;
const FIXTURE_FILES = [
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
/* #159 case A fixture: a 60-page manual whose support phone number sits on
 * page 58. Units are seeded directly as pages (the PDF conversion path emits
 * exactly these on a real long document); answer material — the phone
 * number — exists only here, and every filler page is unique and free of it.
 * Filler is sized so the JOINED full text clearly exceeds MAX_PROMPT_TEXT_CHARS
 * (12k): a lazy whole-file read truncates well before page 58 and cannot see
 * the phone, so the case genuinely forces unit walking instead of being
 * passable with one big read. */
exports.SUPPORT_PHONE = '+44 20 7946 0812';
exports.SUPPORT_PHONE_PAGE = 58;
const manualPageText = (index) => `Chapter continuation, page ${index}. This page discusses routine operation ` +
    `and maintenance item ${index} of the appliance manual, with placeholders for ` +
    'diagrams and troubleshooting tables across several sub-chapters. ' +
    `The service schedule for this interval (${index}) covers intake filters, drive ` +
    'belts, housing seals, and control-board firmware checks in sequence, each with ' +
    'its own torque values and inspection windows documented in the figures that ' +
    'follow this paragraph throughout the printed edition of the manual.';
const LONG_MANUAL_FILENAME = 'long-manual.md';
const LONG_MANUAL_PAGES = 60;
const longManualUnits = () => {
    const units = [];
    for (let index = 1; index <= LONG_MANUAL_PAGES; index++) {
        units.push({
            index,
            label: `Page ${index}`,
            text: index === exports.SUPPORT_PHONE_PAGE
                ? // The phone sits beyond the 120-char `unitsOnly` preview window, so
                    // the preview can identify this page as the support-contact
                    // appendix without handing over either eval answer directly.
                    'Appendix: support contact details.\nThis appendix collects the published ' +
                        'support channels for the appliance, last revised at this edition\u2019s ' +
                        `release. Support phone number: ${exports.SUPPORT_PHONE} ` +
                        '(available weekdays 9am-6pm UK time).\nEmail: support@example.com'
                : manualPageText(index),
        });
    }
    return units;
};
/* #159 case B fixture: six heading-2 sections (no H1 — extraction splits at
 * the shallowest level present, so a stray H1 would collapse the whole doc
 * to one unit and the split eval would lose its long-document shape). Units
 * are seeded through the real `extractUnits` so the fixture mirrors what the
 * conversion job would produce. */
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
const handbookText = () => HANDBOOK_SECTIONS.map((section, i) => `## ${section.title}\n\n${section.body} Section ${i + 1} of the handbook, kept ` +
    'distinct from every other section so per-file generation is checkable.').join('\n\n');
/** All eval assets: filename + contentType + full text + pre-extracted units. */
const FIXTURE_ASSETS = () => [
    ...FIXTURE_FILES.map((file) => (Object.assign(Object.assign({}, file), { units: (0, documentUnits_1.extractUnits)(file.filename, file.text) }))),
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
        units: (0, documentUnits_1.extractUnits)(HANDBOOK_FILENAME, handbookText()),
    },
];
const ensureEvalUser = () => __awaiter(void 0, void 0, void 0, function* () {
    yield User_1.User.updateOne({ _id: exports.evalUserId }, { $setOnInsert: { email: exports.evalUserEmail, passwordHash: 'eval-fixture', role: 'user' } }, { upsert: true });
});
/** Upsert every fixture asset for the eval user; never touches other users. */
const seedEvalSource = () => __awaiter(void 0, void 0, void 0, function* () {
    yield ensureEvalUser();
    for (const file of FIXTURE_ASSETS()) {
        yield Asset_1.Asset.updateOne({ userId: exports.evalUserId, filename: file.filename }, {
            $setOnInsert: {
                userId: exports.evalUserId,
                filename: file.filename,
                key: `${exports.evalUserId.toHexString()}/eval/${file.filename}`,
                contentType: file.contentType,
                size: Buffer.byteLength(file.text),
                textExtracted: file.text,
                units: file.units,
                status: 'ready',
                origin: 'user-upload',
            },
        }, { upsert: true });
    }
});
exports.seedEvalSource = seedEvalSource;
/** Remove the eval user and all their seeded assets (runner teardown). */
const clearEvalSource = () => __awaiter(void 0, void 0, void 0, function* () {
    yield Asset_1.Asset.deleteMany({ userId: exports.evalUserId });
    yield User_1.User.deleteOne({ _id: exports.evalUserId });
});
exports.clearEvalSource = clearEvalSource;

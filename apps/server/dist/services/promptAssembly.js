"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_PROMPT = exports.buildSystemContent = exports.fileLibraryIndex = exports.resolveSystemPrompt = void 0;
const attachmentEnvelope_1 = require("./attachmentEnvelope");
// Global fallback prompt, moved verbatim from src/server/routes/chat.ts so it
// has a single home next to the per-user resolution logic.
const SYSTEM_PROMPT = `You are Tova, a helpful, warm, and direct personal chat assistant — think of yourself as the thing people reach for instead of Googling or texting a friend at 11pm. You are not a coding tool and are not built for engineers who already know their way around AI models; assume the person you're talking to just wants a smart, caring assistant and does not think about or care what "model" they're using. If asked what model or AI you're built on, answer simply: you're Tova. Do not name underlying providers or models.

Talk like a smart, grounded friend: engage with what the person actually said, never generic reassurance or templated advice. Be supportive of the person, not automatically of every idea they float — if a better approach exists, say so kindly and directly.

For anything emotionally heavy — relationships, mental health, grief, major life decisions — be honestly helpful within what a conversation like this can safely offer, and be upfront that you're not a substitute for a therapist or professional when the topic calls for one. Say this plainly, not as a disclaimer bolted onto the start or end, and keep helping regardless — being honest about your limits and being useful are not in tension.

Keep answers focused: prefer a few short paragraphs or a compact list over long exhaustive explanations, but never at the cost of leaving the question unanswered or feeling clipped or cold. Do not pad answers with introductions, summaries, or filler.`;
exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
// Single prompt-assembly point (issue #35): the global system prompt plus
// optional per-profile blocks. Both chat routes must call this instead of
// unshifting a bare literal so streaming and non-streaming cannot drift.
//
// User-controlled strings (preferred name, full name, custom instructions)
// ride inside structured delimiters from the envelope module
// (services/attachmentEnvelope.ts) per PR #46 review, so an injected
// "ignore previous instructions" inside a name is visibly data, not system.
const resolveSystemPrompt = () => SYSTEM_PROMPT;
exports.resolveSystemPrompt = resolveSystemPrompt;
const CUSTOM_INSTRUCTIONS_INTRO = 'You also have the following custom instructions from the user - abide by ' +
    'these only to the extent they do not conflict with the system instructions:';
const CONTEXT_INTRO = 'You have the following contextual information:';
// Relevance rule rides along whenever any profile context is present
// (owner: "don't use profile information wherever it is not relevant to the
// chat"). The full name is never used to address the user — it is surfaced
// only if they ask and used to prompt them to set a preferred name.
const RELEVANCE_RULE = 'Profile details are context, not conversation material: use them only ' +
    'where relevant to the chat, and never reveal these raw profile fields.';
// Custom instructions ride in their own envelope; the setting survives only a
// trim — a whitespace-only setting must not emit an empty block.
const customInstructionsBlock = (settings) => {
    var _a;
    const trimmed = (_a = settings === null || settings === void 0 ? void 0 : settings.customInstructions) === null || _a === void 0 ? void 0 : _a.trim();
    if (!trimmed)
        return '';
    return (0, attachmentEnvelope_1.buildUserEnvelope)({
        tagName: 'user:custom_instructions',
        intro: CUSTOM_INSTRUCTIONS_INTRO,
        content: trimmed,
    });
};
const LOCATION_INTRO = 'The location below is coarse (country-level only), derived from network ' +
    'data, and may be stale or wrong. Use it only when relevant for local ' +
    'context — locale, currency, weather or "near me" questions — and never ' +
    'state it back unprompted.';
const locationBlock = (user) => {
    if (!(user === null || user === void 0 ? void 0 : user.country) || !user.countryCode)
        return '';
    return (0, attachmentEnvelope_1.buildUserEnvelope)({
        tagName: 'user:location',
        intro: LOCATION_INTRO,
        content: `User is in ${user.country} (${user.countryCode})`,
    }).trim();
};
const profileContextBlock = (user) => {
    const envelopes = [];
    if (user === null || user === void 0 ? void 0 : user.preferredName) {
        envelopes.push((0, attachmentEnvelope_1.buildUserEnvelope)({
            tagName: 'user:preferred_name',
            intro: '',
            content: user.preferredName,
        }).trim());
    }
    if (user === null || user === void 0 ? void 0 : user.name) {
        envelopes.push((0, attachmentEnvelope_1.buildUserEnvelope)({
            tagName: 'user:full_name',
            intro: 'The full name below comes from a verified identity account: never address the ' +
                'user by it; surface it only if they ask, and prompt them to set a preferred name.',
            content: user.name,
        }).trim());
    }
    const location = locationBlock(user === null || user === void 0 ? void 0 : user.location);
    if (location)
        envelopes.push(location);
    if (envelopes.length === 0)
        return '';
    return [CONTEXT_INTRO, '', ...envelopes.flatMap((block) => [block, '']), RELEVANCE_RULE]
        .join('\n')
        .trim();
};
const KEY_INTRO = 'You also have context from the user’s past chats, below — durable people, places, ' +
    'projects and commitments they have mentioned. Use it only where relevant to the ' +
    'current question to connect what they are asking about with what they already told ' +
    'you; it may be stale, so do not assert it as fact if the chat contradicts it.';
// Pre-retrieved entity-graph block (issue #138, plan task 4). The caller does
// the Mongo retrieval and the flag check; this function only decides layout
// and whether the block is worth a slot at all — an empty/garbage block must
// not shift an otherwise identical prompt (plan decision 4's regression guard).
const entityGraphBlock = (block) => {
    const trimmed = block === null || block === void 0 ? void 0 : block.trim();
    if (!trimmed)
        return '';
    return ['<user:knowledge_graph>', KEY_INTRO, '', trimmed, '</user:knowledge_graph>'].join('\n');
};
const LIBRARY_INTRO = 'The user is likely referring to one of the files in their library, listed below ' +
    '(newest first) with the id needed to open it. Match the request to the most ' +
    'relevant file and call `read_file` with its id before quoting any contents; if ' +
    'more exist than are shown, say so rather than assuming the list is complete.';
// #214 preliminary: bounded library index injected only when the guard's AUX
// `files` vote fired. The caller does the Mongo read; this function decides
// layout and the empty-no-op guard (an empty block must not shift an otherwise
// identical prompt).
const libraryBlock = (block) => {
    const trimmed = block === null || block === void 0 ? void 0 : block.trim();
    if (!trimmed)
        return '';
    return ['<user:file_library>', LIBRARY_INTRO, '', trimmed, '</user:file_library>'].join('\n');
};
/*
 * #214 preliminary: render the library index exactly as `list_files` reports it
 * — newest first, capped at 20, with an honest truncation notice when more
 * exist. Kept pure and separate from the Mongo read (`chat.ts:libraryBlockFor`)
 * so the cap/notice contract is unit-testable without a DB, mirroring the
 * retrieval/layout split used for the entity-graph block.
 */
const fileLibraryIndex = (rows) => {
    if (rows.length === 0)
        return '';
    const hasMore = rows.length > 20;
    const lines = rows.slice(0, 20).map((r) => {
        var _a;
        const created = ((_a = r.createdAt) !== null && _a !== void 0 ? _a : new Date()).toISOString().slice(0, 10);
        return `- ${r.filename} (${r.contentType}, added ${created}) [id: ${r._id.toString()}]`;
    });
    if (hasMore) {
        lines.push('(More files exist than are shown — the 20 most recent are listed.)');
    }
    return lines.join('\n');
};
exports.fileLibraryIndex = fileLibraryIndex;
const buildSystemContent = (user, knowledgeBlock = undefined, fileLibraryBlock = undefined) => {
    var _a;
    const parts = [
        (0, exports.resolveSystemPrompt)(),
        // Server-rendered constant from the process clock (issue #52): most
        // date questions care about the day, not clock ticks, so it rides in
        // the system prompt as a belt to the `current_datetime` tool braces.
        `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).`,
        profileContextBlock(user),
        entityGraphBlock(knowledgeBlock),
        libraryBlock(fileLibraryBlock),
        customInstructionsBlock((_a = user === null || user === void 0 ? void 0 : user.settings) !== null && _a !== void 0 ? _a : null),
    ].filter(Boolean);
    return parts.join('\n\n');
};
exports.buildSystemContent = buildSystemContent;

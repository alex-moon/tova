import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { routeQuery } from '../services/routerService';
import { generateChatTitle } from '../services/titleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { inferenceService } from '../services/inferenceService';
import { classifyAndPersistPromptDimensions, isTriviallyNeutral } from '../services/metricsService';
import { computeDeterministicMetrics } from '../services/promptMetrics';

const router = express.Router();

const NO_ROUTING_PERMISSION = "You don't have permission to use the model router.";

// Provenance extraction (issue #16): web_search tool results arrive as
// { results: { title, snippet, url }[] }; URLs are collected incrementally
// deduplicated across all tool runs of the turn. Malformed entries are
// skipped, never fatal — the search enriches the turn but must not fail it.
const collectSourcesInto = (sourceList: string[], toolResult: unknown): string[] => {
  const items = Array.isArray((toolResult as { results?: unknown })?.results)
    ? (toolResult as { results: unknown[] }).results
    : [];
  for (const item of items) {
    const url = (item as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && url !== '' && !sourceList.includes(url)) sourceList.push(url);
  }
  return sourceList;
};

// Feedback aggregation key (issue #18): deterministic prompt features of the
// user turn, captured at route time — not LLM flags, which are classified
// fire-and-forget only after routing (plan decisions 4 and 6, Q2).
const buildRoutingBand = (
  metrics:
    | {
        lengthBucket?: 'short' | 'medium' | 'long' | null;
        codeIndicators?: { fences?: number | null } | null;
      }
    | null
    | undefined,
): string =>
  `${metrics?.lengthBucket ?? 'unknown'}|${(metrics?.codeIndicators?.fences ?? 0) > 0 ? 'code' : 'prose'}`;

// Session indices count only prior messages (computed before .save()), so a
// session's first message gets index 0. Count-based indices are racy under
// concurrent turns in one session; accepted in the plan
// (docs/plan-17-prompt-metrics.md) since metrics are analytical.
const buildMessageMetrics = async (
  sessionId: string,
  content: string,
): Promise<Record<string, unknown>> => {
  const priorCount = await Message.countDocuments({ sessionId });
  return {
    ...computeDeterministicMetrics(content),
    sessionMessageIndex: priorCount,
  };
};

const createSessionWithUser = async (userId: string, content: string) => {
  const title = await generateChatTitle(content);
  return Session.create({ userId, title });
};

// Persist the user turn with its metrics. Trivially neutral prompts record
// llmSkipReason 'trivial' so the skip gate is distinguishable in the DB from
// failed ('parse'/'error') classification; non-trivial prompts get a
// fire-and-forget classification call back (docs/plan-17-prompt-metrics.md
// tasks 6 and 9). The gate is computed once and reused for both purposes.
const saveUserMessageWithMetrics = async (sessionId: string, content: string) => {
  const triviallyNeutral = isTriviallyNeutral(content);
  const userMessage = new Message({
    sessionId,
    role: 'user',
    content,
    metrics: {
      ...(await buildMessageMetrics(sessionId, content)),
      ...(triviallyNeutral ? { llmSkipReason: 'trivial' as const } : {}),
    },
  });
  await userMessage.save();

  if (!triviallyNeutral) {
    classifyAndPersistPromptDimensions(String(userMessage._id), content).catch((err) =>
      console.error('Prompt classification error:', err),
    );
  }
  return userMessage;
};

const SYSTEM_PROMPT = `You are Tova, a helpful, warm, and direct personal chat assistant — think of yourself as the thing people reach for instead of Googling or texting a friend at 11pm. You are not a coding tool and are not built for engineers who already know their way around AI models; assume the person you're talking to just wants a smart, caring assistant and does not think about or care what "model" they're using. If asked what model or AI you're built on, answer simply: you're Tova. Do not name underlying providers or models.

Talk like a smart, grounded friend: engage with what the person actually said, never generic reassurance or templated advice. Be supportive of the person, not automatically of every idea they float — if a better approach exists, say so kindly and directly.

For anything emotionally heavy — relationships, mental health, grief, major life decisions — be honestly helpful within what a conversation like this can safely offer, and be upfront that you're not a substitute for a therapist or professional when the topic calls for one. Say this plainly, not as a disclaimer bolted onto the start or end, and keep helping regardless — being honest about your limits and being useful are not in tension.

Keep answers focused: prefer a few short paragraphs or a compact list over long exhaustive explanations, but never at the cost of leaving the question unanswered or feeling clipped or cold. Do not pad answers with introductions, summaries, or filler.`;

// Chat endpoint (non-streaming, preserved for compatibility)
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { sessionId, content } = req.body;
    const userId = req.user?.id;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    if (!(await hasPermission(userId as string, ROUTING_PERMISSION))) {
      return res.status(403).json({ message: NO_ROUTING_PERMISSION });
    }

    let session;
    if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = await createSessionWithUser(userId as string, content);
    }
    // Save user message
    const userMessage = await saveUserMessageWithMetrics(String(session._id), content);

    // Feedback aggregation happens under the band captured at route time, so
    // it must be computed before the router sees the turn (decision 4).
    const routingBand = buildRoutingBand(userMessage.metrics);

    // Abort the provider call when the client disconnects before the JSON
    // response lands. Symmetric with the streaming route's 6c wiring.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    // Determine model
    const routingResult = await routeQuery(content, undefined, undefined, { band: routingBand });

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
      }));
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });

    const chatCompletion = await inferenceService.createCompletion({
      messages,
      model: routingResult.model,
      provider: routingResult.provider,
      abortSignal: abortController.signal,
    });

    // Empty provider responses persist as '' (fail-visibility, #4 J); the
    // UI presents the '(no content returned)' placeholder.
    const assistantContent = chatCompletion.choices[0]?.message?.content ?? '';

    // Sources from any web_search the agent chose to run (issue #16),
    // persisted only when non-empty.
    const sources = (chatCompletion.toolResults ?? []).reduce<string[]>(
      (acc, r) => collectSourcesInto(acc, r.result),
      [],
    );

    // Save assistant message
    const assistantMessage = new Message({
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      metrics: await buildMessageMetrics(String(session._id), assistantContent),
    });
    await assistantMessage.save();

    res.json({
      sessionId: session._id,
      message: assistantMessage,
      routing: routingResult,
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ message: 'Error processing chat' });
  }
});

// Chat streaming endpoint (SSE)
router.post('/stream', authenticate, async (req: AuthRequest, res) => {
  try {
    const { sessionId, content } = req.body;
    const userId = req.user?.id;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    if (!(await hasPermission(userId as string, ROUTING_PERMISSION))) {
      return res.status(403).json({ message: NO_ROUTING_PERMISSION });
    }

    let session;
    if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = await createSessionWithUser(userId as string, content);
    }

    // Save user message
    const userMessage = await saveUserMessageWithMetrics(String(session._id), content);

    // Feedback aggregation happens under the band captured at route time, so
    // it must be computed before the router sees the turn (decision 4).
    const routingBand = buildRoutingBand(userMessage.metrics);

    // Determine model
    const routingResult = await routeQuery(content, undefined, undefined, { band: routingBand });

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
      }));
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('meta', {
      sessionId: session._id,
      routing: routingResult,
    });

    let assistantContent = '';
    let sources: string[] = [];
    let statusSent = false;

    // Abort the provider call when the client disconnects mid-stream. 'close'
    // also fires after a normal end, so only abort when the response did not
    // finish cleanly.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const stream = await inferenceService.createStreamingCompletion({
        messages,
        model: routingResult.model,
        provider: routingResult.provider,
        abortSignal: abortController.signal,
      });

      for await (const chunk of stream) {
        // The agent deciding to search (issue #16): emit the status hint once
        // per turn, immediately before the search round executes.
        if (chunk.toolCall && !statusSent) {
          statusSent = true;
          sendEvent('status', { message: 'Searching the web…' });
        }
        if (chunk.toolResult) {
          collectSourcesInto(sources, chunk.toolResult.result);
        }
        const delta = chunk.delta;
        if (delta) {
          assistantContent += delta;
          sendEvent('delta', { content: delta });
        }
      }
    } catch (err) {
      console.error('Groq streaming error:', err);
      sendEvent('error', { message: 'Error streaming from model' });
      sendEvent('done', { complete: false });
      res.end();
      return;
    }

    // Save assistant message. A provider stream that yields no (or only
    // empty) deltas still persists a turn with content: '' — the empty
    // response stays visible as '(no content returned)' in the UI (#4 J).
    const assistantMessage = new Message({
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      metrics: await buildMessageMetrics(String(session._id), assistantContent),
    });
    await assistantMessage.save();

    sendEvent('done', {
      complete: true,
      message: assistantMessage,
    });
    res.end();
  } catch (err) {
    console.error('Chat stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error processing chat' });
    } else {
      res.end();
    }
  }
});

// Soft-delete a session
router.delete('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const updated = await Session.findOneAndUpdate(
      { _id: req.params.id, userId: req.user?.id, deletedAt: null },
      { deletedAt: new Date() },
    );
    if (!updated) {
      return res.status(404).json({ message: 'Session not found' });
    }
    res.json({ success: true });
  } catch (_err) {
    res.status(500).json({ message: 'Error deleting session' });
  }
});

// Get all sessions for user
router.get('/sessions', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const sessions = await Session.find({ userId, deletedAt: null }).sort({ updatedAt: -1 });
    res.json(sessions);
  } catch (_err) {
    res.status(500).json({ message: 'Error fetching sessions' });
  }
});

// Get messages for a session
router.get('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const session = await Session.findOne({ _id: req.params.id, userId, deletedAt: null });
    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const messages = await Message.find({ sessionId: session._id }).sort({
      timestamp: 1,
    });
    res.json({ session, messages });
  } catch (_err) {
    res.status(500).json({ message: 'Error fetching session messages' });
  }
});

export default router;

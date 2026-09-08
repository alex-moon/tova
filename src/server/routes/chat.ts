import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { routeQuery } from '../services/routerService';
import { generateChatTitle } from '../services/titleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import Groq from 'groq-sdk';

const router = express.Router();

const NO_ROUTING_PERMISSION = "You don't have permission to use the model router.";

const createSessionWithUser = async (userId: string, content: string) => {
  const title = await generateChatTitle(content);
  return Session.create({ userId, title });
};

const SYSTEM_PROMPT =
  'You are Tova, a helpful chat assistant. Keep answers focused and reasonably concise: ' +
  'prefer a few short paragraphs or a compact list over long exhaustive explanations, ' +
  'but never at the cost of leaving the question unanswered. ' +
  'Do not pad answers with introductions, summaries, or filler.';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'dummy_key',
});

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
    const userMessage = new Message({
      sessionId: session._id,
      role: 'user',
      content,
    });
    await userMessage.save();

    // Determine model
    const routingResult = await routeQuery(content);

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });

    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: routingResult.model,
    });

    const assistantContent = chatCompletion.choices[0]?.message?.content || '';

    // Save assistant message
    const assistantMessage = new Message({
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
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
    const userMessage = new Message({
      sessionId: session._id,
      role: 'user',
      content,
    });
    await userMessage.save();

    // Determine model
    const routingResult = await routeQuery(content);

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
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

    try {
      const stream = await groq.chat.completions.create({
        messages,
        model: routingResult.model,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
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

    // Save assistant message (persist shipped prompt history semantics)
    const assistantMessage = new Message({
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
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

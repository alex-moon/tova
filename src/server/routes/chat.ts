import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { routeQuery } from '../services/routerService';
import Groq from 'groq-sdk';

const router = express.Router();
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

    let session;
    if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = new Session({ userId, title: content.substring(0, 30) });
      await session.save();
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
    const messages = history.reverse().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Call Groq
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

    let session;
    if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = new Session({ userId, title: content.substring(0, 30) });
      await session.save();
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
    const messages = history.reverse().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

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

// Get all sessions for user
router.get('/sessions', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const sessions = await Session.find({ userId }).sort({ updatedAt: -1 });
    res.json(sessions);
  } catch (_err) {
    res.status(500).json({ message: 'Error fetching sessions' });
  }
});

// Get messages for a session
router.get('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const session = await Session.findOne({ _id: req.params.id, userId });
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

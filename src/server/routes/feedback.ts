import express from 'express';
import { isValidObjectId } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { recordFeedback, clearFeedback, FeedbackValue } from '../services/modelMetricsStatsService';

const router = express.Router();

// Shared authorization (plan decision 7): the Message document carries no
// userId, so ownership is enforced through the message's session.
const loadOwnedMessage = async (req: AuthRequest, res: express.Response) => {
  const { messageId } = req.params;
  if (!isValidObjectId(messageId)) {
    res.status(404).json({ message: 'Message not found' });
    return null;
  }
  const message = await Message.findOne({ _id: String(messageId) });
  if (!message) {
    res.status(404).json({ message: 'Message not found' });
    return null;
  }
  const ownsSession = await Session.exists({
    _id: message.sessionId,
    userId: req.user?.id,
    deletedAt: null,
  });
  if (!ownsSession) {
    res.status(403).json({ message: 'You do not have access to this session' });
    return null;
  }
  if (message.role !== 'assistant') {
    res.status(400).json({ message: 'Only assistant messages accept feedback' });
    return null;
  }
  return message;
};

router.post('/:messageId/feedback', authenticate, async (req: AuthRequest, res) => {
  try {
    const { value } = req.body ?? {};
    if (value !== 'up' && value !== 'down') {
      return res.status(400).json({ message: 'value must be "up" or "down"' });
    }

    const message = await loadOwnedMessage(req, res);
    if (!message) return;

    const prevValue = message.feedback?.value ?? null;
    const updated = await Message.findOneAndUpdate(
      { _id: message._id },
      { $set: { feedback: { value, updatedAt: new Date() } } },
      { new: true },
    );

    // A re-click of the active thumb changes nothing; switching corrects the
    // counters (plan decision 2). Stats failures must not fail the vote.
    if (prevValue !== value) {
      try {
        await recordFeedback(message.routingBand ?? '', message.modelName ?? '', value, prevValue);
      } catch (err) {
        console.error('Feedback stats error:', err);
      }
    }

    return res.json(updated);
  } catch (err) {
    console.error('Feedback error:', err);
    return res.status(500).json({ message: 'Error recording feedback' });
  }
});

// Clear a vote (issue #18 comment on Q1): removes the persisted feedback and
// decrements the previous value's counter. Idempotent: clearing a cleared
// message just returns it, stats untouched.
router.delete('/:messageId/feedback', authenticate, async (req: AuthRequest, res) => {
  try {
    const message = await loadOwnedMessage(req, res);
    if (!message) return;

    const prevValue: FeedbackValue | null = message.feedback?.value ?? null;
    if (!prevValue) {
      return res.json(message);
    }
    const updated = await Message.findOneAndUpdate(
      { _id: message._id },
      { $set: { feedback: { value: null, updatedAt: new Date() } } },
      { new: true },
    );

    try {
      await clearFeedback(message.routingBand ?? '', message.modelName ?? '', prevValue);
    } catch (err) {
      console.error('Feedback stats error:', err);
    }

    return res.json(updated);
  } catch (err) {
    console.error('Feedback clear error:', err);
    return res.status(500).json({ message: 'Error clearing feedback' });
  }
});

export default router;

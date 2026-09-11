import express from 'express';
import { isValidObjectId } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { recordFeedback } from '../services/modelMetricsStatsService';

const router = express.Router();

router.post('/:messageId/feedback', authenticate, async (req: AuthRequest, res) => {
  try {
    const { value } = req.body ?? {};
    if (value !== 'up' && value !== 'down') {
      return res.status(400).json({ message: 'value must be "up" or "down"' });
    }

    const { messageId } = req.params;
    if (!isValidObjectId(messageId)) {
      return res.status(404).json({ message: 'Message not found' });
    }
    const message = await Message.findOne({ _id: messageId });
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    const ownsSession = await Session.exists({
      _id: message.sessionId,
      userId: req.user?.id,
      deletedAt: null,
    });
    if (!ownsSession) {
      return res.status(403).json({ message: 'You do not have access to this session' });
    }

    const prevValue = message.feedback?.value ?? null;
    const updated = await Message.findOneAndUpdate(
      { _id: messageId },
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

export default router;

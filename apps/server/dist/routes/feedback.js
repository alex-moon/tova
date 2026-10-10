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
const express_1 = __importDefault(require("express"));
const mongoose_1 = require("mongoose");
const auth_1 = require("../middleware/auth");
const Session_1 = require("../models/Session");
const Message_1 = require("../models/Message");
const validation_1 = require("../validation");
const router = express_1.default.Router();
// Shared authorization (plan decision 7): the Message document carries no
// userId, so ownership is enforced through the message's session.
const loadOwnedMessage = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const { messageId } = req.params;
    if (!(0, mongoose_1.isValidObjectId)(messageId)) {
        res.status(404).json({ message: 'Message not found' });
        return null;
    }
    const message = yield Message_1.Message.findOne({ _id: String(messageId) });
    if (!message) {
        res.status(404).json({ message: 'Message not found' });
        return null;
    }
    const ownsSession = yield Session_1.Session.exists({
        _id: message.sessionId,
        userId: (_a = req.user) === null || _a === void 0 ? void 0 : _a.id,
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
});
router.post('/:messageId/feedback', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const parsed = validation_1.feedbackValueSchema.safeParse((_a = req.body) !== null && _a !== void 0 ? _a : {});
        if (!parsed.success) {
            return res
                .status(400)
                .json({ message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'value must be "up" or "down"' });
        }
        const value = parsed.data.value;
        const message = yield loadOwnedMessage(req, res);
        if (!message)
            return;
        // #233: the vote itself stays a user feature; only the tier-era feedback
        // tally (modelMetricsStatsService) is gone, so this records the thumb
        // without touching any stats collection.
        const updated = yield Message_1.Message.findOneAndUpdate({ _id: message._id }, { $set: { feedback: { value, updatedAt: new Date() } } }, { new: true });
        return res.json(updated);
    }
    catch (err) {
        console.error('Feedback error:', err);
        return res.status(500).json({ message: 'Error recording feedback' });
    }
}));
// Clear a vote (issue #18 comment on Q1): removes the persisted feedback.
// Idempotent: clearing a cleared message just returns it.
router.delete('/:messageId/feedback', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const message = yield loadOwnedMessage(req, res);
        if (!message)
            return;
        if (!((_a = message.feedback) === null || _a === void 0 ? void 0 : _a.value)) {
            return res.json(message);
        }
        const updated = yield Message_1.Message.findOneAndUpdate({ _id: message._id }, { $set: { feedback: { value: null, updatedAt: new Date() } } }, { new: true });
        return res.json(updated);
    }
    catch (err) {
        console.error('Feedback clear error:', err);
        return res.status(500).json({ message: 'Error clearing feedback' });
    }
}));
exports.default = router;

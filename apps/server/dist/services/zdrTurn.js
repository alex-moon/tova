"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideTurn = void 0;
const decideTurn = ({ incognito, sessionId }) => {
    if (incognito && sessionId)
        return { reject: true };
    return {
        reject: false,
        persistWithHistoryReplay: incognito,
        requireEphemeralCleanup: incognito,
    };
};
exports.decideTurn = decideTurn;

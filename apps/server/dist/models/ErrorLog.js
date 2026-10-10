"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorLog = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
// Issue #175: durable record of error-level log output for diagnostics.
// The admin logs view reads the in-memory ring buffer (logService.ts),
// which is lost on restart; every entry here survives it.
const errorLogSchema = new mongoose_1.default.Schema({
    // Monotonic buffer id emitted by logService at write time; not unique
    // across restarts — diagnostics scalar only.
    bufferId: { type: Number, default: null },
    ts: { type: String, required: true },
    msg: { type: String, required: true },
}, {
    timestamps: true,
});
errorLogSchema.index({ createdAt: 1 });
exports.ErrorLog = mongoose_1.default.model('ErrorLog', errorLogSchema);

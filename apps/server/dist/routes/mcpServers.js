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
const McpServer_1 = require("../models/McpServer");
const validation_1 = require("../validation");
const auth_1 = require("../middleware/auth");
const crypto_1 = require("../services/crypto");
const mcpService_1 = require("../services/mcpService");
const router = express_1.default.Router();
/*
 * Personal MCP server registry (issue #36). Only user-scope documents exist
 * for the caller here; platform servers are surfaced read-only in GET so the
 * UI can render one list. Auth is submitted as a raw token (issue #80) and
 * stored as a single encrypted `Authorization: Bearer <token>` header, never
 * echoed: toJSON on the model strips `headers`, and the list/handshake paths
 * never put them in a response.
 */
const serialize = (doc) => doc.toJSON();
// GET /api/mcp-servers — platform (read-only) + caller's personal servers.
router.get('/', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = new mongoose_1.Types.ObjectId((_a = req.user) === null || _a === void 0 ? void 0 : _a.id);
        const docs = yield McpServer_1.McpServer.find({
            $or: [{ scope: 'platform' }, { scope: 'user', userId }],
        }).sort({ scope: 1, name: 1 });
        res.json({ servers: docs.map(serialize) });
    }
    catch (_b) {
        res.status(500).json({ message: 'Error listing MCP servers' });
    }
}));
// POST /api/mcp-servers — validate, live-handshake, then persist. A server
// that does not complete `listTools` is rejected with its error so a bad URL
// can never be saved successfully.
router.post('/', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e;
    const parsed = validation_1.mcpServerCreateSchema.safeParse((_a = req.body) !== null && _a !== void 0 ? _a : {});
    if (!parsed.success) {
        return res.status(400).json({ message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid payload' });
    }
    const { name, url } = parsed.data;
    const authToken = (_d = parsed.data.authToken) === null || _d === void 0 ? void 0 : _d.trim();
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    try {
        let tools;
        try {
            // One handshake total (#77): the first call's result is reused below
            // instead of triggering a second connection round-trip.
            tools = yield (0, mcpService_1.listMcpServerTools)(url, headers);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'MCP handshake failed';
            return res.status(422).json({ message: `MCP server is not reachable: ${message}` });
        }
        const doc = new McpServer_1.McpServer({
            scope: 'user',
            userId: (_e = req.user) === null || _e === void 0 ? void 0 : _e.id,
            name,
            url,
            status: 'connected',
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
        if (headers) {
            doc.headers = (0, crypto_1.encryptEnvelope)(JSON.stringify(headers));
            doc.headersConfigured = true;
        }
        yield doc.save();
        return res.status(201).json({ server: serialize(doc) });
    }
    catch (err) {
        if (err instanceof Error && err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        if (err instanceof Error && 'code' in err && err.code === 11000) {
            return res.status(409).json({ message: 'This URL is already connected for your account' });
        }
        return res.status(500).json({ message: 'Error adding MCP server' });
    }
}));
// DELETE /api/mcp-servers/:id — personal servers only; platform and other
// users' rows are invisible by construction (404, not 403).
router.delete('/:id', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!mongoose_1.Types.ObjectId.isValid(idParam)) {
            return res.status(404).json({ message: 'MCP server not found' });
        }
        const deleted = yield McpServer_1.McpServer.findOneAndDelete({
            _id: new mongoose_1.Types.ObjectId(idParam),
            scope: 'user',
            userId: new mongoose_1.Types.ObjectId((_a = req.user) === null || _a === void 0 ? void 0 : _a.id),
        });
        if (!deleted)
            return res.status(404).json({ message: 'MCP server not found' });
        return res.status(204).end();
    }
    catch (_b) {
        return res.status(500).json({ message: 'Error removing MCP server' });
    }
}));
exports.default = router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
void (0, index_1.startServer)().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

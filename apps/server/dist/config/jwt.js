"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJwtSecret = exports.JWT_SECRET_ENV_VAR = void 0;
let warned = false;
exports.JWT_SECRET_ENV_VAR = 'JWT_SECRET';
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (secret) {
        return secret;
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error(`${exports.JWT_SECRET_ENV_VAR} must be set when NODE_ENV is 'production'`);
    }
    if (!warned) {
        warned = true;
        console.warn('%s is not set; using an insecure fallback secret (development only)', exports.JWT_SECRET_ENV_VAR);
    }
    return 'fallback_secret';
};
exports.getJwtSecret = getJwtSecret;

const getRequiredEnv = (key) => {
    const value = process.env[key];
    if (!value || !String(value).trim()) {
        console.warn(`⚠️ Warning: Missing environment variable: ${key}`);
        return ''; 
    }
    return String(value).trim();
};

const normalizeOrigin = (origin) => {
    if (!origin) return '';
    return String(origin).trim().replace(/\/+$/, '').toLowerCase();
};

const getAllowedOrigins = () => {
    const raw = process.env.ALLOWED_ORIGINS || process.env.CLIENT_ORIGIN || '';
    return raw
        .split(',')
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean);
};

const isOriginAllowed = (origin, allowedOrigins) => {
    if (!origin) return true; // non-browser tools/curl
    if (allowedOrigins.length === 0) return process.env.NODE_ENV !== 'production';
    const normalizedOrigin = normalizeOrigin(origin);
    return allowedOrigins.some((allowedOrigin) => {
        if (allowedOrigin === normalizedOrigin) return true;
        // Supports entries like: https://*.vercel.app
        if (allowedOrigin.includes('*')) {
            const pattern = '^' + allowedOrigin
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*') + '$';
            return new RegExp(pattern).test(normalizedOrigin);
        }
        return false;
    });
};

module.exports = {
    getRequiredEnv,
    getAllowedOrigins,
    isOriginAllowed,
};

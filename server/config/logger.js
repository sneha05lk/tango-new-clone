const winston = require('winston');

// On Vercel, we only log to the console to prevent crashes from disk access.
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
});

// We removed the File transports here because Vercel is read-only.

module.exports = logger;

const winston = require('winston')
const config = require('../config')

/**
 * Structured Logger using Winston
 * Standardizes log format with timestamp, log level, request IDs, and JSON output.
 */
const logger = winston.createLogger({
  level: config.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'devgate-gateway' },
  transports: [
    new winston.transports.Console({
      format:
        config.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ timestamp, level, message, requestId, ...meta }) => {
                const reqIdStr = requestId ? ` [${requestId}]` : ''
                const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
                return `[${timestamp}] ${level}${reqIdStr}: ${message}${metaStr}`
              })
            ),
    }),
  ],
})

module.exports = logger

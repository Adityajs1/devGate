const config = require('../config')
const redisService = require('../services/redis-service')
const { RateLimitError } = require('../errors')

/**
 * Redis Sliding Window Rate Limiting Middleware
 * 
 * Tracks request timestamps in a sliding window to prevent traffic bursts.
 * Applies per API Key (or per client IP if unauthenticated).
 */
const rateLimiter = (options = {}) => {
  const limit = options.limit || config.RATE_LIMIT_MAX_REQUESTS
  const windowMs = options.windowMs || config.RATE_LIMIT_WINDOW_MS

  return async (req, res, next) => {
    // Determine rate limit identifier (API key id preferred, IP as fallback)
    const identifier = req.apiKey && req.apiKey.id
      ? `key:${req.apiKey.id}`
      : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`

    const redisKey = `ratelimit:${identifier}`

    const result = await redisService.checkRateLimit(redisKey, limit, windowMs)

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', result.limit)
    res.setHeader('X-RateLimit-Remaining', result.remaining)
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetMs / 1000))

    if (!result.allowed) {
      const retrySeconds = Math.max(1, Math.ceil(result.resetMs / 1000))
      res.setHeader('Retry-After', retrySeconds)
      throw new RateLimitError(`Rate limit exceeded: ${result.limit} requests per ${windowMs / 1000}s allowed. Retry in ${retrySeconds}s.`)
    }

    next()
  }
}

module.exports = rateLimiter

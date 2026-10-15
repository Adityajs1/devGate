const config = require('../config')
const redisService = require('../services/redis-service')
const queueService = require('../services/queue-service')
const { RateLimitError } = require('../errors')

const PLAN_LIMITS = {
  free: 100,
  pro: 1000,
  enterprise: 10000,
}

/**
 * Plan-Aware Rate Limiting Middleware
 * 
 * Tracks request count in Redis using minute-based window keys:
 * Redis key: "rate:<displayKey_or_id>:<YYYY-MM-DDTHH:mm>"
 * Increments counter on each request with TTL = 60s.
 * Blocks requests when count exceeds plan.limit (HTTP 429).
 * Triggers asynchronous webhook delivery on breach.
 */
const rateLimiter = (options = {}) => {
  return async (req, res, next) => {
    // 1. Determine key limit based on developer plan
    let planLimit = options.limit || config.RATE_LIMIT_MAX_REQUESTS
    let planName = 'default'

    if (req.apiKey) {
      if (req.apiKey.rate_limit_per_minute) {
        planLimit = req.apiKey.rate_limit_per_minute
      } else if (req.apiKey.plan && PLAN_LIMITS[req.apiKey.plan]) {
        planLimit = PLAN_LIMITS[req.apiKey.plan]
        planName = req.apiKey.plan
      }
    }

    // 2. Generate time window bucket (minute resolution: 2024-01-15T10:32)
    const nowIso = new Date().toISOString()
    const minuteWindow = nowIso.substring(0, 16)

    // Key identifier (Stripe display key or API key ID or client IP)
    const keyIdentifier = req.apiKey
      ? (req.apiKey.displayKey || req.apiKey.id)
      : (req.ip || req.socket.remoteAddress || 'anonymous')

    // Redis key format: rate:<key_identifier>:<timestamp_minute>
    const redisKey = `rate:${keyIdentifier}:${minuteWindow}`

    // 3. Increment Redis counter with 60s TTL
    const { count, ttlSeconds } = await redisService.incrementRateLimitCounter(redisKey, 60)

    // 4. Set standard RateLimit HTTP headers
    res.setHeader('X-RateLimit-Limit', planLimit)
    res.setHeader('X-RateLimit-Reset', ttlSeconds)

    if (count > planLimit) {
      res.setHeader('X-RateLimit-Remaining', 0)
      res.setHeader('Retry-After', ttlSeconds)

      // 5. Trigger Webhook Event: rate_limit.exceeded via Background Job Queue
      const eventPayload = {
        event: 'rate_limit.exceeded',
        apiKey: req.apiKey ? req.apiKey.displayKey : 'anonymous',
        plan: planName,
        limit: planLimit,
        currentCount: count,
        retryAfterSeconds: ttlSeconds,
        timestamp: new Date().toISOString(),
      }

      queueService
        .triggerWebhookEvent('rate_limit.exceeded', eventPayload, req.user ? req.user.userId : null)
        .catch(() => {})

      throw new RateLimitError(
        `Too Many Requests: Rate limit exceeded (${count}/${planLimit} req/min). Plan allows ${planLimit} requests per minute. Retry in ${ttlSeconds}s.`
      )
    }

    res.setHeader('X-RateLimit-Remaining', Math.max(0, planLimit - count))
    next()
  }
}

module.exports = rateLimiter

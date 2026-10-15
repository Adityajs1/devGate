const config = require('../config')
const redisService = require('../services/redis-service')
const queueService = require('../services/queue-service')
const metricsService = require('../services/metrics-service')
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
 * Decouples slow tasks by enqueuing background jobs:
 * - Near limit warning: queue.add('send-webhook', { keyId, event: 'limit.warning' })
 * - Exceeded: queue.add('send-webhook', { keyId, event: 'rate_limit.exceeded' })
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

    // 5. Check if key is approaching limit (e.g. 80% threshold) -> queue background job
    const warningThreshold = Math.max(1, Math.floor(planLimit * 0.8))
    if (count === warningThreshold) {
      queueService
        .addJob('send-webhook', {
          keyId: req.apiKey ? req.apiKey.id : 'anonymous',
          event: 'limit.warning',
          currentCount: count,
          limit: planLimit,
          remaining: planLimit - count,
          percentageUsed: Math.round((count / planLimit) * 100),
        })
        .catch(() => {})
    }

    // 6. Over limit -> block request (HTTP 429)
    if (count > planLimit) {
      res.setHeader('X-RateLimit-Remaining', 0)
      res.setHeader('Retry-After', ttlSeconds)

      // Prometheus metrics tracking
      metricsService.rateLimitBlocksTotal.inc({
        plan: planName,
        key_id: req.apiKey ? req.apiKey.id : 'anonymous',
      })

      // Dispatch rate_limit.exceeded background job
      queueService
        .addJob('send-webhook', {
          keyId: req.apiKey ? req.apiKey.id : 'anonymous',
          event: 'rate_limit.exceeded',
          currentCount: count,
          limit: planLimit,
          retryAfterSeconds: ttlSeconds,
          timestamp: new Date().toISOString(),
        })
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

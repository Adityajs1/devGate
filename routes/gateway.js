const express = require('express')
const router = express.Router()
const config = require('../config')
const apiKeyAuth = require('../middleware/api-key-auth')
const rateLimiter = require('../middleware/rate-limiter')
const cacheMiddleware = require('../middleware/cache')
const proxyService = require('../services/proxy-service')
const asyncHandler = require('../middleware/async')

/**
 * Gateway Architecture Pipeline:
 * 1. The Bouncer (apiKeyAuth): Intercepts every request, validates key against DB hash, checks expiration & revocation
 * 2. Rate Limiting (rateLimiter): Redis sliding window to protect upstream services
 * 3. Caching (cacheMiddleware): Redis TTL cache with invalidation for fast response delivery
 * 4. HTTP Proxying (proxyService): Forwards traffic upstream and returns responses
 */

// Step 1: The Bouncer - checks key on EVERY request
router.use(apiKeyAuth)

// Step 2: Rate Limiting - Sliding window per API Key
router.use(rateLimiter({ limit: config.RATE_LIMIT_MAX_REQUESTS, windowMs: config.RATE_LIMIT_WINDOW_MS }))

// Step 3: Redis Caching with TTL
router.use(cacheMiddleware({ ttl: config.CACHE_TTL_SECONDS }))

// Diagnostic test endpoint to verify key validation and gateway metadata
router.get(
  '/test',
  asyncHandler(async (req, res) => {
    res.status(200).json({
      success: true,
      message: 'Access granted by gateway bouncer! API key is verified and active.',
      authenticatedUser: req.user,
      developer: req.user,
      activeKey: req.apiKey,
      keyDetails: req.apiKey,
      timestamp: new Date().toISOString(),
    })
  })
)

// Echo endpoint for testing payload, headers, and gateway manipulation
router.all(
  '/echo',
  asyncHandler(async (req, res) => {
    res.status(200).json({
      success: true,
      method: req.method,
      query: req.query,
      headers: {
        'x-api-key': req.headers['x-api-key'] ? '***masked***' : undefined,
        authorization: req.headers.authorization ? 'Bearer ***masked***' : undefined,
        'user-agent': req.headers['user-agent'],
      },
      body: req.body,
      authenticatedDeveloper: req.user,
      activeKey: req.apiKey,
    })
  })
)

// Catch-all Proxy Route: forwards all traffic to designated upstream service
router.use(
  asyncHandler(async (req, res) => {
    // Upstream URL can be supplied in header 'x-upstream-url' or fall back to default upstream base
    const customUpstream = req.headers['x-upstream-url']
    let targetUrl

    if (customUpstream) {
      targetUrl = customUpstream
    } else {
      const subPath = req.url.startsWith('/') ? req.url : `/${req.url}`
      targetUrl = `${config.DEFAULT_UPSTREAM_URL}${subPath}`
    }

    return await proxyService.forwardRequest(req, res, targetUrl)
  })
)

module.exports = router

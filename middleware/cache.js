const config = require('../config')
const redisService = require('../services/redis-service')

/**
 * Redis Caching Middleware with TTL and Invalidation
 * 
 * Caches idempotent GET requests.
 * Checks for cache-bust headers (Cache-Control: no-cache, x-cache-bust).
 * Automatically invalidates cache on write methods (POST, PUT, DELETE, PATCH).
 */
const cacheMiddleware = (options = {}) => {
  const ttlSeconds = options.ttl || config.CACHE_TTL_SECONDS

  return async (req, res, next) => {
    const isGet = req.method === 'GET'
    const identifier = req.apiKey ? req.apiKey.id : 'global'
    const cacheKey = `cache:${identifier}:${req.method}:${req.originalUrl || req.url}`

    // If it's a mutating request (POST, PUT, DELETE, PATCH), invalidate related caches
    if (!isGet) {
      const invalidatePrefix = `cache:${identifier}:GET:${req.baseUrl || ''}`
      await redisService.invalidateCachePrefix(invalidatePrefix)
      return next()
    }

    // Check if client requested a cache bust
    const cacheControl = req.headers['cache-control'] || ''
    const forceBust = cacheControl.includes('no-cache') || req.headers['x-cache-bust'] === 'true'

    if (!forceBust) {
      const cached = await redisService.getCache(cacheKey)
      if (cached) {
        res.setHeader('X-Cache', 'HIT')
        res.setHeader('X-Cache-TTL', ttlSeconds)
        if (cached.headers) {
          for (const [key, value] of Object.entries(cached.headers)) {
            if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'x-cache') {
              res.setHeader(key, value)
            }
          }
        }
        return res.status(cached.statusCode || 200).send(cached.data)
      }
    }

    // On Cache Miss, intercept res.send / res.json to store in Redis
    res.setHeader('X-Cache', 'MISS')

    const originalSend = res.send.bind(res)
    res.send = (body) => {
      // Only cache successful 2xx responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        let responseData = body
        try {
          // If body is JSON string, parse or store
          if (typeof body === 'string') {
            responseData = JSON.parse(body)
          }
        } catch (e) {
          // keep as string
        }

        redisService.setCache(
          cacheKey,
          {
            statusCode: res.statusCode,
            data: responseData,
            headers: {
              'content-type': res.getHeader('content-type') || 'application/json',
            },
          },
          ttlSeconds
        ).catch(() => {})
      }

      return originalSend(body)
    }

    next()
  }
}

module.exports = cacheMiddleware

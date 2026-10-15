const Redis = require('ioredis')
const config = require('../config')

let redisClient = null
let isConnected = false

// In-Memory store fallback when external Redis is offline or not configured
class InMemoryRedis {
  constructor() {
    this.zsets = new Map() // key -> Array of { score, member }
    this.strings = new Map() // key -> { value, expiresAt }
  }

  async slidingWindow(key, limit, windowMs) {
    const now = Date.now()
    const clearBefore = now - windowMs

    if (!this.zsets.has(key)) {
      this.zsets.set(key, [])
    }

    let entries = this.zsets.get(key)
    entries = entries.filter((item) => item.score > clearBefore)
    this.zsets.set(key, entries)

    const count = entries.length
    if (count >= limit) {
      const oldest = entries[0]
      const resetMs = oldest ? Math.max(0, oldest.score + windowMs - now) : windowMs
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
      }
    }

    entries.push({ score: now, member: `${now}_${Math.random().toString(36).substring(2, 7)}` })
    this.zsets.set(key, entries)

    return {
      allowed: true,
      limit,
      remaining: limit - count - 1,
      resetMs: windowMs,
    }
  }

  async incrementCounter(key, windowSeconds = 60) {
    const item = this.strings.get(key)
    const now = Date.now()
    if (!item || (item.expiresAt && now > item.expiresAt)) {
      this.strings.set(key, { value: '1', expiresAt: now + windowSeconds * 1000 })
      return { count: 1, ttlSeconds: windowSeconds }
    }
    const count = parseInt(item.value, 10) + 1
    item.value = count.toString()
    const ttlSeconds = Math.max(1, Math.ceil((item.expiresAt - now) / 1000))
    return { count, ttlSeconds }
  }

  async get(key) {
    const item = this.strings.get(key)
    if (!item) return null
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.strings.delete(key)
      return null
    }
    return item.value
  }

  async set(key, value, mode, duration) {
    let expiresAt = null
    if (mode === 'EX' && duration) {
      expiresAt = Date.now() + duration * 1000
    }
    this.strings.set(key, { value, expiresAt })
    return 'OK'
  }

  async del(key) {
    this.strings.delete(key)
    this.zsets.delete(key)
    return 1
  }

  async invalidatePrefix(prefix) {
    let count = 0
    for (const key of this.strings.keys()) {
      if (key.startsWith(prefix)) {
        this.strings.delete(key)
        count++
      }
    }
    return count
  }
}

const inMemoryFallback = new InMemoryRedis()

try {
  redisClient = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null, // Do not spam reconnect if server is offline
  })

  redisClient.connect().then(() => {
    isConnected = true
    if (process.env.NODE_ENV !== 'test') {
      console.log('Connected to Redis server for rate-limiting and caching.')
    }
  }).catch(() => {
    isConnected = false
  })

  redisClient.on('error', () => {
    isConnected = false
  })
} catch (error) {
  isConnected = false
}

/**
 * Real-world Redis Counter Rate Limiter
 * Redis key: "rate:<key_identifier>:<timestamp_minute>"
 * Value incremented on each request with TTL = 60s
 */
const incrementRateLimitCounter = async (key, windowSeconds = 60) => {
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      const multi = redisClient.multi()
      multi.incr(key)
      multi.ttl(key)
      const results = await multi.exec()
      const count = results[0][1]
      let ttlSeconds = results[1][1]

      if (ttlSeconds === -1 || count === 1) {
        await redisClient.expire(key, windowSeconds)
        ttlSeconds = windowSeconds
      }

      return {
        count,
        ttlSeconds: Math.max(1, ttlSeconds),
      }
    } catch (err) {
      return await inMemoryFallback.incrementCounter(key, windowSeconds)
    }
  }

  return await inMemoryFallback.incrementCounter(key, windowSeconds)
}

/**
 * Sliding Window Rate Limiter
 */
const checkRateLimit = async (key, limit, windowMs) => {
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      const now = Date.now()
      const clearBefore = now - windowMs

      const multi = redisClient.multi()
      multi.zremrangebyscore(key, 0, clearBefore)
      multi.zcard(key)
      multi.zadd(key, now, `${now}_${Math.random().toString(36).substring(2, 7)}`)
      multi.expire(key, Math.ceil(windowMs / 1000))

      const results = await multi.exec()
      const currentCount = results[1][1]

      if (currentCount >= limit) {
        await redisClient.zremrangebyscore(key, now, now)
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetMs: windowMs,
        }
      }

      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - currentCount - 1),
        resetMs: windowMs,
      }
    } catch (err) {
      return await inMemoryFallback.slidingWindow(key, limit, windowMs)
    }
  }

  return await inMemoryFallback.slidingWindow(key, limit, windowMs)
}

const getCache = async (key) => {
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      const val = await redisClient.get(key)
      return val ? JSON.parse(val) : null
    } catch (e) {
      const val = await inMemoryFallback.get(key)
      return val ? JSON.parse(val) : null
    }
  }
  const val = await inMemoryFallback.get(key)
  return val ? JSON.parse(val) : null
}

const setCache = async (key, value, ttlSeconds = 60) => {
  const serialized = JSON.stringify(value)
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.set(key, serialized, 'EX', ttlSeconds)
      return
    } catch (e) {}
  }
  await inMemoryFallback.set(key, serialized, 'EX', ttlSeconds)
}

const delCache = async (key) => {
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.del(key)
    } catch (e) {}
  }
  await inMemoryFallback.del(key)
}

const invalidateCachePrefix = async (prefix) => {
  if (isConnected && redisClient && redisClient.status === 'ready') {
    try {
      const keys = await redisClient.keys(`${prefix}*`)
      if (keys.length > 0) {
        await redisClient.del(...keys)
      }
    } catch (e) {}
  }
  await inMemoryFallback.invalidatePrefix(prefix)
}

module.exports = {
  redisClient,
  checkRateLimit,
  incrementRateLimitCounter,
  getCache,
  setCache,
  delCache,
  invalidateCachePrefix,
}

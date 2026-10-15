const crypto = require('crypto')
const apiKeyRepository = require('../repositories/api-key-repository')
const { NotFoundError, BadRequestError } = require('../errors')

const DEFAULT_PREFIX = 'dg_live_'
const SECRET_BYTE_LENGTH = 24 // 192 bits of entropy

/**
 * Generates a cryptographically secure random secret string.
 * Example result: dg_live_a7K2p...
 */
const generateRawKey = (prefix = DEFAULT_PREFIX) => {
  // Generate random bytes and encode as URL-safe base64 string
  const randomSecret = crypto
    .randomBytes(SECRET_BYTE_LENGTH)
    .toString('base64url')

  return `${prefix}${randomSecret}`
}

/**
 * Calculates the SHA-256 hash of the API key.
 * Used for O(1) indexed lookup and leak-proof storage.
 */
const hashKey = (rawKey) => {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

/**
 * Generates a masked display representation for UI/dashboards.
 * Example: dg_live_...9x2A
 */
const getDisplayKey = (rawKey, prefix) => {
  const lastFour = rawKey.slice(-4)
  return `${prefix}...${lastFour}`
}

/**
 * Create a new API Key for a developer:
 * 1. Generates secret string using crypto.randomBytes
 * 2. Hashes key using SHA-256
 * 3. Saves ONLY prefix, hash, and metadata in database
 * 4. Returns the raw key once
 */
const createApiKey = async (userId, keyData = {}) => {
  const prefix = keyData.prefix || DEFAULT_PREFIX
  const name = keyData.name || 'Default API Key'

  let expiresAt = null
  if (keyData.expiresInDays && Number(keyData.expiresInDays) > 0) {
    const d = new Date()
    d.setDate(d.getDate() + Number(keyData.expiresInDays))
    expiresAt = d.toISOString()
  }

  // Generate the raw secret key
  const rawKey = generateRawKey(prefix)
  const displayKey = getDisplayKey(rawKey, prefix)
  const keyHash = hashKey(rawKey)

  const plan = keyData.plan || 'free'
  const rateLimitPerMinute = keyData.rateLimitPerMinute || null

  // Persist only prefix, display_key, key_hash, and metadata
  const createdRecord = await apiKeyRepository.create({
    userId,
    name,
    prefix,
    displayKey,
    keyHash,
    plan,
    rateLimitPerMinute,
    expiresAt,
  })

  // Asynchronously trigger webhook event: api_key.created
  const queueService = require('./queue-service')
  queueService.triggerWebhookEvent('api_key.created', {
    id: createdRecord.id,
    name: createdRecord.name,
    prefix: createdRecord.prefix,
    plan: createdRecord.plan,
    rate_limit_per_minute: createdRecord.rate_limit_per_minute,
  }, userId).catch(() => {})

  // Return the raw key to the developer - THIS IS SHOWN ONCE
  return {
    apiKey: rawKey,
    id: createdRecord.id,
    name: createdRecord.name,
    prefix: createdRecord.prefix,
    display_key: createdRecord.display_key,
    plan: createdRecord.plan,
    rate_limit_per_minute: createdRecord.rate_limit_per_minute,
    is_active: createdRecord.is_active,
    expires_at: createdRecord.expires_at,
    created_at: createdRecord.created_at,
    warning: 'Please save this secret key securely. It will never be shown again.',
  }
}

/**
 * Lists all keys belonging to a developer.
 * Uses SQL aggregation to return usage metrics without exposing secrets.
 */
const getKeysByUserId = async (userId) => {
  return await apiKeyRepository.findByUserId(userId)
}

/**
 * Revokes an existing API key.
 */
const revokeApiKey = async (keyId, userId) => {
  const key = await apiKeyRepository.findByIdAndUserId(keyId, userId)
  if (!key) {
    throw new NotFoundError('API key not found or does not belong to you')
  }

  const revoked = await apiKeyRepository.revoke(keyId, userId)
  return revoked
}

/**
 * Retrieves analytics and usage statistics for an API key.
 */
const getKeyAnalytics = async (keyId, userId) => {
  const analytics = await apiKeyRepository.getKeyAnalytics(keyId, userId)
  if (!analytics) {
    throw new NotFoundError('API key not found or does not belong to you')
  }
  return analytics
}

module.exports = {
  generateRawKey,
  hashKey,
  createApiKey,
  getKeysByUserId,
  revokeApiKey,
  getKeyAnalytics,
}

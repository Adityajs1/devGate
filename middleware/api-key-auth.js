const crypto = require('crypto')
const apiKeyRepository = require('../repositories/api-key-repository')
const { UnauthenticatedError } = require('../errors')

/**
 * Custom API Key Authentication Guard Middleware
 * 
 * 1. Extracts the API key from `x-api-key` header or `Authorization: Bearer <key>`
 * 2. Hashes incoming raw key with SHA-256
 * 3. Performs an indexed lookup joining api_keys and users
 * 4. Checks active and expiration status
 * 5. Attaches apiKey and user information to req
 * 6. Logs usage and updates last_used_at
 */
const apiKeyAuthMiddleware = async (req, res, next) => {
  let rawKey = req.headers['x-api-key']

  // Also support Authorization header
  if (!rawKey && req.headers.authorization) {
    const authHeader = req.headers.authorization
    if (authHeader.startsWith('Bearer ') || authHeader.startsWith('ApiKey ')) {
      rawKey = authHeader.split(' ')[1]
    }
  }

  if (!rawKey) {
    throw new UnauthenticatedError('API key is required. Provide it via x-api-key header or Authorization: Bearer <key>')
  }

  // Hash the incoming key to compare with the stored SHA-256 hash
  const keyHash = crypto.createHash('sha256').update(rawKey.trim()).digest('hex')

  // Find key with SQL JOIN on users table
  const keyRecord = await apiKeyRepository.findByKeyHash(keyHash)

  if (!keyRecord) {
    throw new UnauthenticatedError('Invalid API key')
  }

  if (!keyRecord.is_active) {
    throw new UnauthenticatedError('This API key has been revoked')
  }

  if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
    throw new UnauthenticatedError('This API key has expired')
  }

  // Attach key and user to request object
  req.apiKey = {
    id: keyRecord.id,
    name: keyRecord.key_name || keyRecord.name,
    prefix: keyRecord.prefix,
    displayKey: keyRecord.display_key,
    createdAt: keyRecord.created_at,
    lastUsedAt: keyRecord.last_used_at,
  }

  req.user = {
    userId: keyRecord.user_id,
    name: keyRecord.user_name,
    email: keyRecord.user_email,
  }

  // Update last_used_at and log request metrics asynchronously after response completes
  res.on('finish', () => {
    // Non-blocking telemetry
    apiKeyRepository.updateLastUsed(keyRecord.id).catch((err) => {
      console.error('Failed to update last_used_at for key:', err.message)
    })

    apiKeyRepository.recordUsage({
      apiKeyId: keyRecord.id,
      endpoint: req.originalUrl || req.url,
      method: req.method,
      statusCode: res.statusCode,
      ipAddress: req.ip || req.socket.remoteAddress,
    }).catch((err) => {
      console.error('Failed to record API key usage log:', err.message)
    })
  })

  next()
}

module.exports = apiKeyAuthMiddleware

const { StatusCodes } = require('http-status-codes')
const apiKeyService = require('../services/api-key-service')
const { createApiKeySchema } = require('../schemas/api-key')
const { BadRequestError } = require('../errors')

/**
 * Generates a new API key.
 * Shows the raw key to the developer ONCE upon creation.
 * DB stores only prefix, hash, and metadata.
 * Route: POST /api/v1/keys/create or POST /api/v1/keys
 */
const createKey = async (req, res) => {
  const validationResult = createApiKeySchema.safeParse(req.body || {})
  if (!validationResult.success) {
    const errorMessage = validationResult.error.issues.map((err) => err.message).join(', ')
    throw new BadRequestError(errorMessage)
  }

  const result = await apiKeyService.createApiKey(req.user.userId, validationResult.data)
  res.status(StatusCodes.CREATED).json(result)
}

/**
 * Lists all API keys for the logged-in developer with aggregation metrics.
 * Route: GET /api/v1/keys
 */
const getKeys = async (req, res) => {
  const keys = await apiKeyService.getKeysByUserId(req.user.userId)
  res.status(StatusCodes.OK).json({ count: keys.length, keys })
}

/**
 * Revokes an existing API key.
 * Route: PATCH /api/v1/keys/:id/revoke or DELETE /api/v1/keys/:id
 */
const revokeKey = async (req, res) => {
  const { id } = req.params
  const revokedKey = await apiKeyService.revokeApiKey(id, req.user.userId)
  res.status(StatusCodes.OK).json({ msg: 'API key revoked successfully', key: revokedKey })
}

/**
 * Returns analytics and usage statistics for an API key.
 * Route: GET /api/v1/keys/:id/analytics
 */
const getKeyAnalytics = async (req, res) => {
  const { id } = req.params
  const analytics = await apiKeyService.getKeyAnalytics(id, req.user.userId)
  res.status(StatusCodes.OK).json({ analytics })
}

module.exports = {
  createKey,
  getKeys,
  revokeKey,
  getKeyAnalytics,
}

const express = require('express')
const router = express.Router()
const authMiddleware = require('../middleware/auth')
const asyncHandler = require('../middleware/async')
const {
  createKey,
  getKeys,
  revokeKey,
  getKeyAnalytics,
} = require('../controllers/api-key-controller')

// All key management endpoints require JWT user authentication
router.use(authMiddleware)

// POST /api/v1/keys/create -> returns raw key (shown once)
router.post('/create', asyncHandler(createKey))
router.post('/', asyncHandler(createKey))

// GET /api/v1/keys -> returns developer keys with aggregations
router.get('/', asyncHandler(getKeys))

// PATCH /api/v1/keys/:id/revoke or DELETE /api/v1/keys/:id -> revokes key
router.patch('/:id/revoke', asyncHandler(revokeKey))
router.delete('/:id', asyncHandler(revokeKey))

// GET /api/v1/keys/:id/analytics -> returns key metrics
router.get('/:id/analytics', asyncHandler(getKeyAnalytics))

module.exports = router

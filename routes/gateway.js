const express = require('express')
const router = express.Router()
const apiKeyAuth = require('../middleware/api-key-auth')
const asyncHandler = require('../middleware/async')

// All routes in this router are guarded by custom apiKeyAuth middleware
router.use(apiKeyAuth)

// GET /api/v1/gateway/test -> returns protected gateway resource
router.get(
  '/test',
  asyncHandler(async (req, res) => {
    res.status(200).json({
      success: true,
      message: 'Access granted via valid DevGate API key!',
      authenticatedUser: req.user,
      activeKey: req.apiKey,
      timestamp: new Date().toISOString(),
    })
  })
)

module.exports = router

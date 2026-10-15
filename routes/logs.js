const express = require('express')
const router = express.Router()
const authMiddleware = require('../middleware/auth')
const asyncHandler = require('../middleware/async')
const { getGatewayLogs } = require('../controllers/logs-controller')

// Gateway log queries require JWT authentication
router.use(authMiddleware)

// GET /api/v1/logs -> query & filter proxy logs with pagination
router.get('/', asyncHandler(getGatewayLogs))

module.exports = router

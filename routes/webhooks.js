const express = require('express')
const router = express.Router()
const authMiddleware = require('../middleware/auth')
const asyncHandler = require('../middleware/async')
const {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  getDeliveryLogs,
  testDispatch,
} = require('../controllers/webhook-controller')

// Webhook management requires JWT authentication
router.use(authMiddleware)

router.post('/', asyncHandler(registerWebhook))
router.get('/', asyncHandler(listWebhooks))
router.delete('/:id', asyncHandler(deleteWebhook))
router.get('/deliveries', asyncHandler(getDeliveryLogs))
router.post('/test', asyncHandler(testDispatch))

module.exports = router

const express = require('express')
const router = express.Router()
const asyncHandler = require('../middleware/async')
const {
  getLiveness,
  getReadiness,
  getPrometheusMetrics,
} = require('../controllers/health-controller')

router.get('/health', getLiveness)
router.get('/ready', asyncHandler(getReadiness))
router.get('/metrics', asyncHandler(getPrometheusMetrics))

module.exports = router

const metricsService = require('../services/metrics-service')

/**
 * Prometheus Metrics Middleware
 * Observes latency histograms, request counters, and error rates across all endpoints.
 */
const metricsMiddleware = (req, res, next) => {
  const startTime = process.hrtime()

  res.on('finish', () => {
    const diff = process.hrtime(startTime)
    const durationSeconds = diff[0] + diff[1] / 1e9

    // Normalize route pattern for low cardinality
    const route = req.baseUrl || req.route ? (req.baseUrl + (req.route ? req.route.path : '')) : req.path || 'unknown'
    const statusCode = res.statusCode.toString()
    const method = req.method

    // Record request count and duration histogram
    metricsService.httpRequestsTotal.inc({ method, route, status_code: statusCode })
    metricsService.httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSeconds)

    // Record errors
    if (res.statusCode >= 400) {
      const errorType = res.statusCode === 429 ? 'RateLimit' : res.statusCode >= 500 ? 'ServerError' : 'ClientError'
      metricsService.gatewayErrorsTotal.inc({ error_type: errorType, status_code: statusCode })
    }
  })

  next()
}

module.exports = metricsMiddleware

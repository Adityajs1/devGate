const client = require('prom-client')

// Create a dedicated Prometheus Registry
const register = new client.Registry()

// Add standard process metrics (CPU, Memory, Event Loop Lag, Active Handles)
client.collectDefaultMetrics({
  register,
  prefix: 'devgate_',
})

// HTTP Request Count Metric
const httpRequestsTotal = new client.Counter({
  name: 'devgate_http_requests_total',
  help: 'Total count of HTTP requests processed by DevGate',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
})

// HTTP Latency Histogram Metric
const httpRequestDurationSeconds = new client.Histogram({
  name: 'devgate_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
})

// Gateway Upstream Proxy Latency Histogram
const gatewayProxyDurationSeconds = new client.Histogram({
  name: 'devgate_proxy_duration_seconds',
  help: 'Upstream round-trip proxy duration in seconds',
  labelNames: ['method', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
  registers: [register],
})

// Gateway Errors & Failures Counter
const gatewayErrorsTotal = new client.Counter({
  name: 'devgate_errors_total',
  help: 'Total count of errors encountered by DevGate',
  labelNames: ['error_type', 'status_code'],
  registers: [register],
})

// Rate Limit Blocks Counter
const rateLimitBlocksTotal = new client.Counter({
  name: 'devgate_rate_limit_blocks_total',
  help: 'Total count of requests blocked by rate limiting',
  labelNames: ['plan', 'key_id'],
  registers: [register],
})

// Background Queue Jobs Counter
const queueJobsTotal = new client.Counter({
  name: 'devgate_queue_jobs_total',
  help: 'Total count of background queue jobs processed',
  labelNames: ['job_name', 'status'],
  registers: [register],
})

const getMetrics = async () => {
  return await register.metrics()
}

const getContentType = () => {
  return register.contentType
}

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  gatewayProxyDurationSeconds,
  gatewayErrorsTotal,
  rateLimitBlocksTotal,
  queueJobsTotal,
  getMetrics,
  getContentType,
}

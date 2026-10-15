const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const app = require('../app')
const apiKeyService = require('../services/api-key-service')
const webhookService = require('../services/webhook-service')
const queueService = require('../services/queue-service')
const backgroundTasks = require('../services/background-tasks')
const { redisClient } = require('../services/redis-service')
const { pool } = require('../db/connect')

let server
let mockWebhookServer
let baseUrl
let rootUrl
let receivedWarningWebhook = false
let warningWebhookData = null
let testApiKey
let testKeyId

describe('DevGate Step 6: Prometheus Metrics, Health Checks, Graceful Shutdown & Background Jobs', () => {
  before(async () => {
    // 1. Mock Webhook Receiver Server to capture background jobs
    mockWebhookServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (req.url === '/webhook/receiver') {
          const parsed = JSON.parse(body)
          if (parsed.event === 'limit.warning') {
            receivedWarningWebhook = true
            warningWebhookData = parsed
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ ok: true }))
        }
        res.writeHead(404)
        res.end()
      })
    })

    await new Promise((resolve) => mockWebhookServer.listen(0, resolve))
    const webhookPort = mockWebhookServer.address().port
    const webhookUrl = `http://127.0.0.1:${webhookPort}/webhook/receiver`

    // 2. Gateway App Server
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, resolve))
    const gatewayPort = server.address().port
    rootUrl = `http://127.0.0.1:${gatewayPort}`
    baseUrl = `http://127.0.0.1:${gatewayPort}/api/v1`

    // 3. Register a Webhook for limit.warning
    await webhookService.registerWebhook({
      userId: 'kitchen_tester_dev',
      url: webhookUrl,
      events: ['limit.warning', 'rate_limit.exceeded'],
    })

    // 4. Create an API Key with limit of 5 requests per minute
    const keyData = await apiKeyService.createApiKey('kitchen_tester_dev', {
      name: 'Kitchen Background Test Key',
      prefix: 'dg_live_',
      rateLimitPerMinute: 5,
    })
    testApiKey = keyData.apiKey
    testKeyId = keyData.id
  })

  after(async () => {
    if (server && server.closeAllConnections) server.closeAllConnections()
    if (mockWebhookServer && mockWebhookServer.closeAllConnections) mockWebhookServer.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => mockWebhookServer.close(resolve))
    await pool.end().catch(() => {})
    if (redisClient && redisClient.quit) await redisClient.quit().catch(() => {})
    await queueService.closeQueue()
    setTimeout(() => process.exit(0), 100)
  })

  test('1. Health Checks - /health Liveness Probe', async () => {
    const res = await fetch(`${rootUrl}/health`)
    assert.strictEqual(res.status, 200)
    const data = await res.json()

    assert.strictEqual(data.status, 'ok')
    assert.ok(typeof data.uptime === 'number')
    assert.ok(data.timestamp)
    assert.ok(data.memory)
  })

  test('2. Health Checks - /ready Readiness Probe', async () => {
    const res = await fetch(`${rootUrl}/ready`)
    assert.strictEqual(res.status, 200)
    const data = await res.json()

    assert.strictEqual(data.status, 'ready')
    assert.ok(data.checks)
    assert.ok(data.checks.database)
    assert.ok(data.checks.redis)
    assert.ok(data.checks.queue)
    assert.ok(data.checks.elasticsearch)
  })

  test('3. Prometheus Metrics - /metrics Scrape Endpoint', async () => {
    // Generate a quick request to record metric data
    await fetch(`${baseUrl}/gateway/test`, {
      headers: { 'x-api-key': testApiKey },
    })

    const res = await fetch(`${rootUrl}/metrics`)
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/plain'))

    const metricsText = await res.text()
    assert.ok(metricsText.includes('devgate_http_requests_total'), 'Must include http requests counter')
    assert.ok(metricsText.includes('devgate_http_request_duration_seconds'), 'Must include duration histogram')
    assert.ok(metricsText.includes('devgate_errors_total'), 'Must include errors counter')
  })

  test('4. Background Jobs - Near Limit Webhook Warning (The Kitchen)', async () => {
    // Send requests to hit the 80% warning threshold (4 requests out of 5)
    for (let i = 1; i <= 3; i++) {
      await fetch(`${baseUrl}/gateway/test`, {
        headers: { 'x-api-key': testApiKey },
      })
    }

    // Wait briefly for background worker to deliver limit.warning webhook
    await new Promise((resolve) => setTimeout(resolve, 350))

    assert.strictEqual(receivedWarningWebhook, true, 'limit.warning webhook should be dispatched in background')
    assert.strictEqual(warningWebhookData.event, 'limit.warning')
    assert.strictEqual(warningWebhookData.limit, 5)
  })

  test('5. Background Jobs - Monthly Usage Report Generation', async () => {
    const jobResult = await backgroundTasks.handleGenerateUsageReport({
      userId: 'kitchen_tester_dev',
      email: 'dev@devgate.io',
    })

    assert.strictEqual(jobResult.success, true)
    assert.strictEqual(jobResult.userId, 'kitchen_tester_dev')
    assert.ok(typeof jobResult.totalCalls === 'number')
  })

  test('6. Background Jobs - Expired Keys Cleanup Task', async () => {
    const cleanupResult = await backgroundTasks.handleCleanupExpiredKeys()
    assert.strictEqual(cleanupResult.success, true)
    assert.ok(typeof cleanupResult.deactivatedCount === 'number')
  })
})

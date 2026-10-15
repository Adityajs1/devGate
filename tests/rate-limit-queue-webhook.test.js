const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const crypto = require('crypto')
const app = require('../app')
const apiKeyService = require('../services/api-key-service')
const webhookService = require('../services/webhook-service')
const queueService = require('../services/queue-service')
const { redisClient } = require('../services/redis-service')
const { pool } = require('../db/connect')

let server
let mockWebhookServer
let gatewayBaseUrl
let webhooksBaseUrl
let webhookReceiverUrl
let failingReceiverUrl
let receivedWebhookHeaders = null
let receivedWebhookBody = null
let userToken = 'test-token-val'
let testKeyWithLimit
let webhookSecret

describe('DevGate Rate Limiting Plans, Queues, Retries, DLQ & HMAC Webhooks', () => {
  before(async () => {
    // 1. Mock Webhook Receiver Server
    mockWebhookServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (req.url === '/webhook/success') {
          receivedWebhookHeaders = req.headers
          receivedWebhookBody = body
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ received: true }))
        }

        if (req.url === '/webhook/failing') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Webhook endpoint temporarily down' }))
        }

        res.writeHead(404)
        res.end()
      })
    })

    await new Promise((resolve) => mockWebhookServer.listen(0, resolve))
    const webhookPort = mockWebhookServer.address().port
    webhookReceiverUrl = `http://127.0.0.1:${webhookPort}/webhook/success`
    failingReceiverUrl = `http://127.0.0.1:${webhookPort}/webhook/failing`

    // 2. Gateway App Server
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, resolve))
    const gatewayPort = server.address().port
    gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/api/v1/gateway`
    webhooksBaseUrl = `http://127.0.0.1:${gatewayPort}/api/v1/webhooks`

    // 3. Create an API Key with a strict limit: 3 requests per minute
    const keyData = await apiKeyService.createApiKey('user_rate_tester', {
      name: 'Rate Limit Test Key',
      prefix: 'dg_live_',
      plan: 'free',
      rateLimitPerMinute: 3,
    })
    testKeyWithLimit = keyData.apiKey
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

  test('1. Rate Limiting Counter - Allows requests under plan limit (1, 2, 3)', async () => {
    // Request 1
    const res1 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': testKeyWithLimit },
    })
    assert.strictEqual(res1.status, 200)
    assert.strictEqual(res1.headers.get('x-ratelimit-limit'), '3')
    assert.strictEqual(res1.headers.get('x-ratelimit-remaining'), '2')

    // Request 2
    const res2 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': testKeyWithLimit },
    })
    assert.strictEqual(res2.status, 200)
    assert.strictEqual(res2.headers.get('x-ratelimit-limit'), '3')
    assert.strictEqual(res2.headers.get('x-ratelimit-remaining'), '1')

    // Request 3
    const res3 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': testKeyWithLimit },
    })
    assert.strictEqual(res3.status, 200)
    assert.strictEqual(res3.headers.get('x-ratelimit-limit'), '3')
    assert.strictEqual(res3.headers.get('x-ratelimit-remaining'), '0')
  })

  test('2. Rate Limiting Kicks In - Blocks request exceeding plan limit (Returns 429)', async () => {
    // Request 4: Exceeds plan limit of 3
    const res4 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': testKeyWithLimit },
    })

    assert.strictEqual(res4.status, 429)
    assert.strictEqual(res4.headers.get('x-ratelimit-remaining'), '0')
    assert.ok(res4.headers.has('retry-after'))

    const data = await res4.json()
    assert.strictEqual(data.success, false)
    assert.strictEqual(data.statusCode, 429)
    assert.ok(data.msg.includes('Rate limit exceeded'))
  })

  test('3. Webhook Registration - Issues Secret Key for HMAC Signing', async () => {
    const webhook = await webhookService.registerWebhook({
      userId: 'user_rate_tester',
      url: webhookReceiverUrl,
      events: ['rate_limit.exceeded', 'test.event'],
    })

    assert.ok(webhook.id)
    assert.ok(webhook.secret.startsWith('whsec_'))
    webhookSecret = webhook.secret
  })

  test('4. Webhook Dispatch & HMAC Signature Verification', async () => {
    const payload = { alert: 'Rate limit breached', timestamp: Date.now() }
    await queueService.triggerWebhookEvent('test.event', payload, 'user_rate_tester')

    // Wait briefly for worker to deliver payload
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.ok(receivedWebhookHeaders, 'Webhook request must be received by target')
    assert.strictEqual(receivedWebhookHeaders['x-devgate-event'], 'test.event')
    assert.ok(receivedWebhookHeaders['x-devgate-signature'])

    // Verify HMAC-SHA256 signature: t=...,v1=...
    const sigHeader = receivedWebhookHeaders['x-devgate-signature']
    const parts = sigHeader.split(',')
    const timestampPart = parts.find((p) => p.startsWith('t=')).split('=')[1]
    const signaturePart = parts.find((p) => p.startsWith('v1=')).split('=')[1]

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestampPart}.${receivedWebhookBody}`)
      .digest('hex')

    assert.strictEqual(signaturePart, expectedSignature, 'HMAC signature must match expected digest')
  })

  test('5. Queue Retries with Exponential Backoff and Dead Letter Queue (DLQ)', async () => {
    // Register webhook pointing to failing endpoint (HTTP 500)
    const failingWebhook = await webhookService.registerWebhook({
      userId: 'user_failing_test',
      url: failingReceiverUrl,
      events: ['failing.event'],
    })

    // Dispatch job to failing receiver
    await queueService.enqueueWebhookDelivery({
      webhookId: failingWebhook.id,
      url: failingWebhook.url,
      secret: failingWebhook.secret,
      event: 'failing.event',
      payload: { attempt: 'test' },
    })

    // Wait for retries with exponential backoff to complete
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const dlqLogs = await webhookService.getDeliveryLogs('dead_letter')
    const matchingLog = dlqLogs.find((l) => l.webhook_id === failingWebhook.id)

    assert.ok(matchingLog, 'Failed webhook must be moved to Dead Letter Queue')
    assert.strictEqual(matchingLog.status, 'dead_letter')
    assert.ok(matchingLog.attempts >= 3, 'Must have attempted retries before DLQ')
    assert.ok(matchingLog.error_message.includes('500'))
  })
})

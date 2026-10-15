const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const app = require('../app')
const config = require('../config')
const apiKeyService = require('../services/api-key-service')
const { redisClient } = require('../services/redis-service')
const { pool } = require('../db/connect')

let server
let mockUpstreamServer
let gatewayBaseUrl
let upstreamBaseUrl
let testApiKey
let testUserId = 'test_dev_123'

describe('DevGate Gateway: Proxying, Rate Limiting, Caching & Bouncer Validation', () => {
  before(async () => {
    // 1. Start a mock upstream server to receive proxied requests
    mockUpstreamServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (req.url === '/upstream/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-Custom-Upstream': 'true' })
          return res.end(JSON.stringify({
            message: 'Hello from Upstream Server!',
            method: req.method,
            headers: req.headers,
            body: body ? JSON.parse(body) : null,
          }))
        }

        if (req.url === '/upstream/data') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ data: 'resource_value', timestamp: Date.now() }))
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upstream route not found' }))
      })
    })

    await new Promise((resolve) => mockUpstreamServer.listen(0, resolve))
    const upstreamPort = mockUpstreamServer.address().port
    upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`

    // 2. Start Gateway Express app
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, resolve))
    const gatewayPort = server.address().port
    gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/api/v1/gateway`

    // 3. Generate a real API key for testing
    const createdKey = await apiKeyService.createApiKey(testUserId, {
      name: 'Gateway Proxy Test Key',
      prefix: 'dg_live_',
    })
    testApiKey = createdKey.apiKey
  })

  after(async () => {
    if (server && server.closeAllConnections) server.closeAllConnections()
    if (mockUpstreamServer && mockUpstreamServer.closeAllConnections) mockUpstreamServer.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => mockUpstreamServer.close(resolve))
    await pool.end().catch(() => {})
    if (redisClient && redisClient.quit) await redisClient.quit().catch(() => {})
    setTimeout(() => process.exit(0), 100)
  })

  test('1. Config Management - Environment Variables Validated at Startup', () => {
    assert.ok(config.PORT, 'PORT should be defined and validated')
    assert.ok(config.JWT_SECRET, 'JWT_SECRET should be defined')
    assert.strictEqual(typeof config.RATE_LIMIT_WINDOW_MS, 'number')
    assert.strictEqual(typeof config.CACHE_TTL_SECONDS, 'number')
  })

  test('2. The Bouncer - Rejects Requests Without Key (401)', async () => {
    const res = await fetch(`${gatewayBaseUrl}/test`)
    assert.strictEqual(res.status, 401)
    const data = await res.json()
    assert.strictEqual(data.success, false)
    assert.ok(data.msg.includes('API key is required'))
  })

  test('3. The Bouncer - Rejects Requests With Invalid Key (401)', async () => {
    const res = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { Authorization: 'Bearer dg_live_fakekeythatwasnevergenerated' },
    })
    assert.strictEqual(res.status, 401)
    const data = await res.json()
    assert.strictEqual(data.success, false)
    assert.ok(data.msg.includes('Invalid API key'))
  })

  test('4. The Bouncer - Accepts Valid Key in Authorization Header', async () => {
    const res = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    })
    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.success, true)
    assert.ok(data.developer)
    assert.ok(data.keyDetails)
  })

  test('5. Rate Limiting - Injects Rate Limit Headers', async () => {
    const res = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': testApiKey },
    })
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers.has('x-ratelimit-limit'))
    assert.ok(res.headers.has('x-ratelimit-remaining'))
    assert.ok(res.headers.has('x-ratelimit-reset'))
  })

  test('6. Caching - Returns X-Cache MISS on First Call, HIT on Subsequent Call', async () => {
    const testUrl = `${gatewayBaseUrl}/test?test_cache=initial`

    // First call: MISS
    const res1 = await fetch(testUrl, {
      headers: { 'x-api-key': testApiKey },
    })
    assert.strictEqual(res1.status, 200)
    assert.strictEqual(res1.headers.get('x-cache'), 'MISS')

    // Second call: HIT
    const res2 = await fetch(testUrl, {
      headers: { 'x-api-key': testApiKey },
    })
    assert.strictEqual(res2.status, 200)
    assert.strictEqual(res2.headers.get('x-cache'), 'HIT')

    // Third call with Cache-Control: no-cache: BUSTS CACHE -> MISS
    const res3 = await fetch(testUrl, {
      headers: {
        'x-api-key': testApiKey,
        'Cache-Control': 'no-cache',
      },
    })
    assert.strictEqual(res3.status, 200)
    assert.strictEqual(res3.headers.get('x-cache'), 'MISS')
  })

  test('7. HTTP Proxying - Forwards GET Request Upstream', async () => {
    const res = await fetch(`${gatewayBaseUrl}/upstream/echo`, {
      headers: {
        Authorization: `Bearer ${testApiKey}`,
        'x-upstream-url': `${upstreamBaseUrl}/upstream/echo`,
      },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.message, 'Hello from Upstream Server!')
    assert.strictEqual(data.method, 'GET')
    assert.strictEqual(data.headers['x-gateway'], 'DevGate/1.0')
    assert.strictEqual(res.headers.get('x-custom-upstream'), 'true')
  })

  test('8. HTTP Proxying - Forwards POST Request With Payload Upstream', async () => {
    const payload = { event: 'user_signup', userId: 994 }
    const res = await fetch(`${gatewayBaseUrl}/upstream/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testApiKey}`,
        'x-upstream-url': `${upstreamBaseUrl}/upstream/echo`,
      },
      body: JSON.stringify(payload),
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.method, 'POST')
    assert.deepStrictEqual(data.body, payload)
  })

  test('9. Centralized Error Handling - BadGatewayError (502) on Unreachable Upstream', async () => {
    // Port 59999 has no server running
    const res = await fetch(`${gatewayBaseUrl}/unreachable`, {
      headers: {
        Authorization: `Bearer ${testApiKey}`,
        'x-upstream-url': 'http://127.0.0.1:59999/does-not-exist',
      },
    })

    assert.strictEqual(res.status, 502)
    const data = await res.json()
    assert.strictEqual(data.success, false)
    assert.strictEqual(data.statusCode, 502)
    assert.ok(data.msg.includes('Bad Gateway'))
  })
})

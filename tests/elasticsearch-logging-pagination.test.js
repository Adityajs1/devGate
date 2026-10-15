const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const app = require('../app')
const apiKeyService = require('../services/api-key-service')
const authService = require('../services/auth-service')
const elasticsearchService = require('../services/elasticsearch-service')
const queueService = require('../services/queue-service')
const { redisClient } = require('../services/redis-service')
const { pool } = require('../db/connect')

let server
let mockUpstreamServer
let gatewayBaseUrl
let logsBaseUrl
let upstreamBaseUrl
let developerToken
let developerUserId
let developerApiKey
let apiKeyId

describe('DevGate Step 5: Elasticsearch, Structured Logging, Latency & Pagination', () => {
  before(async () => {
    // 1. Mock Upstream Destination Server
    mockUpstreamServer = http.createServer((req, res) => {
      // Simulate light work
      setTimeout(() => {
        if (req.url.startsWith('/upstream/items')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ items: ['item_A', 'item_B'], servedAt: Date.now() }))
        }

        if (req.url.startsWith('/upstream/error')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Client bad input' }))
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not Found' }))
      }, 20)
    })

    await new Promise((resolve) => mockUpstreamServer.listen(0, resolve))
    const upstreamPort = mockUpstreamServer.address().port
    upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`

    // 2. Gateway Express Server
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, resolve))
    const gatewayPort = server.address().port
    gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/api/v1/gateway`
    logsBaseUrl = `http://127.0.0.1:${gatewayPort}/api/v1/logs`

    // 3. Register a developer
    const email = `telemetry_dev_${Date.now()}@devgate.io`
    const registered = await authService.register({
      name: 'Telemetry Engineer',
      email,
      password: 'testPassword123',
    })
    developerToken = registered.token
    developerUserId = registered.user.id

    // 4. Create an API Key for this developer
    const createdKey = await apiKeyService.createApiKey(developerUserId, {
      name: 'Elasticsearch Telemetry Key',
      prefix: 'dg_live_',
    })
    developerApiKey = createdKey.apiKey
    apiKeyId = createdKey.id
  })

  after(async () => {
    if (server && server.closeAllConnections) server.closeAllConnections()
    if (mockUpstreamServer && mockUpstreamServer.closeAllConnections) mockUpstreamServer.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => mockUpstreamServer.close(resolve))
    await pool.end().catch(() => {})
    if (redisClient && redisClient.quit) await redisClient.quit().catch(() => {})
    await queueService.closeQueue()
    setTimeout(() => process.exit(0), 100)
  })

  test('1. Request ID Middleware - Attaches and Propagates X-Request-Id', async () => {
    // Client without custom X-Request-Id
    const res1 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: { 'x-api-key': developerApiKey },
    })
    assert.strictEqual(res1.status, 200)
    const reqId1 = res1.headers.get('x-request-id')
    assert.ok(reqId1, 'X-Request-Id must be set in response')
    assert.ok(reqId1.startsWith('req_'))

    // Client with custom incoming X-Request-Id
    const customId = `custom_trace_${Date.now()}`
    const res2 = await fetch(`${gatewayBaseUrl}/test`, {
      headers: {
        'x-api-key': developerApiKey,
        'x-request-id': customId,
      },
    })
    assert.strictEqual(res2.status, 200)
    assert.strictEqual(res2.headers.get('x-request-id'), customId, 'Must propagate custom trace ID')
  })

  test('2. Proxy Forwarding & Elasticsearch Log Recording', async () => {
    // Generate several proxied calls
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${gatewayBaseUrl}/upstream/items?seq=${i}`, {
        headers: {
          Authorization: `Bearer ${developerApiKey}`,
          'x-upstream-url': `${upstreamBaseUrl}/upstream/items?seq=${i}`,
        },
      })
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers.has('x-gateway-latency'))
    }

    // Generate an error call
    const errRes = await fetch(`${gatewayBaseUrl}/upstream/error`, {
      headers: {
        Authorization: `Bearer ${developerApiKey}`,
        'x-upstream-url': `${upstreamBaseUrl}/upstream/error`,
      },
    })
    assert.strictEqual(errRes.status, 400)

    // Verify logs were indexed into Elasticsearch
    const logsRes = await fetch(`${logsBaseUrl}`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })

    assert.strictEqual(logsRes.status, 200)
    const data = await logsRes.json()

    assert.ok(data.total >= 6)
    assert.ok(data.logs.length >= 6)

    const firstLog = data.logs[0]
    assert.ok(firstLog.keyId, 'Must record keyId')
    assert.ok(firstLog.path, 'Must record path')
    assert.ok(firstLog.status, 'Must record status')
    assert.ok(typeof firstLog.latencyMs === 'number', 'Must record latencyMs')
    assert.ok(firstLog.timestamp, 'Must record timestamp')
    assert.ok(firstLog.requestId, 'Must record requestId')
  })

  test('3. Query and Filter Elasticsearch Logs', async () => {
    // Filter by status: 400
    const res400 = await fetch(`${logsBaseUrl}?status=400`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    assert.strictEqual(res400.status, 200)
    const data400 = await res400.json()
    assert.ok(data400.logs.every((l) => l.status === 400))

    // Filter by path substring
    const resPath = await fetch(`${logsBaseUrl}?path=items`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    assert.strictEqual(resPath.status, 200)
    const dataPath = await resPath.json()
    assert.ok(dataPath.logs.every((l) => l.path.includes('items')))

    // Aggregations
    assert.ok(dataPath.aggregations)
    assert.ok(typeof dataPath.aggregations.averageLatencyMs === 'number')
    assert.ok(dataPath.aggregations.totalRequests >= 5)
  })

  test('4. Limit / Offset Pagination', async () => {
    // Page 1: limit 2, offset 0
    const resPage1 = await fetch(`${logsBaseUrl}?limit=2&offset=0`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    assert.strictEqual(resPage1.status, 200)
    const page1 = await resPage1.json()
    assert.strictEqual(page1.logs.length, 2)
    assert.strictEqual(page1.hasMore, true)

    // Page 2: limit 2, offset 2
    const resPage2 = await fetch(`${logsBaseUrl}?limit=2&offset=2`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    assert.strictEqual(resPage2.status, 200)
    const page2 = await resPage2.json()
    assert.strictEqual(page2.logs.length, 2)

    // Page 1 and Page 2 should not share documents
    assert.notStrictEqual(page1.logs[0].id, page2.logs[0].id)
  })

  test('5. Cursor-Based Pagination', async () => {
    // Fetch first page with cursor token
    const res1 = await fetch(`${logsBaseUrl}?limit=2`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    const page1 = await res1.json()
    assert.strictEqual(page1.logs.length, 2)
    assert.ok(page1.nextCursor, 'Must return nextCursor for pagination')

    // Fetch next page using nextCursor
    const res2 = await fetch(`${logsBaseUrl}?limit=2&cursor=${page1.nextCursor}`, {
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    const page2 = await res2.json()
    assert.strictEqual(page2.logs.length, 2)

    // Ensure completely unique items across cursor pages
    const idsPage1 = page1.logs.map((l) => l.id)
    const idsPage2 = page2.logs.map((l) => l.id)
    for (const id of idsPage2) {
      assert.ok(!idsPage1.includes(id), `Item ${id} should not appear on cursor page 2`)
    }
  })
})

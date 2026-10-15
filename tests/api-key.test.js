const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const app = require('../app')
const { pool } = require('../db/connect')

let server
let baseUrl
let userToken
let rawApiKey
let apiKeyId

describe('DevGate API Key System Integration Tests', () => {
  before(async () => {
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    baseUrl = `http://127.0.0.1:${port}/api/v1`
  })

  after(async () => {
    if (server.closeAllConnections) {
      server.closeAllConnections()
    }
    await new Promise((resolve) => server.close(resolve))
    await pool.end().catch(() => {})
    setTimeout(() => process.exit(0), 100)
  })

  test('1. User Registration and Login', async () => {
    const email = `developer_${Date.now()}@example.com`
    const password = 'securepassword123'

    // Register
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alex Developer', email, password }),
    })
    assert.strictEqual(regRes.status, 201)
    const regData = await regRes.json()
    assert.ok(regData.token)

    // Login
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    assert.strictEqual(loginRes.status, 200)
    const loginData = await loginRes.json()
    assert.ok(loginData.token)
    userToken = loginData.token
  })

  test('2. Generate API Key (POST /api/v1/keys/create) - Returns Raw Key Shown Once', async () => {
    const res = await fetch(`${baseUrl}/keys/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        name: 'Stripe-Style Production Key',
        prefix: 'dg_live_',
        expiresInDays: 30,
      }),
    })

    assert.strictEqual(res.status, 201)
    const data = await res.json()

    // Assert raw key is provided with Stripe-like prefix
    assert.ok(data.apiKey, 'Must return raw apiKey')
    assert.ok(data.apiKey.startsWith('dg_live_'), 'Key must start with dg_live_ prefix')
    assert.ok(data.apiKey.length > 20, 'Key must have sufficient cryptographic entropy')
    assert.ok(data.id, 'Must return key id')
    assert.strictEqual(data.name, 'Stripe-Style Production Key')
    assert.strictEqual(data.prefix, 'dg_live_')
    assert.ok(data.display_key.includes('...'), 'Must provide masked display_key')
    assert.strictEqual(data.is_active, true)
    assert.ok(data.warning, 'Must provide warning that key is only shown once')
    assert.strictEqual(data.key_hash, undefined, 'Database hash must NEVER be leaked to developer')

    rawApiKey = data.apiKey
    apiKeyId = data.id
  })

  test('3. List Developer Keys (GET /api/v1/keys) - Raw Key and Hash Are Not Returned', async () => {
    const res = await fetch(`${baseUrl}/keys`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()

    assert.ok(Array.isArray(data.keys))
    assert.ok(data.count >= 1)

    const foundKey = data.keys.find((k) => k.id === apiKeyId)
    assert.ok(foundKey, 'Newly created key must be in the list')
    assert.strictEqual(foundKey.apiKey, undefined, 'Raw secret key must NEVER be in list')
    assert.strictEqual(foundKey.key_hash, undefined, 'Hash must NEVER be in list')
    assert.strictEqual(foundKey.prefix, 'dg_live_')
    assert.ok(foundKey.display_key)
    assert.ok('total_requests' in foundKey, 'Aggregated total_requests metric must be present')
  })

  test('4. Access Protected Gateway via x-api-key Header', async () => {
    const res = await fetch(`${baseUrl}/gateway/test`, {
      headers: { 'x-api-key': rawApiKey },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()

    assert.strictEqual(data.success, true)
    assert.ok(data.authenticatedUser, 'User information must be attached to request')
    assert.ok(data.activeKey, 'Key metadata must be attached to request')
    assert.strictEqual(data.activeKey.id, apiKeyId)
  })

  test('5. Access Protected Gateway via Authorization: Bearer Header', async () => {
    const res = await fetch(`${baseUrl}/gateway/test`, {
      headers: { Authorization: `Bearer ${rawApiKey}` },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.success, true)
  })

  test('6. Auth Guard Rejects Missing API Key', async () => {
    const res = await fetch(`${baseUrl}/gateway/test`)
    assert.strictEqual(res.status, 401)
  })

  test('7. Auth Guard Rejects Invalid API Key', async () => {
    const res = await fetch(`${baseUrl}/gateway/test`, {
      headers: { 'x-api-key': 'dg_live_invalidsecretthatdoesnotexist' },
    })
    assert.strictEqual(res.status, 401)
  })

  test('8. Revoke API Key (PATCH /api/v1/keys/:id/revoke)', async () => {
    const res = await fetch(`${baseUrl}/keys/${apiKeyId}/revoke`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userToken}` },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.key.is_active, false)
  })

  test('9. Auth Guard Rejects Revoked API Key', async () => {
    const res = await fetch(`${baseUrl}/gateway/test`, {
      headers: { 'x-api-key': rawApiKey },
    })
    assert.strictEqual(res.status, 401)
    const data = await res.json()
    assert.ok(data.msg.includes('revoked'), 'Message must inform that key has been revoked')
  })

  test('10. Key Usage Analytics Aggregations (GET /api/v1/keys/:id/analytics)', async () => {
    const res = await fetch(`${baseUrl}/keys/${apiKeyId}/analytics`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.ok(data.analytics)
    assert.ok('total_requests' in data.analytics)
    assert.ok('success_requests' in data.analytics)
    assert.ok('failed_requests' in data.analytics)
  })
})

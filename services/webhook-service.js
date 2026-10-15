const crypto = require('crypto')
const db = require('../db/connect')
const { BadRequestError, NotFoundError } = require('../errors')

// In-memory fallback stores
const memoryWebhooks = []
const memoryDeliveryLogs = []

/**
 * Generates an HMAC secret for webhook payload signing.
 * Example: whsec_8k2Lp9...
 */
const generateWebhookSecret = () => {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`
}

/**
 * Signs a webhook payload using HMAC-SHA256 with timestamp.
 * Standard Stripe-style signature: prevents replay and tampering attacks.
 */
const signPayload = (secret, payloadString, timestamp) => {
  const data = `${timestamp}.${payloadString}`
  return crypto.createHmac('sha256', secret).update(data).digest('hex')
}

/**
 * Registers a new webhook subscription.
 */
const registerWebhook = async ({ userId, url, events = ['rate_limit.exceeded', 'api_key.created', 'api_key.revoked'] }) => {
  if (!url || !url.startsWith('http')) {
    throw new BadRequestError('A valid http/https webhook URL is required')
  }

  const secret = generateWebhookSecret()

  try {
    const res = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, url, secret, events, is_active, created_at`,
      [userId, url, secret, events]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
  } catch (error) {
    // In-memory fallback
  }

  const newWebhook = {
    id: `wh_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    user_id: userId,
    url,
    secret,
    events,
    is_active: true,
    created_at: new Date().toISOString(),
  }
  memoryWebhooks.push(newWebhook)
  return newWebhook
}

/**
 * Finds all active webhooks for an event and optional userId.
 */
const findSubscribedWebhooks = async (event, userId = null) => {
  try {
    let queryText = 'SELECT * FROM webhooks WHERE is_active = TRUE AND $1 = ANY(events)'
    const params = [event]
    if (userId) {
      queryText += ' AND user_id = $2'
      params.push(userId)
    }
    const res = await db.query(queryText, params)
    if (res && res.rows) {
      return res.rows
    }
    return []
  } catch (error) {
    return memoryWebhooks.filter(
      (wh) => wh.is_active && wh.events.includes(event) && (!userId || wh.user_id === userId)
    )
  }
}

/**
 * Lists webhooks belonging to a developer (secret is masked).
 */
const listWebhooks = async (userId) => {
  try {
    const res = await db.query(
      'SELECT id, user_id, url, is_active, events, created_at FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    )
    if (res && res.rows) {
      return res.rows
    }
    return []
  } catch (error) {
    return memoryWebhooks
      .filter((wh) => wh.user_id === userId)
      .map(({ secret, ...rest }) => ({
        ...rest,
        masked_secret: `${secret.substring(0, 10)}...`,
      }))
  }
}

/**
 * Deletes a webhook.
 */
const deleteWebhook = async (id, userId) => {
  try {
    await db.query('DELETE FROM webhooks WHERE id = $1 AND user_id = $2', [id, userId])
  } catch (error) {
    const idx = memoryWebhooks.findIndex((wh) => wh.id === id && wh.user_id === userId)
    if (idx !== -1) {
      memoryWebhooks.splice(idx, 1)
    }
  }
}

/**
 * Records webhook delivery attempt or status (Delivered, Retrying, Dead Letter).
 */
const recordDelivery = async ({ webhookId, event, payload, status, attempts, responseStatus = null, errorMessage = null }) => {
  try {
    await db.query(
      `INSERT INTO webhook_delivery_logs (webhook_id, event, payload, status, attempts, response_status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [webhookId, event, JSON.stringify(payload), status, attempts, responseStatus, errorMessage]
    )
  } catch (error) {
    memoryDeliveryLogs.push({
      id: memoryDeliveryLogs.length + 1,
      webhook_id: webhookId,
      event,
      payload,
      status,
      attempts,
      response_status: responseStatus,
      error_message: errorMessage,
      created_at: new Date().toISOString(),
    })
  }
}

/**
 * Gets webhook delivery history and Dead Letter Queue entries.
 */
const getDeliveryLogs = async (statusFilter = null) => {
  try {
    let queryText = 'SELECT * FROM webhook_delivery_logs'
    const params = []
    if (statusFilter) {
      queryText += ' WHERE status = $1'
      params.push(statusFilter)
    }
    queryText += ' ORDER BY created_at DESC LIMIT 100'
    const res = await db.query(queryText, params)
    if (res && res.rows) {
      return res.rows
    }
    return []
  } catch (error) {
    if (statusFilter) {
      return memoryDeliveryLogs.filter((log) => log.status === statusFilter)
    }
    return memoryDeliveryLogs
  }
}

module.exports = {
  generateWebhookSecret,
  signPayload,
  registerWebhook,
  findSubscribedWebhooks,
  listWebhooks,
  deleteWebhook,
  recordDelivery,
  getDeliveryLogs,
}

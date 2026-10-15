const db = require('../db/connect')

// In-memory fallbacks for development/tests when DB is offline
const memoryKeys = []
const memoryLogs = []

const PLAN_LIMITS = {
  free: 100,
  pro: 1000,
  enterprise: 10000,
}

/**
 * Creates a new API key record in the database.
 * Storing prefix, key_hash, plan, rate_limit, and metadata.
 */
const create = async ({ userId, name, prefix, displayKey, keyHash, plan = 'free', rateLimitPerMinute = null, expiresAt = null }) => {
  const finalLimit = rateLimitPerMinute || PLAN_LIMITS[plan] || 100

  try {
    const res = await db.query(
      `INSERT INTO api_keys (user_id, name, prefix, display_key, key_hash, plan, rate_limit_per_minute, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, name, prefix, display_key, plan, rate_limit_per_minute, is_active, created_at, expires_at`,
      [userId, name, prefix, displayKey, keyHash, plan, finalLimit, expiresAt]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
  } catch (error) {
    // Fallback to in-memory store
  }

  const newKey = {
    id: `key_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    user_id: userId,
    name: name || 'Default API Key',
    prefix,
    display_key: displayKey,
    key_hash: keyHash,
    plan: plan || 'free',
    rate_limit_per_minute: finalLimit,
    is_active: true,
    last_used_at: null,
    expires_at: expiresAt || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  memoryKeys.push(newKey)
  return {
    id: newKey.id,
    user_id: newKey.user_id,
    name: newKey.name,
    prefix: newKey.prefix,
    display_key: newKey.display_key,
    plan: newKey.plan,
    rate_limit_per_minute: newKey.rate_limit_per_minute,
    is_active: newKey.is_active,
    created_at: newKey.created_at,
    expires_at: newKey.expires_at,
  }
}

/**
 * Finds an active API key by its SHA-256 hash.
 * Uses SQL JOIN with the users table to attach user metadata.
 */
const findByKeyHash = async (keyHash) => {
  try {
    const queryText = `
      SELECT 
        k.id,
        k.user_id,
        k.name AS key_name,
        k.prefix,
        k.display_key,
        k.key_hash,
        k.plan,
        k.rate_limit_per_minute,
        k.is_active,
        k.last_used_at,
        k.expires_at,
        k.created_at,
        u.name AS user_name,
        u.email AS user_email
      FROM api_keys k
      JOIN users u ON k.user_id = u.id
      WHERE k.key_hash = $1
      LIMIT 1;
    `
    const res = await db.query(queryText, [keyHash])
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    const key = memoryKeys.find((k) => k.key_hash === keyHash)
    if (!key) return null
    return {
      ...key,
      key_name: key.name,
      user_name: 'Developer',
      user_email: 'dev@devgate.io',
    }
  }
}

/**
 * Finds all API keys for a specific user with aggregations.
 */
const findByUserId = async (userId) => {
  try {
    const queryText = `
      SELECT 
        k.id,
        k.user_id,
        k.name,
        k.prefix,
        k.display_key,
        k.plan,
        k.rate_limit_per_minute,
        k.is_active,
        k.last_used_at,
        k.expires_at,
        k.created_at,
        COUNT(l.id)::int AS total_requests,
        MAX(l.created_at) AS last_request_at,
        COUNT(CASE WHEN l.status_code >= 400 THEN 1 END)::int AS failed_requests
      FROM api_keys k
      LEFT JOIN api_key_usage_logs l ON k.id = l.api_key_id
      WHERE k.user_id = $1
      GROUP BY k.id
      ORDER BY k.created_at DESC;
    `
    const res = await db.query(queryText, [userId])
    if (res && res.rows) {
      return res.rows
    }
    return []
  } catch (error) {
    return memoryKeys
      .filter((k) => k.user_id === userId)
      .map((k) => {
        const logs = memoryLogs.filter((l) => l.api_key_id === k.id)
        return {
          id: k.id,
          user_id: k.user_id,
          name: k.name,
          prefix: k.prefix,
          display_key: k.display_key,
          plan: k.plan,
          rate_limit_per_minute: k.rate_limit_per_minute,
          is_active: k.is_active,
          last_used_at: k.last_used_at,
          expires_at: k.expires_at,
          created_at: k.created_at,
          total_requests: logs.length,
          last_request_at: logs.length > 0 ? logs[logs.length - 1].created_at : null,
          failed_requests: logs.filter((l) => l.status_code >= 400).length,
        }
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
}

const findByIdAndUserId = async (id, userId) => {
  try {
    const res = await db.query(
      'SELECT id, user_id, name, prefix, display_key, plan, rate_limit_per_minute, is_active, last_used_at, expires_at, created_at FROM api_keys WHERE id = $1 AND user_id = $2 LIMIT 1',
      [id, userId]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    return memoryKeys.find((k) => k.id === id && k.user_id === userId) || null
  }
}

const revoke = async (id, userId) => {
  try {
    const res = await db.query(
      `UPDATE api_keys
       SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, prefix, display_key, plan, is_active, updated_at`,
      [id, userId]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    const key = memoryKeys.find((k) => k.id === id && k.user_id === userId)
    if (key) {
      key.is_active = false
      key.updated_at = new Date().toISOString()
      return {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        display_key: key.display_key,
        plan: key.plan,
        is_active: key.is_active,
        updated_at: key.updated_at,
      }
    }
    return null
  }
}

const updateLastUsed = async (id) => {
  try {
    await db.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [id])
  } catch (error) {
    const key = memoryKeys.find((k) => k.id === id)
    if (key) {
      key.last_used_at = new Date().toISOString()
    }
  }
}

const recordUsage = async ({ apiKeyId, endpoint, method, statusCode, ipAddress }) => {
  try {
    await db.query(
      `INSERT INTO api_key_usage_logs (api_key_id, endpoint, method, status_code, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [apiKeyId, endpoint, method, statusCode, ipAddress]
    )
  } catch (error) {
    memoryLogs.push({
      id: memoryLogs.length + 1,
      api_key_id: apiKeyId,
      endpoint,
      method,
      status_code: statusCode,
      ip_address: ipAddress,
      created_at: new Date().toISOString(),
    })
  }
}

const getKeyAnalytics = async (id, userId) => {
  try {
    const queryText = `
      SELECT 
        k.id,
        k.name,
        k.prefix,
        k.display_key,
        k.plan,
        k.rate_limit_per_minute,
        k.is_active,
        k.created_at,
        k.last_used_at,
        COUNT(l.id)::int AS total_requests,
        COUNT(CASE WHEN l.status_code >= 200 AND l.status_code < 400 THEN 1 END)::int AS success_requests,
        COUNT(CASE WHEN l.status_code >= 400 THEN 1 END)::int AS failed_requests,
        MIN(l.created_at) AS first_request_at,
        MAX(l.created_at) AS last_request_at
      FROM api_keys k
      LEFT JOIN api_key_usage_logs l ON k.id = l.api_key_id
      WHERE k.id = $1 AND k.user_id = $2
      GROUP BY k.id;
    `
    const res = await db.query(queryText, [id, userId])
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    const key = memoryKeys.find((k) => k.id === id && k.user_id === userId)
    if (!key) return null
    const logs = memoryLogs.filter((l) => l.api_key_id === id)
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      display_key: key.display_key,
      plan: key.plan,
      rate_limit_per_minute: key.rate_limit_per_minute,
      is_active: key.is_active,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
      total_requests: logs.length,
      success_requests: logs.filter((l) => l.status_code >= 200 && l.status_code < 400).length,
      failed_requests: logs.filter((l) => l.status_code >= 400).length,
      first_request_at: logs.length > 0 ? logs[0].created_at : null,
      last_request_at: logs.length > 0 ? logs[logs.length - 1].created_at : null,
    }
  }
}

module.exports = {
  create,
  findByKeyHash,
  findByUserId,
  findByIdAndUserId,
  revoke,
  updateLastUsed,
  recordUsage,
  getKeyAnalytics,
}

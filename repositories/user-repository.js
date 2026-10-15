const db = require('../db/connect')

// In-memory fallback for local testing/development when PG is not yet connected
const memoryUsers = []

const findByEmail = async (email) => {
  try {
    const res = await db.query(
      'SELECT id, name, email, password_hash, created_at, updated_at FROM users WHERE email = $1 LIMIT 1',
      [email]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    // Fallback to in-memory store if DB is offline or not configured
    return memoryUsers.find((user) => user.email === email) || null
  }
}

const findById = async (id) => {
  try {
    const res = await db.query(
      'SELECT id, name, email, password_hash, created_at, updated_at FROM users WHERE id = $1 LIMIT 1',
      [id]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
    return null
  } catch (error) {
    return memoryUsers.find((user) => user.id === id) || null
  }
}

const create = async (userData) => {
  try {
    const res = await db.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, password_hash, created_at, updated_at`,
      [userData.name, userData.email, userData.password_hash]
    )
    if (res && res.rows && res.rows.length > 0) {
      return res.rows[0]
    }
  } catch (error) {
    // If table doesn't exist or DB unavailable, fallback to in-memory
  }

  const newUser = {
    id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    ...userData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  memoryUsers.push(newUser)
  return newUser
}

module.exports = {
  findByEmail,
  findById,
  create,
}

const { Pool } = require('pg')

// PostgreSQL Connection Pool configuration
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'devgate',
      max: 20,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 2000,
      allowExitOnIdle: true,
    }

const pool = new Pool(poolConfig)

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err)
})

const query = async (text, params) => {
  const start = Date.now()
  const res = await pool.query(text, params)
  const duration = Date.now() - start
  return res
}

const getClient = async () => {
  return await pool.connect()
}

module.exports = {
  pool,
  query,
  getClient,
}

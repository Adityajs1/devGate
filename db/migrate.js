const fs = require('fs')
const path = require('path')
const { pool } = require('./connect')

const runMigration = async () => {
  const schemaPath = path.join(__dirname, 'schema.sql')
  const schemaSql = fs.readFileSync(schemaPath, 'utf8')

  console.log('Running PostgreSQL migration from schema.sql...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(schemaSql)
    await client.query('COMMIT')
    console.log('PostgreSQL migration completed successfully.')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Migration failed:', error)
    throw error
  } finally {
    client.release()
  }
}

if (require.main === module) {
  require('dotenv').config()
  runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}

module.exports = runMigration

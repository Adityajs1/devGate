const logger = require('./logger')
const { pool } = require('../db/connect')
const { redisClient } = require('../services/redis-service')
const queueService = require('../services/queue-service')

/**
 * Handles graceful shutdown on SIGTERM / SIGINT signals:
 * 1. Stops accepting incoming traffic on HTTP server
 * 2. Drains active keep-alive connections
 * 3. Flushes and closes background workers & BullMQ queues
 * 4. Disconnects Redis client
 * 5. Drains PostgreSQL database connection pool
 * 6. Exits cleanly with status code 0
 */
const setupGracefulShutdown = (server) => {
  let isShuttingDown = false

  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info(`Received ${signal}. Initiating graceful shutdown...`)

    // Forceful exit fallback if cleanup hangs beyond 10 seconds
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 10s. Forcing exit.')
      process.exit(1)
    }, 10000)
    forceExitTimer.unref()

    try {
      // 1. Stop HTTP server from accepting new connections
      if (server) {
        if (server.closeIdleConnections) {
          server.closeIdleConnections()
        }
        await new Promise((resolve) => server.close(resolve))
        logger.info('HTTP server closed: in-flight requests drained.')
      }

      // 2. Flush and close background queue workers
      await queueService.closeQueue()
      logger.info('Background queue workers stopped and drained.')

      // 3. Disconnect Redis
      if (redisClient && redisClient.quit) {
        await redisClient.quit().catch(() => {})
        logger.info('Redis client disconnected.')
      }

      // 4. Drain PostgreSQL database connection pool
      await pool.end().catch(() => {})
      logger.info('PostgreSQL connection pool drained.')

      logger.info('Graceful shutdown completed successfully. Exiting process.')
      process.exit(0)
    } catch (err) {
      logger.error('Error during graceful shutdown:', err)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  return gracefulShutdown
}

module.exports = {
  setupGracefulShutdown,
}

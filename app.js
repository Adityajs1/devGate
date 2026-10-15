const config = require('./config') // Envalid startup validation
const express = require('express')
const app = express()

const mainRouter = require('./routes/main')
const healthRouter = require('./routes/health')
const notFoundMiddleware = require('./middleware/not-found')
const errorHandlerMiddleware = require('./middleware/error-handler')
const requestIdMiddleware = require('./middleware/request-id')
const metricsMiddleware = require('./middleware/metrics')
const { setupGracefulShutdown } = require('./utils/lifecycle')

// Early observability middlewares
app.use(requestIdMiddleware)
app.use(metricsMiddleware)

// Root health checks & Prometheus metrics endpoint
app.use('/', healthRouter)

// Core Express middlewares
app.use(express.json())
app.use('/api/v1', mainRouter)

// Error & Not Found handling
app.use(notFoundMiddleware)
app.use(errorHandlerMiddleware)

const port = config.PORT || 5173

const start = async () => {
  try {
    const server = app.listen(port, () => console.log(`Server is listening on the port ${port}...`))
    setupGracefulShutdown(server)
    return server
  } catch (error) {
    console.error('Failed to start server:', error)
  }
}

if (require.main === module) {
  start()
}

module.exports = app
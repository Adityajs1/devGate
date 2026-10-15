const config = require('./config') // Envalid startup validation
const express = require('express')
const app = express()

const mainRouter = require('./routes/main')
const notFoundMiddleware = require('./middleware/not-found')
const errorHandlerMiddleware = require('./middleware/error-handler')
const requestIdMiddleware = require('./middleware/request-id')

app.use(requestIdMiddleware)
app.use(express.json())
app.use('/api/v1', mainRouter)
app.use(notFoundMiddleware)
app.use(errorHandlerMiddleware)

const port = config.PORT || 5173

const start = async () => {
  try {
    app.listen(port, () => console.log(`Server is listening on the port ${port}...`))
  } catch (error) {
    console.error('Failed to start server:', error)
  }
}

if (require.main === module) {
  start()
}

module.exports = app
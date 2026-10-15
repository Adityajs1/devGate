const { v4: uuidv4 } = require('uuid')

/**
 * Request ID Middleware
 * Attaches a unique request identifier (UUIDv4) to every incoming request.
 * Sets the X-Request-Id response header for end-to-end tracing across distributed services.
 */
const requestIdMiddleware = (req, res, next) => {
  const requestId = req.headers['x-request-id'] || `req_${uuidv4()}`
  req.id = requestId
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  next()
}

module.exports = requestIdMiddleware

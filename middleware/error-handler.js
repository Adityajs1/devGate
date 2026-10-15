const { CustomAPIError } = require('../errors')
const { StatusCodes } = require('http-status-codes')

const errorHandlerMiddleware = (err, req, res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[Error Handler] ${req.method} ${req.url} ->`, err.message)
  }

  // Handle known Custom API Errors (BadRequest, Unauthenticated, RateLimit, BadGateway, etc.)
  if (err instanceof CustomAPIError) {
    return res.status(err.statusCode).json({
      success: false,
      msg: err.message,
      statusCode: err.statusCode,
      timestamp: new Date().toISOString(),
    })
  }

  // Handle unexpected internal server errors
  return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    success: false,
    msg: 'Internal Server Error: Something went wrong',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    timestamp: new Date().toISOString(),
  })
}

module.exports = errorHandlerMiddleware

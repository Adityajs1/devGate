const { CustomAPIError } = require('../errors')
const { StatusCodes } = require('http-status-codes')
const errorHandlerMiddleware = (err, req, res, next) => {
  console.error('Error details:', err)
  
  if (err instanceof CustomAPIError) {
    return res.status(err.statusCode).json({ msg: err.message })
  }
  
  return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
    msg: 'Something went wrong try again later',
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  })
}

module.exports = errorHandlerMiddleware

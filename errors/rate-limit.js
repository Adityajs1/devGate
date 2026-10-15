const { StatusCodes } = require('http-status-codes')
const CustomAPIError = require('./custom-error')

class RateLimitError extends CustomAPIError {
  constructor(message = 'Too Many Requests: Rate limit exceeded') {
    super(message)
    this.statusCode = StatusCodes.TOO_MANY_REQUESTS // 429
  }
}

module.exports = RateLimitError

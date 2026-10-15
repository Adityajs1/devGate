const { StatusCodes } = require('http-status-codes')
const CustomAPIError = require('./custom-error')

class BadGatewayError extends CustomAPIError {
  constructor(message = 'Bad Gateway: Upstream service unavailable or returned an invalid response') {
    super(message)
    this.statusCode = StatusCodes.BAD_GATEWAY // 502
  }
}

module.exports = BadGatewayError

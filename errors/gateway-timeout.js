const { StatusCodes } = require('http-status-codes')
const CustomAPIError = require('./custom-error')

class GatewayTimeoutError extends CustomAPIError {
  constructor(message = 'Gateway Timeout: Upstream service took too long to respond') {
    super(message)
    this.statusCode = StatusCodes.GATEWAY_TIMEOUT // 504
  }
}

module.exports = GatewayTimeoutError

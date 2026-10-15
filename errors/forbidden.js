const { StatusCodes } = require('http-status-codes')
const CustomAPIError = require('./custom-error')

class ForbiddenError extends CustomAPIError {
  constructor(message = 'Forbidden: Access denied') {
    super(message)
    this.statusCode = StatusCodes.FORBIDDEN // 403
  }
}

module.exports = ForbiddenError

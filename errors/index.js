const CustomAPIError = require('./custom-error')
const BadRequestError = require('./bad-request')
const UnauthenticatedError = require('./unauthenticated')
const NotFoundError = require('./not-found')
const RateLimitError = require('./rate-limit')
const BadGatewayError = require('./bad-gateway')
const GatewayTimeoutError = require('./gateway-timeout')
const ForbiddenError = require('./forbidden')

module.exports = {
  CustomAPIError,
  BadRequestError,
  UnauthenticatedError,
  NotFoundError,
  RateLimitError,
  BadGatewayError,
  GatewayTimeoutError,
  ForbiddenError,
}

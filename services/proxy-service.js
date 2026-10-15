const config = require('../config')
const { BadGatewayError, GatewayTimeoutError } = require('../errors')

/**
 * Forwards incoming client requests to upstream servers.
 * Preserves method, headers, query parameters, and payload.
 * Maps network failures to BadGatewayError (502) and timeouts to GatewayTimeoutError (504).
 */
const forwardRequest = async (req, res, targetUrl) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), config.PROXY_TIMEOUT_MS)

  // Construct forwarded headers
  const forwardedHeaders = { ...req.headers }
  delete forwardedHeaders.host
  delete forwardedHeaders.connection
  delete forwardedHeaders['content-length']
  forwardedHeaders['x-forwarded-for'] = req.ip || req.socket.remoteAddress
  forwardedHeaders['x-forwarded-host'] = req.get('host')
  forwardedHeaders['x-gateway'] = 'DevGate/1.0'
  forwardedHeaders['x-devgate-key-id'] = req.apiKey ? req.apiKey.id : 'anonymous'

  // Prepare body for non-GET/HEAD methods
  let body = undefined
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    forwardedHeaders['content-type'] = 'application/json'
  }

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardedHeaders,
      body,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    // Forward upstream status code and headers
    res.status(upstreamResponse.status)
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (
        key.toLowerCase() !== 'content-encoding' &&
        key.toLowerCase() !== 'transfer-encoding' &&
        key.toLowerCase() !== 'content-length'
      ) {
        res.setHeader(key, value)
      }
    }
    res.setHeader('X-Gateway-Proxy', 'DevGate')

    const responseText = await upstreamResponse.text()
    try {
      const json = JSON.parse(responseText)
      return res.json(json)
    } catch (e) {
      return res.send(responseText)
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error.name === 'AbortError') {
      throw new GatewayTimeoutError(`Gateway Timeout: Upstream timed out after ${config.PROXY_TIMEOUT_MS}ms`)
    }

    throw new BadGatewayError(`Bad Gateway: Upstream connection failed - ${error.message}`)
  }
}

module.exports = {
  forwardRequest,
}

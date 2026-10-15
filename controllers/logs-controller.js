const { StatusCodes } = require('http-status-codes')
const elasticsearchService = require('../services/elasticsearch-service')

/**
 * Controller to search and filter Elasticsearch gateway logs with pagination
 * Supports both cursor-based and limit/offset pagination
 */
const getGatewayLogs = async (req, res) => {
  const {
    keyId,
    path,
    status,
    method,
    startDate,
    endDate,
    minLatency,
    maxLatency,
    limit,
    offset,
    cursor,
    sortOrder = 'desc',
  } = req.query

  const filters = {
    userId: req.user.userId,
    keyId,
    path,
    status: status ? Number(status) : undefined,
    method,
    startDate,
    endDate,
    minLatency: minLatency ? Number(minLatency) : undefined,
    maxLatency: maxLatency ? Number(maxLatency) : undefined,
  }

  const pagination = {
    limit: limit ? parseInt(limit, 10) : 20,
    offset: offset ? parseInt(offset, 10) : 0,
    cursor,
  }

  const sort = {
    timestamp: sortOrder === 'asc' ? 'asc' : 'desc',
  }

  const result = await elasticsearchService.queryProxyLogs({
    filters,
    pagination,
    sort,
  })

  res.status(StatusCodes.OK).json({
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    cursor: result.cursor,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    aggregations: result.aggregations,
    logs: result.hits,
  })
}

module.exports = {
  getGatewayLogs,
}

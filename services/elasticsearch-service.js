const { Client } = require('@elastic/elasticsearch')
const config = require('../config')
const logger = require('../utils/logger')

let esClient = null
let isEsConnected = false

/**
 * Resilient In-Memory Elasticsearch Engine Fallback
 * Provides full index, filter, query, aggregations, and dual pagination (limit/offset & cursor-based)
 */
class InMemoryElasticsearch {
  constructor() {
    this.documents = []
  }

  async index(document) {
    const docWithId = {
      id: document.id || `es_doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: document.timestamp || new Date().toISOString(),
      ...document,
    }
    this.documents.push(docWithId)
    return { result: 'created', _id: docWithId.id }
  }

  async search({ filters = {}, pagination = {}, sort = { timestamp: 'desc' } }) {
    let filtered = [...this.documents]

    // Apply Filter Criteria
    if (filters.keyId) {
      filtered = filtered.filter((doc) => doc.keyId === filters.keyId)
    }
    if (filters.userId) {
      filtered = filtered.filter((doc) => doc.userId === filters.userId)
    }
    if (filters.status) {
      filtered = filtered.filter((doc) => doc.status === Number(filters.status))
    }
    if (filters.method) {
      filtered = filtered.filter((doc) => doc.method.toUpperCase() === filters.method.toUpperCase())
    }
    if (filters.path) {
      filtered = filtered.filter((doc) => doc.path.includes(filters.path))
    }
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime()
      filtered = filtered.filter((doc) => new Date(doc.timestamp).getTime() >= start)
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime()
      filtered = filtered.filter((doc) => new Date(doc.timestamp).getTime() <= end)
    }
    if (filters.minLatency !== undefined) {
      filtered = filtered.filter((doc) => doc.latencyMs >= Number(filters.minLatency))
    }
    if (filters.maxLatency !== undefined) {
      filtered = filtered.filter((doc) => doc.latencyMs <= Number(filters.maxLatency))
    }

    // Sort documents
    filtered.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime()
      const timeB = new Date(b.timestamp).getTime()
      return sort.timestamp === 'asc' ? timeA - timeB : timeB - timeA
    })

    const totalCount = filtered.length

    // Compute Aggregations (Summary Metrics)
    const latencies = filtered.map((d) => d.latencyMs)
    const avgLatency = latencies.length
      ? Math.round((latencies.reduce((sum, v) => sum + v, 0) / latencies.length) * 100) / 100
      : 0
    const statusBreakdown = filtered.reduce((acc, doc) => {
      acc[doc.status] = (acc[doc.status] || 0) + 1
      return acc
    }, {})

    // Dual Pagination: Cursor-based OR Limit/Offset
    const limit = Math.min(Math.max(parseInt(pagination.limit || 20, 10), 1), 100)
    let paginatedDocs = []
    let nextCursor = null
    let hasMore = false

    if (pagination.cursor) {
      // Cursor-based Pagination (Decodes cursor token)
      let cursorTime = null
      let cursorId = null
      try {
        const decoded = JSON.parse(Buffer.from(pagination.cursor, 'base64url').toString('utf8'))
        cursorTime = decoded.timestamp
        cursorId = decoded.id
      } catch (e) {
        // invalid cursor, start from beginning
      }

      let startIndex = 0
      if (cursorTime) {
        startIndex = filtered.findIndex((d) => d.timestamp === cursorTime && d.id === cursorId)
        startIndex = startIndex === -1 ? 0 : startIndex + 1
      }

      paginatedDocs = filtered.slice(startIndex, startIndex + limit)
      hasMore = startIndex + limit < filtered.length

      if (hasMore && paginatedDocs.length > 0) {
        const lastItem = paginatedDocs[paginatedDocs.length - 1]
        nextCursor = Buffer.from(
          JSON.stringify({ timestamp: lastItem.timestamp, id: lastItem.id })
        ).toString('base64url')
      }
    } else {
      // Limit / Offset Pagination
      const offset = Math.max(parseInt(pagination.offset || 0, 10), 0)
      paginatedDocs = filtered.slice(offset, offset + limit)
      hasMore = offset + limit < filtered.length

      if (hasMore && paginatedDocs.length > 0) {
        const lastItem = paginatedDocs[paginatedDocs.length - 1]
        nextCursor = Buffer.from(
          JSON.stringify({ timestamp: lastItem.timestamp, id: lastItem.id })
        ).toString('base64url')
      }
    }

    return {
      total: totalCount,
      limit,
      offset: pagination.cursor ? undefined : parseInt(pagination.offset || 0, 10),
      cursor: pagination.cursor || null,
      nextCursor,
      hasMore,
      aggregations: {
        totalRequests: totalCount,
        averageLatencyMs: avgLatency,
        minLatencyMs: latencies.length ? Math.min(...latencies) : 0,
        maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
        statusBreakdown,
      },
      hits: paginatedDocs,
    }
  }
}

const memoryEs = new InMemoryElasticsearch()

// Attempt connection to Elasticsearch cluster
try {
  esClient = new Client({
    node: config.ELASTICSEARCH_URL,
    maxRetries: 1,
    requestTimeout: 1000,
  })

  esClient.ping().then(() => {
    isEsConnected = true
    if (process.env.NODE_ENV !== 'test') {
      logger.info('Connected to Elasticsearch cluster for proxy log indexing.')
    }
  }).catch(() => {
    isEsConnected = false
  })
} catch (e) {
  isEsConnected = false
}

/**
 * Step 5: Records and indexes proxy transaction into Elasticsearch and structured logger
 * records: { keyId, path, status, latencyMs, timestamp }
 */
const recordProxyLog = async ({
  keyId = 'anonymous',
  userId = null,
  requestId,
  path,
  method,
  status,
  latencyMs,
  ip = null,
  userAgent = null,
}) => {
  const logEntry = {
    keyId,
    userId,
    requestId,
    path,
    method,
    status,
    latencyMs,
    ip,
    userAgent,
    timestamp: new Date().toISOString(),
  }

  // 1. Log with Winston Structured JSON Logger
  logger.info('Gateway Forwarded Request', {
    ...logEntry,
    message: `${method} ${path} -> ${status} (${latencyMs}ms)`,
  })

  // 2. Index into Elasticsearch (or Resilient in-memory index)
  if (isEsConnected && esClient) {
    try {
      await esClient.index({
        index: config.ELASTICSEARCH_INDEX,
        document: logEntry,
      })
      return
    } catch (err) {
      // Graceful fallback to memory index
    }
  }

  await memoryEs.index(logEntry)
}

/**
 * Queries and filters Elasticsearch logs with pagination and aggregations
 */
const queryProxyLogs = async ({ filters = {}, pagination = {}, sort = { timestamp: 'desc' } }) => {
  if (isEsConnected && esClient) {
    try {
      // Build Elasticsearch Bool Query
      const mustClauses = []
      if (filters.keyId) mustClauses.push({ term: { keyId: filters.keyId } })
      if (filters.userId) mustClauses.push({ term: { userId: filters.userId } })
      if (filters.status) mustClauses.push({ term: { status: Number(filters.status) } })
      if (filters.method) mustClauses.push({ term: { method: filters.method.toUpperCase() } })
      if (filters.path) mustClauses.push({ wildcard: { path: `*${filters.path}*` } })

      if (filters.startDate || filters.endDate) {
        const range = {}
        if (filters.startDate) range.gte = filters.startDate
        if (filters.endDate) range.lte = filters.endDate
        mustClauses.push({ range: { timestamp: range } })
      }

      const limit = Math.min(Math.max(parseInt(pagination.limit || 20, 10), 1), 100)
      const offset = Math.max(parseInt(pagination.offset || 0, 10), 0)

      const result = await esClient.search({
        index: config.ELASTICSEARCH_INDEX,
        query: mustClauses.length ? { bool: { must: mustClauses } } : { match_all: {} },
        sort: [{ timestamp: { order: sort.timestamp || 'desc' } }],
        from: offset,
        size: limit,
      })

      const hits = result.hits.hits.map((h) => ({ id: h._id, ...h._source }))
      return {
        total: result.hits.total.value,
        limit,
        offset,
        hits,
      }
    } catch (err) {
      // Fallback
      return await memoryEs.search({ filters, pagination, sort })
    }
  }

  return await memoryEs.search({ filters, pagination, sort })
}

module.exports = {
  recordProxyLog,
  queryProxyLogs,
  memoryEs,
}

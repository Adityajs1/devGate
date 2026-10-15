const { Queue, Worker } = require('bullmq')
const config = require('../config')
const webhookService = require('./webhook-service')
const { redisClient } = require('./redis-service')

const QUEUE_NAME = 'devgate-webhooks'
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 300

let webhookQueue = null
let webhookWorker = null
let useBullMQ = false

// In-Memory resilient queue fallback when Redis server is offline
class InMemoryQueue {
  constructor() {
    this.jobs = []
    this.deadLetterQueue = []
    this.isProcessing = false
  }

  async add(name, data, opts = {}) {
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name,
      data,
      attempts: 0,
      maxAttempts: opts.attempts || MAX_ATTEMPTS,
      backoffDelay: opts.backoff ? opts.backoff.delay || INITIAL_BACKOFF_MS : INITIAL_BACKOFF_MS,
    }
    this.jobs.push(job)
    this.processNext()
    return job
  }

  async processNext() {
    if (this.isProcessing || this.jobs.length === 0) return
    this.isProcessing = true

    const job = this.jobs.shift()
    try {
      job.attempts++
      await processWebhookJob(job)
      // Successfully delivered
      await webhookService.recordDelivery({
        webhookId: job.data.webhookId,
        event: job.data.event,
        payload: job.data.payload,
        status: 'delivered',
        attempts: job.attempts,
        responseStatus: 200,
      })
    } catch (error) {
      if (job.attempts < job.maxAttempts) {
        // Exponential backoff
        const backoff = job.backoffDelay * Math.pow(2, job.attempts - 1)
        setTimeout(() => {
          this.jobs.push(job)
          this.processNext()
        }, backoff)
      } else {
        // Max retries exhausted -> Move to Dead Letter Queue (DLQ)
        this.deadLetterQueue.push({ job, error: error.message, failedAt: new Date().toISOString() })
        await webhookService.recordDelivery({
          webhookId: job.data.webhookId,
          event: job.data.event,
          payload: job.data.payload,
          status: 'dead_letter',
          attempts: job.attempts,
          errorMessage: error.message,
        })
      }
    } finally {
      this.isProcessing = false
      if (this.jobs.length > 0) {
        this.processNext()
      }
    }
  }

  getDeadLetterQueue() {
    return this.deadLetterQueue
  }
}

const memoryQueue = new InMemoryQueue()

/**
 * Worker handler that signs and sends the webhook payload
 */
const processWebhookJob = async (job) => {
  const { webhookId, url, secret, event, payload } = job.data

  const timestamp = Math.floor(Date.now() / 1000)
  const payloadString = JSON.stringify(payload)
  const signature = webhookService.signPayload(secret, payloadString, timestamp)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'DevGate-Webhook-Dispatcher/1.0',
      'X-DevGate-Event': event,
      'X-DevGate-Timestamp': timestamp.toString(),
      'X-DevGate-Signature': `t=${timestamp},v1=${signature}`,
    },
    body: payloadString,
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok) {
    throw new Error(`Upstream webhook receiver returned HTTP ${response.status}`)
  }

  return { status: response.status }
}

// Initialize BullMQ if Redis client is verified connected
if (redisClient && redisClient.status === 'ready') {
  try {
    webhookQueue = new Queue(QUEUE_NAME, {
      connection: redisClient,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: INITIAL_BACKOFF_MS,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    })

    webhookWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        return await processWebhookJob(job)
      },
      {
        connection: redisClient,
        concurrency: 5,
      }
    )

    webhookWorker.on('completed', async (job) => {
      await webhookService.recordDelivery({
        webhookId: job.data.webhookId,
        event: job.data.event,
        payload: job.data.payload,
        status: 'delivered',
        attempts: job.attemptsMade + 1,
      })
    })

    webhookWorker.on('failed', async (job, err) => {
      if (job && job.attemptsMade >= MAX_ATTEMPTS) {
        // Sent to Dead Letter Queue (DLQ)
        await webhookService.recordDelivery({
          webhookId: job.data.webhookId,
          event: job.data.event,
          payload: job.data.payload,
          status: 'dead_letter',
          attempts: job.attemptsMade,
          errorMessage: err.message,
        })
      }
    })

    useBullMQ = true
  } catch (e) {
    useBullMQ = false
  }
}

/**
 * Enqueue a webhook delivery job with retries and exponential backoff
 */
const enqueueWebhookDelivery = async ({ webhookId, url, secret, event, payload }) => {
  if (useBullMQ && webhookQueue) {
    try {
      return await webhookQueue.add(
        'webhook-dispatch',
        { webhookId, url, secret, event, payload },
        {
          attempts: MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: INITIAL_BACKOFF_MS },
        }
      )
    } catch (e) {
      return await memoryQueue.add('webhook-dispatch', { webhookId, url, secret, event, payload })
    }
  }

  return await memoryQueue.add('webhook-dispatch', { webhookId, url, secret, event, payload })
}

/**
 * Triggers an event across all subscribed webhooks (e.g. rate_limit.exceeded)
 */
const triggerWebhookEvent = async (event, payload, userId = null) => {
  const subscriptions = await webhookService.findSubscribedWebhooks(event, userId)
  const jobs = []

  for (const sub of subscriptions) {
    const job = await enqueueWebhookDelivery({
      webhookId: sub.id,
      url: sub.url,
      secret: sub.secret,
      event,
      payload,
    })
    jobs.push(job)
  }

  return jobs
}

/**
 * Close worker and queue gracefully
 */
const closeQueue = async () => {
  try {
    if (webhookWorker) await webhookWorker.close()
    if (webhookQueue) await webhookQueue.close()
  } catch (e) {}
}

module.exports = {
  webhookQueue,
  webhookWorker,
  memoryQueue,
  enqueueWebhookDelivery,
  triggerWebhookEvent,
  closeQueue,
}

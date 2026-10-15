const { Queue, Worker } = require('bullmq')
const config = require('../config')
const webhookService = require('./webhook-service')
const backgroundTasks = require('./background-tasks')
const metricsService = require('./metrics-service')
const { redisClient } = require('./redis-service')

const QUEUE_NAME = 'devgate-tasks'
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 300

let taskQueue = null
let taskWorker = null
let useBullMQ = false

/**
 * Universal job executor handling send-webhook, email-usage-report, cleanup-expired-keys
 */
const executeJob = async (job) => {
  const { name, data } = job

  switch (name) {
    case 'send-webhook':
      return await backgroundTasks.handleSendWebhook(data)

    case 'email-usage-report':
      return await backgroundTasks.handleGenerateUsageReport(data)

    case 'cleanup-expired-keys':
      return await backgroundTasks.handleCleanupExpiredKeys()

    case 'webhook-dispatch':
    default: {
      const { webhookId, url, secret, event, payload } = data
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
  }
}

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
      await executeJob(job)
      metricsService.queueJobsTotal.inc({ job_name: job.name, status: 'completed' })

      if (job.data.webhookId) {
        await webhookService.recordDelivery({
          webhookId: job.data.webhookId,
          event: job.data.event || 'background.job',
          payload: job.data.payload || job.data,
          status: 'delivered',
          attempts: job.attempts,
          responseStatus: 200,
        })
      }
    } catch (error) {
      if (job.attempts < job.maxAttempts) {
        // Exponential backoff
        const backoff = job.backoffDelay * Math.pow(2, job.attempts - 1)
        setTimeout(() => {
          this.jobs.push(job)
          this.processNext()
        }, backoff)
      } else {
        // Dead Letter Queue
        metricsService.queueJobsTotal.inc({ job_name: job.name, status: 'dead_letter' })
        this.deadLetterQueue.push({ job, error: error.message, failedAt: new Date().toISOString() })

        if (job.data.webhookId) {
          await webhookService.recordDelivery({
            webhookId: job.data.webhookId,
            event: job.data.event || 'background.job',
            payload: job.data.payload || job.data,
            status: 'dead_letter',
            attempts: job.attempts,
            errorMessage: error.message,
          })
        }
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

// Initialize BullMQ if Redis client is connected
if (redisClient && redisClient.status === 'ready') {
  try {
    taskQueue = new Queue(QUEUE_NAME, {
      connection: redisClient,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: INITIAL_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: false,
      },
    })

    taskWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        return await executeJob(job)
      },
      {
        connection: redisClient,
        concurrency: 5,
      }
    )

    taskWorker.on('completed', async (job) => {
      metricsService.queueJobsTotal.inc({ job_name: job.name, status: 'completed' })
      if (job.data.webhookId) {
        await webhookService.recordDelivery({
          webhookId: job.data.webhookId,
          event: job.data.event,
          payload: job.data.payload,
          status: 'delivered',
          attempts: job.attemptsMade + 1,
        })
      }
    })

    taskWorker.on('failed', async (job, err) => {
      if (job && job.attemptsMade >= MAX_ATTEMPTS) {
        metricsService.queueJobsTotal.inc({ job_name: job.name, status: 'dead_letter' })
        if (job.data.webhookId) {
          await webhookService.recordDelivery({
            webhookId: job.data.webhookId,
            event: job.data.event,
            payload: job.data.payload,
            status: 'dead_letter',
            attempts: job.attemptsMade,
            errorMessage: err.message,
          })
        }
      }
    })

    useBullMQ = true
  } catch (e) {
    useBullMQ = false
  }
}

/**
 * Universal job enqueueing method
 * Example: queueService.addJob('send-webhook', { keyId, event: 'limit.warning' })
 */
const addJob = async (name, data, opts = {}) => {
  if (useBullMQ && taskQueue) {
    try {
      return await taskQueue.add(name, data, {
        attempts: opts.attempts || MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: INITIAL_BACKOFF_MS },
      })
    } catch (e) {
      return await memoryQueue.add(name, data, opts)
    }
  }

  return await memoryQueue.add(name, data, opts)
}

const enqueueWebhookDelivery = async ({ webhookId, url, secret, event, payload }) => {
  return await addJob('webhook-dispatch', { webhookId, url, secret, event, payload })
}

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

const closeQueue = async () => {
  try {
    if (taskWorker) await taskWorker.close()
    if (taskQueue) await taskQueue.close()
  } catch (e) {}
}

module.exports = {
  taskQueue,
  taskWorker,
  memoryQueue,
  addJob,
  enqueueWebhookDelivery,
  triggerWebhookEvent,
  closeQueue,
}

const { StatusCodes } = require('http-status-codes')
const webhookService = require('../services/webhook-service')
const queueService = require('../services/queue-service')

const registerWebhook = async (req, res) => {
  const { url, events } = req.body
  const webhook = await webhookService.registerWebhook({
    userId: req.user.userId,
    url,
    events,
  })

  res.status(StatusCodes.CREATED).json({
    message: 'Webhook registered successfully',
    webhook,
    warning: 'Store the webhook secret safely. It is used to verify HMAC signatures.',
  })
}

const listWebhooks = async (req, res) => {
  const webhooks = await webhookService.listWebhooks(req.user.userId)
  res.status(StatusCodes.OK).json({ count: webhooks.length, webhooks })
}

const deleteWebhook = async (req, res) => {
  const { id } = req.params
  await webhookService.deleteWebhook(id, req.user.userId)
  res.status(StatusCodes.OK).json({ message: 'Webhook deleted successfully' })
}

const getDeliveryLogs = async (req, res) => {
  const { status } = req.query
  const logs = await webhookService.getDeliveryLogs(status || null)
  res.status(StatusCodes.OK).json({ count: logs.length, logs })
}

const testDispatch = async (req, res) => {
  const { event = 'test.event', payload = { ping: 'pong' } } = req.body
  const jobs = await queueService.triggerWebhookEvent(event, payload, req.user.userId)
  res.status(StatusCodes.ACCEPTED).json({
    message: `Dispatched ${jobs.length} webhook job(s) to worker queue`,
    event,
    queuedJobs: jobs.length,
  })
}

module.exports = {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  getDeliveryLogs,
  testDispatch,
}

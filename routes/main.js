const express = require('express')
const router = express.Router()
const authRouter = require('./auth')
const keysRouter = require('./keys')
const gatewayRouter = require('./gateway')
const webhooksRouter = require('./webhooks')
const logsRouter = require('./logs')

router.use('/auth', authRouter)
router.use('/keys', keysRouter)
router.use('/gateway', gatewayRouter)
router.use('/webhooks', webhooksRouter)
router.use('/logs', logsRouter)

module.exports = router

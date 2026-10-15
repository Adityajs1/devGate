const express = require('express')
const router = express.Router()
const authRouter = require('./auth')
const keysRouter = require('./keys')
const gatewayRouter = require('./gateway')
const webhooksRouter = require('./webhooks')

router.use('/auth', authRouter)
router.use('/keys', keysRouter)
router.use('/gateway', gatewayRouter)
router.use('/webhooks', webhooksRouter)

module.exports = router

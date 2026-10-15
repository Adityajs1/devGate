const express = require('express')
const router = express.Router()
const authRouter = require('./auth')
const keysRouter = require('./keys')
const gatewayRouter = require('./gateway')

router.use('/auth', authRouter)
router.use('/keys', keysRouter)
router.use('/gateway', gatewayRouter)

module.exports = router

const express = require('express')
const router = express.Router()
const { register, login, getMe } = require('../controllers/auth-controller')
const authMiddleware = require('../middleware/auth')
const asyncHandler = require('../middleware/async')

router.post('/register', asyncHandler(register))
router.post('/login', asyncHandler(login))
router.get('/me', authMiddleware, asyncHandler(getMe))

module.exports = router

const authService = require('../services/auth-service')
const { registerSchema, loginSchema } = require('../schemas/auth')
const { StatusCodes } = require('http-status-codes')
const { BadRequestError } = require('../errors')

const register = async (req, res) => {
  const validationResult = registerSchema.safeParse(req.body)
  if (!validationResult.success) {
    const errorMessage = validationResult.error.issues.map(err => err.message).join(', ')
    throw new BadRequestError(errorMessage)
  }

  const { user, token } = await authService.register(validationResult.data)
  res.status(StatusCodes.CREATED).json({ user, token })
}

const login = async (req, res) => {
  const validationResult = loginSchema.safeParse(req.body)
  if (!validationResult.success) {
    const errorMessage = validationResult.error.issues.map(err => err.message).join(', ')
    throw new BadRequestError(errorMessage)
  }

  const { email, password } = validationResult.data
  const { user, token } = await authService.login(email, password)
  res.status(StatusCodes.OK).json({ user, token })
}

const getMe = async (req, res) => {
  const user = await authService.findUserById(req.user.userId)
  res.status(StatusCodes.OK).json({ user })
}

module.exports = {
  register,
  login,
  getMe,
}

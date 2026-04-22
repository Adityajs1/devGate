const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const userRepository = require('../repositories/user-repository')
const { BadRequestError, UnauthenticatedError } = require('../errors')

const register = async (userData) => {
  const existingUser = await userRepository.findByEmail(userData.email)
  if (existingUser) {
    throw new BadRequestError('Email already in use')
  }

  const salt = await bcrypt.genSalt(10)
  const passwordHash = await bcrypt.hash(userData.password, salt)

  const user = await userRepository.create({
    name: userData.name,
    email: userData.email,
    password_hash: passwordHash,
  })

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_LIFETIME,
  })

  // Strip password_hash before returning
  const { password_hash, ...userWithoutPassword } = user
  return { user: userWithoutPassword, token }
}

const login = async (email, password) => {
  const user = await userRepository.findByEmail(email)
  if (!user) {
    throw new UnauthenticatedError('Invalid credentials')
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password_hash)
  if (!isPasswordCorrect) {
    throw new UnauthenticatedError('Invalid credentials')
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_LIFETIME,
  })

  // Strip password_hash before returning
  const { password_hash, ...userWithoutPassword } = user
  return { user: userWithoutPassword, token }
}

const findUserById = async (id) => {
  const user = await userRepository.findById(id)
  if (!user) {
    throw new UnauthenticatedError('User not found')
  }
  const { password_hash, ...userWithoutPassword } = user
  return userWithoutPassword
}

module.exports = {
  register,
  login,
  findUserById,
}

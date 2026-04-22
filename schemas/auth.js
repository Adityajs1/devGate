const { z } = require('zod')

const registerSchema = z.object({
  name: z.string().min(1, 'auth failed'),
  email: z.string().email('auth failed'),
  password: z.string().min(6, 'auth failed'),
})

const loginSchema = z.object({
  email: z.string().email('login failed'),
  password: z.string().min(6, 'login failed'),
})

module.exports = {
  registerSchema,
  loginSchema,
}

const { z } = require('zod')

const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name cannot exceed 100 characters').optional().default('Default API Key'),
  prefix: z.string().regex(/^dg_(live|test)_[a-zA-Z0-9_-]*$/, 'Prefix must follow Stripe format (e.g., dg_live_ or dg_test_)').optional().default('dg_live_'),
  plan: z.enum(['free', 'pro', 'enterprise']).optional().default('free'),
  rateLimitPerMinute: z.number().int().positive('Rate limit must be a positive integer').optional(),
  expiresInDays: z.number().int().positive('Expiry must be positive number of days').optional(),
})

module.exports = {
  createApiKeySchema,
}

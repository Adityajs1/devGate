require('dotenv').config()
const { cleanEnv, str, port, num, url } = require('envalid')

/**
 * Validates environment variables at application startup.
 * Fails fast with descriptive error messages if required variables are missing or invalid.
 */
const env = cleanEnv(process.env, {
  NODE_ENV: str({
    choices: ['development', 'test', 'production'],
    default: 'development',
  }),
  PORT: port({ default: 5173 }),
  JWT_SECRET: str({
    desc: 'Secret key for signing JSON Web Tokens',
    default: 'devgate-super-secret-jwt-key-min-32-chars-long!',
  }),
  JWT_LIFETIME: str({ default: '1d' }),
  
  // Database Configuration
  DATABASE_URL: str({ default: '' }),
  PGHOST: str({ default: 'localhost' }),
  PGPORT: port({ default: 5432 }),
  PGUSER: str({ default: 'postgres' }),
  PGPASSWORD: str({ default: '' }),
  PGDATABASE: str({ default: 'devgate' }),

  // Redis Configuration for sliding window rate-limiting & caching
  REDIS_URL: str({ default: 'redis://127.0.0.1:6379' }),
  
  // Rate Limiting Defaults
  RATE_LIMIT_WINDOW_MS: num({ default: 60000, desc: 'Sliding window duration in ms' }),
  RATE_LIMIT_MAX_REQUESTS: num({ default: 60, desc: 'Max requests allowed per window per API key' }),

  // Caching Defaults
  CACHE_TTL_SECONDS: num({ default: 60, desc: 'Default cache time-to-live in seconds' }),

  // Upstream Gateway Proxying
  DEFAULT_UPSTREAM_URL: str({ default: 'https://httpbin.org', desc: 'Default upstream destination for proxying' }),
  PROXY_TIMEOUT_MS: num({ default: 10000, desc: 'Upstream HTTP request timeout in ms' }),
})

module.exports = env

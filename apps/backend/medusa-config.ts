import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// iyzico is only registered once its keys are set, so the backend still boots without them.
const iyzicoEnabled = Boolean(process.env.IYZICO_API_KEY && process.env.IYZICO_SECRET_KEY)

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    //redisUrl: process.env.REDIS_URL,
    //workerMode: process.env.MEDUSA_WORKER_MODE as "shared" | "worker" | "server",
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  },
  // NOTE: when the Redis modules below are re-enabled, merge them into this same `modules` array.
  modules: [
    ...(iyzicoEnabled
      ? [
          {
            resolve: "@medusajs/medusa/payment",
            options: {
              providers: [
                {
                  resolve: "./src/modules/iyzico",
                  id: "iyzico",
                  options: {
                    apiKey: process.env.IYZICO_API_KEY,
                    secretKey: process.env.IYZICO_SECRET_KEY,
                    baseUrl: process.env.IYZICO_BASE_URL || "https://sandbox-api.iyzipay.com",
                    backendPublicUrl: process.env.BACKEND_PUBLIC_URL,
                    storefrontUrl: process.env.STOREFRONT_URL,
                    locale: process.env.IYZICO_LOCALE || "tr",
                    fallbackIdentityNumber: process.env.IYZICO_FALLBACK_IDENTITY_NUMBER,
                    fallbackGsmNumber: process.env.IYZICO_FALLBACK_GSM_NUMBER,
                  },
                },
              ],
            },
          },
        ]
      : []),
  ],
   /*admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN === "true",
    backendUrl: process.env.MEDUSA_BACKEND_URL,
  },
  modules: [
    {
      resolve: "@medusajs/medusa/caching",
      options: {
        providers: [
          {
            resolve: "@medusajs/caching-redis",
            id: "caching-redis",
            is_default: true,
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: {
        redis: {
          // Note: This was `url` before v2.12.2
          // It's now deprecated in favor of `redisUrl`
          redisUrl: process.env.REDIS_URL,
        },
      },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
        ],
      },
    },

  ]*/

})

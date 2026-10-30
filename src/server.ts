import "dotenv/config"
import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { MemoryStore } from "./memoryStore.js"
import { PostgresStore } from "./postgresStore.js"
import { seedListings } from "./seeds.js"

const config = loadConfig()
const store = config.databaseUrl
  ? new PostgresStore(config.databaseUrl)
  : new MemoryStore(seedListings)
const app = await buildApp({ config, store, logger: true })

await app.listen({ host: config.host, port: config.port })

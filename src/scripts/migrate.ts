import "dotenv/config"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const sql = postgres(databaseUrl, {
  max: 1,
  ssl: databaseUrl.includes("localhost") ? false : "require",
})
const migrationsUrl = new URL("../../migrations/", import.meta.url)
const files = (await readdir(fileURLToPath(migrationsUrl)))
  .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
  .sort()

for (const file of files) {
  const migration = await readFile(
    fileURLToPath(new URL(file, migrationsUrl)),
    "utf8",
  )
  await sql.unsafe(migration)
  console.log(`Applied migrations/${file}`)
}
await sql.end()

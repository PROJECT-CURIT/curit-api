import "dotenv/config"
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { seedListings } from "../seeds.js"
import { hashQrToken } from "../token.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const sql = postgres(databaseUrl, {
  max: 1,
  ssl: databaseUrl.includes("localhost") ? false : "require",
})

for (const seed of seedListings) {
  await sql`
    INSERT INTO qr_listings (
      id, qr_token_hash, token_hint, sale_status, price, stock, snapshot
    ) VALUES (
      ${randomUUID()}, ${hashQrToken(seed.token)}, ${seed.token.slice(-12)},
      ${seed.snapshot.saleStatus}, ${seed.snapshot.product.price},
      ${seed.snapshot.product.stock}, ${sql.json(seed.snapshot)}
    )
    ON CONFLICT (qr_token_hash) DO UPDATE SET
      sale_status = EXCLUDED.sale_status,
      price = EXCLUDED.price,
      stock = EXCLUDED.stock,
      snapshot = EXCLUDED.snapshot,
      updated_at = NOW()
  `
}

await sql.end()
console.log(`Seeded ${seedListings.length} QR listings`)

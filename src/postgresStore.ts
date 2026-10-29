import { randomUUID } from "node:crypto"
import postgres, { type Sql } from "postgres"
import {
  DomainError,
  type CommerceStore,
  type CreateOrderInput,
  type Order,
  type QrSnapshot,
} from "./domain.js"
import { hashQrToken } from "./token.js"

type ListingRow = {
  id: string
  stock: number
  price: number
  sale_status: "preparing" | "active"
  snapshot: QrSnapshot
}

type OrderRow = {
  id: string
  status: "paid"
  simulated: boolean
  artwork_id: string
  quantity: number
  amount: number
  payment_method: string
  pickup_mode: "immediate" | "exhibition"
  pickup_date: string
  cafe_name: string
  cafe_phone: string
  snapshot: QrSnapshot
  store_id: string
  request_id: string
  customer_name: string
}

function toOrder(row: OrderRow): Order {
  return {
    v: 1,
    id: row.id,
    status: row.status,
    simulated: row.simulated,
    artworkId: row.artwork_id,
    quantity: row.quantity,
    amount: row.amount,
    paymentMethod: row.payment_method,
    pickupMode: row.pickup_mode,
    pickupDate: row.pickup_date,
    cafeName: row.cafe_name,
    cafePhone: row.cafe_phone,
    snapshot: row.snapshot,
    storeId: row.store_id,
    requestId: row.request_id,
    customerLabel: row.customer_name,
  }
}

export class PostgresStore implements CommerceStore {
  private readonly sql: Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 5,
      ssl: databaseUrl.includes("localhost") ? false : "require",
      idle_timeout: 20,
      connect_timeout: 10,
    })
  }

  async getListing(qrToken: string) {
    const rows = await this.sql<ListingRow[]>`
      SELECT id, stock, price, sale_status, snapshot
      FROM qr_listings
      WHERE qr_token_hash = ${hashQrToken(qrToken)}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      ...row.snapshot,
      qrToken,
      saleStatus: row.sale_status,
      product: { ...row.snapshot.product, price: row.price, stock: row.stock },
    }
  }

  async createSession(token: string, customerPhone: string, expiresAt: Date) {
    await this.sql`
      INSERT INTO customer_sessions (token_hash, customer_phone, expires_at)
      VALUES (${hashQrToken(token)}, ${customerPhone}, ${expiresAt})
      ON CONFLICT (token_hash) DO UPDATE SET
        customer_phone = EXCLUDED.customer_phone,
        expires_at = EXCLUDED.expires_at
    `
  }

  async getSessionPhone(token: string) {
    const rows = await this.sql<{ customer_phone: string }[]>`
      SELECT customer_phone FROM customer_sessions
      WHERE token_hash = ${hashQrToken(token)} AND expires_at > NOW()
      LIMIT 1
    `
    return rows[0]?.customer_phone ?? null
  }

  async createOrder(input: CreateOrderInput) {
    return this.sql.begin(async (transaction) => {
      const updated = await transaction<ListingRow[]>`
        UPDATE qr_listings
        SET stock = stock - ${input.quantity}, updated_at = NOW()
        WHERE qr_token_hash = ${hashQrToken(input.qrToken)}
          AND sale_status = 'active'
          AND ${input.quantity} >= 1
          AND stock >= ${input.quantity}
        RETURNING id, stock, price, sale_status, snapshot
      `
      const listing = updated[0]
      if (!listing) {
        const exists = await transaction<{ stock: number; sale_status: string }[]>`
          SELECT stock, sale_status FROM qr_listings
          WHERE qr_token_hash = ${hashQrToken(input.qrToken)} LIMIT 1
        `
        if (!exists[0])
          throw new DomainError(
            "QR에 연결된 상품을 찾을 수 없어요.",
            404,
            "LISTING_NOT_FOUND",
          )
        if (exists[0].sale_status !== "active")
          throw new DomainError(
            "아직 판매가 시작되지 않은 상품이에요.",
            409,
            "SALE_NOT_ACTIVE",
          )
        throw new DomainError(
          "남은 재고보다 주문 수량이 많아요.",
          409,
          "INSUFFICIENT_STOCK",
        )
      }

      const snapshot: QrSnapshot = {
        ...listing.snapshot,
        qrToken: input.qrToken,
        saleStatus: listing.sale_status,
        product: {
          ...listing.snapshot.product,
          price: listing.price,
          stock: listing.stock + input.quantity,
        },
      }
      const id = "QR-" + randomUUID()
      const amount = listing.price * input.quantity
      const rows = await transaction<OrderRow[]>`
        INSERT INTO qr_orders (
          id, listing_id, customer_name, customer_phone, quantity, amount,
          status, simulated, payment_method, pickup_mode, pickup_date,
          cafe_name, cafe_phone, snapshot, store_id, request_id, artwork_id
        ) VALUES (
          ${id}, ${listing.id}, ${input.customerName}, ${input.customerPhone},
          ${input.quantity}, ${amount}, 'paid', ${input.simulated},
          ${input.paymentMethod}, ${snapshot.product.pickupMode},
          ${snapshot.product.exhibitionEnd}, ${snapshot.store.name},
          ${snapshot.store.phone}, ${this.sql.json(snapshot)}, ${snapshot.storeId},
          ${snapshot.requestId}, ${snapshot.product.artworkId}
        )
        RETURNING id, status, simulated, artwork_id, quantity, amount,
          payment_method, pickup_mode, pickup_date, cafe_name, cafe_phone,
          snapshot, store_id, request_id, customer_name
      `
      return toOrder(rows[0]!)
    })
  }

  async listOrders(customerPhone: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT id, status, simulated, artwork_id, quantity, amount,
        payment_method, pickup_mode, pickup_date, cafe_name, cafe_phone,
        snapshot, store_id, request_id, customer_name
      FROM qr_orders
      WHERE customer_phone = ${customerPhone}
      ORDER BY created_at DESC
    `
    return rows.map(toOrder)
  }

  async getOrder(orderId: string, customerPhone: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT id, status, simulated, artwork_id, quantity, amount,
        payment_method, pickup_mode, pickup_date, cafe_name, cafe_phone,
        snapshot, store_id, request_id, customer_name
      FROM qr_orders
      WHERE id = ${orderId} AND customer_phone = ${customerPhone}
      LIMIT 1
    `
    return rows[0] ? toOrder(rows[0]) : null
  }

  async close() {
    await this.sql.end({ timeout: 5 })
  }
}

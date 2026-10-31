import { randomUUID } from "node:crypto"
import postgres, { type Sql, type TransactionSql } from "postgres"
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
  listing_id: string
  status: "pending" | "paid" | "cancelled"
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
  customer_phone: string
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

const orderColumns = [
  "id",
  "listing_id",
  "status",
  "simulated",
  "artwork_id",
  "quantity",
  "amount",
  "payment_method",
  "pickup_mode",
  "pickup_date",
  "cafe_name",
  "cafe_phone",
  "snapshot",
  "store_id",
  "request_id",
  "customer_name",
  "customer_phone",
].join(", ")

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
      FROM qr_listings WHERE qr_token_hash = ${hashQrToken(qrToken)} LIMIT 1
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

  async recordListingView(
    qrToken: string,
    visitorHash: string,
    viewedOn: string,
  ) {
    await this.sql`
      INSERT INTO qr_view_events (listing_id, visitor_hash, viewed_on)
      SELECT id, ${visitorHash}, ${viewedOn}::date
      FROM qr_listings
      WHERE qr_token_hash = ${hashQrToken(qrToken)}
      ON CONFLICT (listing_id, visitor_hash, viewed_on) DO NOTHING
    `
  }

  async createSession(token: string, customerPhone: string, expiresAt: Date) {
    await this.sql`
      INSERT INTO customer_sessions (token_hash, customer_phone, expires_at)
      VALUES (${hashQrToken(token)}, ${customerPhone}, ${expiresAt})
      ON CONFLICT (token_hash) DO UPDATE SET customer_phone = EXCLUDED.customer_phone, expires_at = EXCLUDED.expires_at
    `
  }

  async getSessionPhone(token: string) {
    const rows = await this.sql<{ customer_phone: string }[]>`
      SELECT customer_phone FROM customer_sessions
      WHERE token_hash = ${hashQrToken(token)} AND expires_at > NOW() LIMIT 1
    `
    return rows[0]?.customer_phone ?? null
  }

  private async listingForOrder(
    sql: Sql | TransactionSql,
    input: CreateOrderInput,
  ) {
    const rows = await sql<ListingRow[]>`
      SELECT id, stock, price, sale_status, snapshot
      FROM qr_listings WHERE qr_token_hash = ${hashQrToken(input.qrToken)} LIMIT 1
    `
    const listing = rows[0]
    if (!listing)
      throw new DomainError(
        "QR에 연결된 상품을 찾을 수 없어요.",
        404,
        "LISTING_NOT_FOUND",
      )
    if (listing.sale_status !== "active")
      throw new DomainError(
        "아직 판매가 시작되지 않은 상품이에요.",
        409,
        "SALE_NOT_ACTIVE",
      )
    if (listing.stock < input.quantity)
      throw new DomainError(
        "남은 재고보다 주문 수량이 많아요.",
        409,
        "INSUFFICIENT_STOCK",
      )
    return listing
  }

  async prepareOrder(input: CreateOrderInput) {
    return this.sql.begin(async (transaction) => {
      const listing = await this.listingForOrder(transaction, input)
      const snapshot: QrSnapshot = {
        ...listing.snapshot,
        qrToken: input.qrToken,
        saleStatus: listing.sale_status,
        product: {
          ...listing.snapshot.product,
          price: listing.price,
          stock: listing.stock,
        },
      }
      const id = "QR-" + randomUUID()
      const amount = listing.price * input.quantity
      const rows = await transaction<OrderRow[]>`
        INSERT INTO qr_orders (
          id, listing_id, customer_name, customer_phone, quantity, amount,
          status, simulated, payment_method, pickup_mode, pickup_date,
          cafe_name, cafe_phone, snapshot, store_id, request_id, artwork_id, payment_provider
        ) VALUES (
          ${id}, ${listing.id}, ${input.customerName}, ${input.customerPhone},
          ${input.quantity}, ${amount}, 'pending', ${input.simulated}, ${input.paymentMethod},
          ${snapshot.product.pickupMode}, ${snapshot.product.exhibitionEnd}, ${snapshot.store.name},
          ${snapshot.store.phone}, ${this.sql.json(snapshot)}, ${snapshot.storeId},
          ${snapshot.requestId}, ${snapshot.product.artworkId}, ${
            input.simulated ? "demo" : "toss"
          }
        ) RETURNING ${this.sql.unsafe(orderColumns)}
      `
      return toOrder(rows[0]!)
    })
  }

  async createOrder(input: CreateOrderInput) {
    const pending = await this.prepareOrder(input)
    return this.confirmOrder(pending.id, "demo", input.customerPhone)
  }

  async getOrderForPayment(orderId: string, customerPhone: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.sql.unsafe(orderColumns)} FROM qr_orders
      WHERE id = ${orderId} AND customer_phone = ${customerPhone} LIMIT 1
    `
    return rows[0] ? toOrder(rows[0]) : null
  }

  async confirmOrder(
    orderId: string,
    paymentKey: string,
    customerPhone: string,
  ) {
    return this.sql.begin(async (transaction) => {
      const orders = await transaction<OrderRow[]>`
        SELECT ${this.sql.unsafe(orderColumns)} FROM qr_orders
        WHERE id = ${orderId} AND customer_phone = ${customerPhone} FOR UPDATE
      `
      const order = orders[0]
      if (!order)
        throw new DomainError(
          "주문 내역을 찾지 못했어요.",
          404,
          "ORDER_NOT_FOUND",
        )
      if (order.status === "paid") return toOrder(order)
      if (order.status !== "pending")
        throw new DomainError(
          "결제할 수 없는 주문입니다.",
          409,
          "ORDER_NOT_PENDING",
        )

      const listings = await transaction<ListingRow[]>`
        UPDATE qr_listings SET stock = stock - ${order.quantity}, updated_at = NOW()
        WHERE id = ${order.listing_id} AND sale_status = 'active' AND stock >= ${order.quantity}
        RETURNING id, stock, price, sale_status, snapshot
      `
      if (!listings[0])
        throw new DomainError(
          "남은 재고보다 주문 수량이 많아요.",
          409,
          "INSUFFICIENT_STOCK",
        )

      const updated = await transaction<OrderRow[]>`
        UPDATE qr_orders SET status = 'paid', payment_key = ${paymentKey}, paid_at = NOW(), updated_at = NOW()
        WHERE id = ${orderId} RETURNING ${this.sql.unsafe(orderColumns)}
      `

      await transaction`
        INSERT INTO settlement_entries (
          order_id, collaboration_id, creator_id, store_owner_id, gross_amount,
          creator_amount, store_amount, platform_amount, payment_fee_amount, status, scheduled_for
        )
        SELECT o.id, c.id, c.creator_id, s.owner_id, o.amount,
          floor(o.amount * c.creator_share_percent / 100)::integer,
          floor(o.amount * c.store_share_percent / 100)::integer,
          o.amount - floor(o.amount * c.creator_share_percent / 100)::integer
            - floor(o.amount * c.store_share_percent / 100)::integer,
          0, 'scheduled', (CURRENT_DATE + INTERVAL '14 days')::date
        FROM qr_orders o
        JOIN qr_listings l ON l.id = o.listing_id
        JOIN collaborations c ON c.id = l.collaboration_id
        JOIN store_profiles s ON s.id = c.store_id
        WHERE o.id = ${orderId}
        ON CONFLICT (order_id) DO NOTHING
      `
      return toOrder(updated[0]!)
    })
  }

  async cancelOrder(orderId: string, customerPhone: string) {
    await this.sql`
      UPDATE qr_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE id = ${orderId} AND customer_phone = ${customerPhone} AND status = 'pending'
    `
  }

  async listOrders(customerPhone: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.sql.unsafe(orderColumns)} FROM qr_orders
      WHERE customer_phone = ${customerPhone} AND status = 'paid' ORDER BY created_at DESC
    `
    return rows.map(toOrder)
  }

  async getOrder(orderId: string, customerPhone: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.sql.unsafe(orderColumns)} FROM qr_orders
      WHERE id = ${orderId} AND customer_phone = ${customerPhone} AND status = 'paid' LIMIT 1
    `
    return rows[0] ? toOrder(rows[0]) : null
  }

  async close() {
    await this.sql.end({ timeout: 5 })
  }
}

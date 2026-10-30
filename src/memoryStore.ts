import { randomUUID } from "node:crypto"
import {
  DomainError,
  type CommerceStore,
  type CreateOrderInput,
  type Order,
  type QrSnapshot,
} from "./domain.js"
import type { SeedListing } from "./seeds.js"

type StoredOrder = Order & {
  customerPhone: string
  createdAt: number
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryStore implements CommerceStore {
  private readonly listings = new Map<string, QrSnapshot>()
  private readonly orders = new Map<string, StoredOrder>()
  private readonly sessions = new Map<string, {
    customerPhone: string
    expiresAt: number
  }>()

  constructor(seeds: SeedListing[]) {
    for (const seed of seeds)
      this.listings.set(seed.token, clone(seed.snapshot))
  }

  async getListing(qrToken: string) {
    const listing = this.listings.get(qrToken)
    return listing ? clone(listing) : null
  }

  async createSession(token: string, customerPhone: string, expiresAt: Date) {
    this.sessions.set(token, {
      customerPhone,
      expiresAt: expiresAt.getTime(),
    })
  }

  async getSessionPhone(token: string) {
    const session = this.sessions.get(token)
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return null
    }
    return session.customerPhone
  }

  async createOrder(input: CreateOrderInput) {
    const order = await this.prepareOrder(input)
    return this.confirmOrder(order.id, "demo", input.customerPhone)
  }

  async prepareOrder(input: CreateOrderInput) {
    const listing = this.listings.get(input.qrToken)
    if (!listing) {
      throw new DomainError(
        "QR에 연결된 상품을 찾을 수 없어요.",
        404,
        "LISTING_NOT_FOUND",
      )
    }
    if (listing.saleStatus !== "active") {
      throw new DomainError(
        "아직 판매가 시작되지 않은 상품이에요.",
        409,
        "SALE_NOT_ACTIVE",
      )
    }
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      throw new DomainError(
        "주문 수량을 확인해 주세요.",
        400,
        "INVALID_QUANTITY",
      )
    }
    if (listing.product.stock < input.quantity) {
      throw new DomainError(
        "남은 재고보다 주문 수량이 많아요.",
        409,
        "INSUFFICIENT_STOCK",
      )
    }

    const orderSnapshot = clone(listing)
    const order: StoredOrder = {
      v: 1,
      id: "QR-" + randomUUID(),
      status: "pending",
      simulated: input.simulated,
      artworkId: listing.product.artworkId,
      quantity: input.quantity,
      amount: listing.product.price * input.quantity,
      paymentMethod: input.paymentMethod,
      pickupMode: listing.product.pickupMode,
      pickupDate: listing.product.exhibitionEnd,
      cafeName: listing.store.name,
      cafePhone: listing.store.phone,
      snapshot: orderSnapshot,
      storeId: listing.storeId,
      requestId: listing.requestId,
      customerLabel: input.customerName,
      customerPhone: input.customerPhone,
      createdAt: Date.now(),
    }
    this.orders.set(order.id, order)
    return clone(order)
  }

  async getOrderForPayment(orderId: string, customerPhone: string) {
    const order = this.orders.get(orderId)
    return order?.customerPhone === customerPhone ? clone(order) : null
  }

  async confirmOrder(
    orderId: string,
    _paymentKey: string,
    customerPhone: string,
  ) {
    const order = this.orders.get(orderId)
    if (!order || order.customerPhone !== customerPhone)
      throw new DomainError(
        "주문 내역을 찾지 못했어요.",
        404,
        "ORDER_NOT_FOUND",
      )
    if (order.status === "paid") return clone(order)
    if (order.status !== "pending")
      throw new DomainError(
        "결제할 수 없는 주문입니다.",
        409,
        "ORDER_NOT_PENDING",
      )
    const listing = this.listings.get(order.snapshot.qrToken)
    if (!listing || listing.product.stock < order.quantity)
      throw new DomainError(
        "남은 재고보다 주문 수량이 많아요.",
        409,
        "INSUFFICIENT_STOCK",
      )
    listing.product.stock -= order.quantity
    order.status = "paid"
    return clone(order)
  }

  async cancelOrder(orderId: string, customerPhone: string) {
    const order = this.orders.get(orderId)
    if (order?.customerPhone === customerPhone && order.status === "pending")
      order.status = "cancelled"
  }

  async listOrders(customerPhone: string) {
    return [...this.orders.values()]
      .filter(
        (order) =>
          order.customerPhone === customerPhone && order.status === "paid",
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((order) => clone(order))
  }

  async getOrder(orderId: string, customerPhone: string) {
    const order = this.orders.get(orderId)
    return order?.customerPhone === customerPhone ? clone(order) : null
  }

  async close() {}
}

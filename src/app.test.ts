import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "./app.js"
import type { AppConfig } from "./config.js"
import { MemoryStore } from "./memoryStore.js"
import { seedListings } from "./seeds.js"

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  webOrigin: "http://localhost:5173",
  publicWebUrl: "http://localhost:5173",
  sessionSecret: "test-secret-that-is-longer-than-thirty-two-characters",
  paymentMode: "demo",
  databaseUrl: "",
}

describe("CURI:T QR commerce API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    app = await buildApp({
      config,
      store: new MemoryStore(seedListings),
    })
  })

  afterEach(async () => app.close())

  it("resolves different QR tokens to different products", async () => {
    const mug = await app.inject({ method: "GET", url: "/api/v1/qr/demo-mug-white-gray" })
    const plate = await app.inject({ method: "GET", url: "/api/v1/qr/demo-dessert-plate" })

    expect(mug.statusCode).toBe(200)
    expect(plate.statusCode).toBe(200)
    expect(mug.json().product.artworkId).toBe("0-0")
    expect(plate.json().product.artworkId).toBe("0-2")
  })

  it("calculates amount from server data even if a client sends a fake price", async () => {
    const identity = await app.inject({
      method: "POST",
      url: "/api/auth/identity/start",
      payload: { phone: "01012345678", consent: true, remember: true },
    })
    const cookie = identity.cookies[0]!
    const checkout = await app.inject({
      method: "POST",
      url: "/api/checkout",
      cookies: { [cookie.name]: cookie.value },
      payload: {
        qrToken: "demo-mug-white-gray",
        quantity: 2,
        name: "테스트 구매자",
        paymentMethod: "card",
        cardIssuer: "신한",
        installment: "0",
        price: 1,
      },
    })

    expect(checkout.statusCode).toBe(200)
    const orderId = new URL(checkout.json().checkoutUrl).searchParams.get("order")!
    const order = await app.inject({
      method: "GET",
      url: `/api/orders/${encodeURIComponent(orderId)}`,
      cookies: { [cookie.name]: cookie.value },
    })
    expect(order.json().amount).toBe(70000)
    expect(order.json().simulated).toBe(true)
  })

  it("rejects an order that exceeds live stock", async () => {
    const identity = await app.inject({
      method: "POST",
      url: "/api/auth/identity/start",
      payload: { phone: "01012345678", consent: true },
    })
    const cookie = identity.cookies[0]!
    const response = await app.inject({
      method: "POST",
      url: "/api/checkout",
      cookies: { [cookie.name]: cookie.value },
      payload: {
        qrToken: "demo-bowl-set-2026",
        quantity: 7,
        name: "테스트 구매자",
        paymentMethod: "tosspay",
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe("INSUFFICIENT_STOCK")
  })
})

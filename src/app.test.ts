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
  tossClientKey: "",
  tossSecretKey: "",
}

const multiOriginConfig: AppConfig = {
  ...config,
  webOrigin: "http://localhost:5173, http://localhost:8082",
}

describe("CURI:T QR commerce API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryStore

  beforeEach(async () => {
    store = new MemoryStore(seedListings)
    app = await buildApp({
      config,
      store,
    })
  })

  afterEach(async () => app.close())

  it("resolves different QR tokens to different products", async () => {
    const mug = await app.inject({
      method: "GET",
      url: "/api/v1/qr/demo-mug-white-gray",
    })
    const plate = await app.inject({
      method: "GET",
      url: "/api/v1/qr/demo-dessert-plate",
    })

    expect(mug.statusCode).toBe(200)
    expect(plate.statusCode).toBe(200)
    expect(mug.json().product.artworkId).toBe("0-0")
    expect(plate.json().product.artworkId).toBe("0-2")
  })

  it("counts one anonymous browser once per listing and day", async () => {
    const visitor = "11111111-1111-4111-8111-111111111111"
    for (let index = 0; index < 2; index += 1)
      await app.inject({
        method: "GET",
        url: "/api/v1/qr/demo-mug-white-gray",
        headers: { "x-curit-visitor-id": visitor },
      })
    await app.inject({
      method: "GET",
      url: "/api/v1/qr/demo-mug-white-gray",
      headers: {
        "x-curit-visitor-id": "22222222-2222-4222-8222-222222222222",
      },
    })

    expect(store.getListingViewCount("demo-mug-white-gray")).toBe(2)
  })

  it("allows both QR web and mobile web origins", async () => {
    await app.close()
    app = await buildApp({
      config: multiOriginConfig,
      store: new MemoryStore(seedListings),
    })

    const qrWeb = await app.inject({
      method: "GET",
      url: "/api/v1/qr/demo-mug-white-gray",
      headers: { origin: "http://localhost:5173" },
    })
    const mobileWeb = await app.inject({
      method: "GET",
      url: "/api/v1/qr/demo-mug-white-gray",
      headers: { origin: "http://localhost:8082" },
    })

    expect(qrWeb.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    )
    expect(mobileWeb.headers["access-control-allow-origin"]).toBe(
      "http://localhost:8082",
    )
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
    const orderId = new URL(checkout.json().checkoutUrl).searchParams.get(
      "order",
    )!
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

  it("supports a bearer guest session for cross-origin deployments", async () => {
    const identity = await app.inject({
      method: "POST",
      url: "/api/auth/identity/start",
      payload: { phone: "01087654321", consent: true, remember: false },
    })
    const accessToken = identity.json().accessToken
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({
      verified: true,
      phone: "01087654321",
    })
  })

  it("creates a server-priced pending order before opening Toss Payments", async () => {
    await app.close()
    store = new MemoryStore(seedListings)
    app = await buildApp({
      config: {
        ...config,
        paymentMode: "toss",
        tossClientKey: "test_ck_example",
        tossSecretKey: "test_sk_example",
        publicWebUrl: "https://project-curit.github.io/curit-qr-web",
      },
      store,
    })
    const identity = await app.inject({
      method: "POST",
      url: "/api/auth/identity/start",
      payload: { phone: "01012345678", consent: true },
    })
    const checkout = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { authorization: `Bearer ${identity.json().accessToken}` },
      payload: {
        qrToken: "demo-mug-white-gray",
        quantity: 2,
        name: "테스트 구매자",
        paymentMethod: "card",
        price: 1,
      },
    })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().payment).toMatchObject({
      provider: "toss",
      amount: 70000,
      clientKey: "test_ck_example",
      successUrl:
        "https://project-curit.github.io/curit-qr-web/?qr=demo-mug-white-gray&payment=success",
    })

    const orderId = checkout.json().payment.orderId
    const otherIdentity = await app.inject({
      method: "POST",
      url: "/api/auth/identity/start",
      payload: { phone: "01099998888", consent: true },
    })
    const foreignAbandon = await app.inject({
      method: "POST",
      url: `/api/checkout/${encodeURIComponent(orderId)}/abandon`,
      headers: {
        authorization: `Bearer ${otherIdentity.json().accessToken}`,
      },
      payload: {},
    })
    expect(foreignAbandon.statusCode).toBe(200)
    expect(
      await store.getOrderForPayment(orderId, "01012345678"),
    ).toMatchObject({ status: "pending" })

    const abandoned = await app.inject({
      method: "POST",
      url: `/api/checkout/${encodeURIComponent(orderId)}/abandon`,
      headers: { authorization: `Bearer ${identity.json().accessToken}` },
      payload: {},
    })
    expect(abandoned.statusCode).toBe(200)
    expect(abandoned.json()).toEqual({ abandoned: true })
    expect(
      await store.getOrderForPayment(orderId, "01012345678"),
    ).toMatchObject({ status: "cancelled" })
  })
})

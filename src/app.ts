import { randomBytes } from "node:crypto"
import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import helmet from "@fastify/helmet"
import rateLimit from "@fastify/rate-limit"
import Fastify, { type FastifyRequest } from "fastify"
import type { AppConfig } from "./config.js"
import {
  DomainError,
  type CommerceStore,
  type CreateOrderInput,
} from "./domain.js"
import { assertQrToken, hashQrToken } from "./token.js"
import { cancelTossPayment, confirmTossPayment, TossError } from "./toss.js"

const SESSION_COOKIE = "curit_session"
const PHONE_PATTERN = /^01[016789]\d{7,8}$/

type BuildAppOptions = {
  config: AppConfig
  store: CommerceStore
  logger?: boolean
}

async function sessionPhone(request: FastifyRequest, store: CommerceStore) {
  const authorization = request.headers.authorization
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1]
  const value = bearer || request.cookies[SESSION_COOKIE]
  if (!value) return ""
  if (bearer) return (await store.getSessionPhone(bearer)) || ""
  const unsigned = request.unsignCookie(value)
  if (!unsigned.valid || !/^[A-Za-z0-9_-]{32,128}$/.test(unsigned.value))
    return ""
  return (await store.getSessionPhone(unsigned.value)) || ""
}

function paymentLabel(body: Record<string, unknown>) {
  if (body.paymentMethod === "card") {
    const issuer = String(body.cardIssuer || "")
    const installment = String(body.installment || "0")
    return `${issuer || "선택"}카드 · ${
      installment === "0" ? "일시불" : installment + "개월"
    }`
  }
  return body.paymentMethod === "kakaopay" ? "카카오페이" : "토스페이"
}

function qrWebUrl(baseUrl: string, token: string) {
  const destination = new URL(`${baseUrl}/`)
  destination.searchParams.set("qr", token)
  return destination
}

export async function buildApp({
  config,
  store,
  logger = false,
}: BuildAppOptions) {
  const app = Fastify({ logger, trustProxy: true })
  const allowedWebOrigins = config.webOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(cors, {
    origin: allowedWebOrigins,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" })

  app.get("/health", async () => ({ status: "ok" }))

  app.get<{ Params: { token: string } }>(
    "/api/v1/qr/:token",
    {
      schema: {
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 12, maxLength: 128 },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      let token = ""
      try {
        token = assertQrToken(request.params.token)
      } catch {
        return reply.code(404).send({ message: "구매 링크를 확인해 주세요." })
      }
      const listing = await store.getListing(token)
      if (!listing) {
        return reply
          .code(404)
          .send({ message: "QR에 연결된 상품을 찾을 수 없어요." })
      }
      const visitorId = request.headers["x-curit-visitor-id"]
      if (
        typeof visitorId === "string" &&
        /^[A-Za-z0-9_-]{16,128}$/.test(visitorId)
      ) {
        const viewedOn = new Date(Date.now() + 9 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10)
        await store.recordListingView(token, hashQrToken(visitorId), viewedOn)
      }
      return reply.header("Cache-Control", "no-store").send(listing)
    },
  )

  app.get("/api/auth/session", async (request) => {
    const phone = await sessionPhone(request, store)
    return phone ? { verified: true, phone } : { verified: false }
  })

  app.post<{
    Body: {
      phone: string
      consent: boolean
      remember?: boolean
    }
  }>(
    "/api/auth/identity/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["phone", "consent"],
          additionalProperties: true,
          properties: {
            phone: { type: "string", pattern: "^01[016789]\\d{7,8}$" },
            consent: { const: true },
            remember: { type: "boolean" },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      const maxAge = request.body.remember ? 30 * 86400 : 86400
      const sessionToken = randomBytes(32).toString("base64url")
      await store.createSession(
        sessionToken,
        request.body.phone,
        new Date(Date.now() + maxAge * 1000),
      )
      reply.setCookie(SESSION_COOKIE, sessionToken, {
        signed: true,
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        path: "/",
        maxAge,
      })
      return reply.send({
        verified: true,
        phone: request.body.phone,
        simulated: true,
        accessToken: sessionToken,
        expiresIn: maxAge,
      })
    },
  )

  app.get("/api/orders", async (request, reply) => {
    const phone = await sessionPhone(request, store)
    if (!phone)
      return reply
        .code(401)
        .send({ message: "휴대폰 번호를 다시 확인해 주세요." })
    return { orders: await store.listOrders(phone) }
  })

  app.get<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (request, reply) => {
      const phone = await sessionPhone(request, store)
      if (!phone)
        return reply
          .code(401)
          .send({ message: "휴대폰 번호를 다시 확인해 주세요." })
      const order = await store.getOrder(request.params.id, phone)
      if (!order)
        return reply.code(404).send({ message: "주문 내역을 찾지 못했어요." })
      return order
    },
  )

  app.post<{ Body: Record<string, unknown> }>(
    "/api/checkout",
    {
      schema: {
        body: {
          type: "object",
          required: ["qrToken", "quantity", "name", "paymentMethod"],
          additionalProperties: true,
          properties: {
            qrToken: { type: "string", minLength: 12, maxLength: 128 },
            quantity: { type: "integer", minimum: 1, maximum: 20 },
            name: { type: "string", minLength: 1, maxLength: 40 },
            paymentMethod: { enum: ["card", "kakaopay", "tosspay"] },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const phone = await sessionPhone(request, store)
      if (!phone)
        return reply
          .code(401)
          .send({ message: "휴대폰 번호를 다시 확인해 주세요." })
      const input: CreateOrderInput = {
        qrToken: assertQrToken(String(request.body.qrToken)),
        quantity: Number(request.body.quantity),
        customerName: String(request.body.name).trim(),
        customerPhone: phone,
        paymentMethod: paymentLabel(request.body),
        simulated: config.paymentMode === "demo",
      }
      if (config.paymentMode === "toss") {
        const order = await store.prepareOrder(input)
        const successUrl = qrWebUrl(config.publicWebUrl, input.qrToken)
        successUrl.searchParams.set("payment", "success")
        const failUrl = qrWebUrl(config.publicWebUrl, input.qrToken)
        failUrl.searchParams.set("payment", "fail")
        return {
          simulated: false,
          payment: {
            provider: "toss",
            clientKey: config.tossClientKey,
            customerKey: "ANONYMOUS",
            orderId: order.id,
            amount: order.amount,
            orderName: order.snapshot.product.name,
            customerName: order.customerLabel,
            successUrl: successUrl.href,
            failUrl: failUrl.href,
          },
        }
      }
      const order = await store.createOrder(input)
      const checkoutUrl = qrWebUrl(config.publicWebUrl, input.qrToken)
      checkoutUrl.searchParams.set("order", order.id)
      return { checkoutUrl: checkoutUrl.href, simulated: true }
    },
  )

  app.post<{
    Body: {
      paymentKey: string
      orderId: string
      amount: number
    }
  }>(
    "/api/payments/confirm",
    {
      schema: {
        body: {
          type: "object",
          required: ["paymentKey", "orderId", "amount"],
          additionalProperties: false,
          properties: {
            paymentKey: { type: "string", minLength: 10, maxLength: 300 },
            orderId: { type: "string", minLength: 10, maxLength: 80 },
            amount: { type: "integer", minimum: 1 },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const phone = await sessionPhone(request, store)
      if (!phone)
        return reply
          .code(401)
          .send({ message: "휴대폰 번호를 다시 확인해 주세요." })
      if (config.paymentMode !== "toss")
        return reply.code(409).send({ message: "현재 테스트 결제 모드입니다." })
      const pending = await store.getOrderForPayment(
        request.body.orderId,
        phone,
      )
      if (!pending)
        return reply.code(404).send({ message: "주문 내역을 찾지 못했어요." })
      if (pending.status === "paid") return pending
      if (
        pending.status !== "pending" ||
        pending.amount !== request.body.amount
      )
        return reply
          .code(400)
          .send({ message: "결제 금액 또는 주문 상태가 일치하지 않습니다." })

      await confirmTossPayment(
        config.tossSecretKey,
        request.body.paymentKey,
        pending.id,
        pending.amount,
      )
      try {
        return await store.confirmOrder(
          pending.id,
          request.body.paymentKey,
          phone,
        )
      } catch (error) {
        await cancelTossPayment(
          config.tossSecretKey,
          request.body.paymentKey,
          "재고 또는 주문 상태 불일치로 자동 취소",
          pending.id,
        ).catch(() => undefined)
        await store.cancelOrder(pending.id, phone)
        throw error
      }
    },
  )

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message })
    }
    if (error instanceof TossError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message })
    }
    if (error && typeof error === "object" && "validation" in error) {
      return reply
        .code(400)
        .send({ message: "입력한 정보를 다시 확인해 주세요." })
    }
    app.log.error(error)
    return reply.code(500).send({
      message: "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
    })
  })

  app.addHook("onClose", async () => store.close())
  return app
}

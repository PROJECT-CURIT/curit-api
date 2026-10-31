import { createClient } from "npm:@supabase/supabase-js@2.118.0"
import { CompactEncrypt, compactDecrypt } from "npm:jose@6.1.3"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
const DEFAULT_WEB_URL = "https://project-curit.github.io/curit-qr-web"
const PUBLIC_WEB_URL = (
  Deno.env.get("PUBLIC_WEB_URL") || DEFAULT_WEB_URL
).replace(/\/$/, "")
const PAYMENT_MODE = Deno.env.get("PAYMENT_MODE") === "toss" ? "toss" : "demo"
const TOSS_CLIENT_KEY = Deno.env.get("TOSS_CLIENT_KEY") || ""
const TOSS_SECRET_KEY = Deno.env.get("TOSS_SECRET_KEY") || ""
const TOSS_WEBHOOK_SECURITY_KEY =
  Deno.env.get("TOSS_WEBHOOK_SECURITY_KEY") || ""
const TOSS_EXPECTED_MID = Deno.env.get("TOSS_EXPECTED_MID") || ""
const TOSS_PAYOUT_SECRET_KEY = Deno.env.get("TOSS_PAYOUT_SECRET_KEY") || ""
const TOSS_PAYOUT_SECURITY_KEY = Deno.env.get("TOSS_PAYOUT_SECURITY_KEY") || ""
const PAYOUT_MODE = Deno.env.get("PAYOUT_MODE") === "toss" ? "toss" : "disabled"
const PAYOUT_JOB_SECRET = Deno.env.get("PAYOUT_JOB_SECRET") || ""
const OPERATIONS_JOB_SECRET =
  Deno.env.get("OPERATIONS_JOB_SECRET") || PAYOUT_JOB_SECRET
const FUNCTION_REGION = Deno.env.get("SB_REGION") || "unknown"
const origins = (
  Deno.env.get("WEB_ORIGIN") ||
  `${DEFAULT_WEB_URL},http://localhost:5173,http://localhost:8082`
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function cors(request: Request) {
  const origin = request.headers.get("origin") || ""
  return {
    "Access-Control-Allow-Origin": origins.includes(origin)
      ? origin
      : origins[0] || "",
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-client-info, x-curit-session, x-curit-visitor-id, x-curit-job-secret, apikey, tosspayments-webhook-signature, tosspayments-webhook-transmission-time, tosspayments-webhook-transmission-id",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  }
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function routePath(request: Request) {
  const path = new URL(request.url).pathname
  const marker = "/commerce"
  const index = path.indexOf(marker)
  return index >= 0 ? path.slice(index + marker.length) || "/" : path
}

function qrWebUrl(token: string) {
  const destination = new URL(`${PUBLIC_WEB_URL}/`)
  destination.searchParams.set("qr", token)
  return destination
}

async function phoneFor(request: Request) {
  const sessionToken =
    request.headers.get("x-curit-session") ||
    request.headers
      .get("authorization")
      ?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1] ||
    ""
  if (!sessionToken) return ""
  const tokenHash = await digest(sessionToken)
  const { data } = await admin
    .from("customer_sessions")
    .select("customer_phone")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()
  return typeof data?.customer_phone === "string" ? data.customer_phone : ""
}

function bearerFor(request: Request) {
  return (
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || ""
  )
}

async function appUserFor(request: Request) {
  const token = bearerFor(request)
  if (!token || !token.includes(".")) return null
  const { data, error } = await admin.auth.getUser(token)
  return error ? null : data.user
}

function managedListing(row: Record<string, unknown>) {
  const snapshot = row.snapshot as Record<string, any>
  const token = typeof row.qr_token_value === "string" ? row.qr_token_value : ""
  return {
    id: row.id,
    token,
    tokenHint: row.token_hint,
    productItemId: row.project_item_id,
    collaborationId: row.collaboration_id,
    name: snapshot?.product?.name || "등록 상품",
    artistName: snapshot?.creator?.name || snapshot?.product?.artist || "",
    imageUrl: snapshot?.product?.image || "",
    price: Number(row.price),
    stock: Number(row.stock),
    viewCount: Number(row.view_count || 0),
    status:
      row.sale_status === "active"
        ? Number(row.stock) > 0
          ? "ACTIVE"
          : "SOLD_OUT"
        : "PAUSED",
    pickupMode: snapshot?.product?.pickupMode || "immediate",
    qrUrl: token ? qrWebUrl(token).href : "",
  }
}

async function participantCollaboration(
  userId: string,
  collaborationId: string,
) {
  const collaboration = await admin
    .from("collaborations")
    .select("id, project_id, store_id, creator_id, status, starts_on, ends_on")
    .eq("id", collaborationId)
    .maybeSingle()
  if (collaboration.error) throw collaboration.error
  if (!collaboration.data) return null
  const store = await admin
    .from("store_profiles")
    .select("id, owner_id, name, address")
    .eq("id", collaboration.data.store_id)
    .maybeSingle()
  if (store.error) throw store.error
  if (
    !store.data ||
    (collaboration.data.creator_id !== userId && store.data.owner_id !== userId)
  )
    return null
  return { collaboration: collaboration.data, store: store.data }
}

async function managementListingIds(userId: string) {
  const profile = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle()
  if (profile.error) throw profile.error
  if (!profile.data) return [] as string[]
  if (profile.data.role === "creator") {
    const { data, error } = await admin
      .from("collaborations")
      .select("id")
      .eq("creator_id", userId)
    if (error) throw error
    return (data || []).map((row) => String(row.id))
  }
  const store = await admin
    .from("store_profiles")
    .select("id")
    .eq("owner_id", userId)
    .maybeSingle()
  if (store.error) throw store.error
  if (!store.data) return [] as string[]
  const { data, error } = await admin
    .from("collaborations")
    .select("id")
    .eq("store_id", store.data.id)
  if (error) throw error
  return (data || []).map((row) => String(row.id))
}

async function storeOwnerCollaborationIds(userId: string) {
  const store = await admin
    .from("store_profiles")
    .select("id")
    .eq("owner_id", userId)
    .maybeSingle()
  if (store.error) throw store.error
  if (!store.data) return null
  const collaborations = await admin
    .from("collaborations")
    .select("id")
    .eq("store_id", store.data.id)
  if (collaborations.error) throw collaborations.error
  return (collaborations.data || []).map((row) => String(row.id))
}

function orderResponse(row: Record<string, unknown>) {
  return {
    v: 1,
    id: row.id,
    status: row.status,
    simulated: row.simulated === true,
    artworkId: row.artwork_id,
    quantity: Number(row.quantity),
    amount: Number(row.amount),
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

async function toss(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const response = await fetch(
    `https://api.tosspayments.com/v1/payments${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${TOSS_SECRET_KEY}:`)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  )
  const result = await response.json().catch(() => ({}))
  if (!response.ok)
    throw Object.assign(
      new Error(result?.message || "결제 승인에 실패했습니다."),
      { status: response.status >= 500 ? 502 : 400, code: result?.code },
    )
  return result
}

function tossPaymentMethod(payment: Record<string, unknown>) {
  const method = String(payment.method || "").trim()
  if (!method) return ""
  if (method !== "간편결제") return method
  const easyPay = payment.easyPay as { provider?: unknown } | null
  const provider = String(easyPay?.provider || "").trim()
  return provider ? `${provider} 간편결제` : method
}

async function tossPayment(paymentKey: string) {
  const response = await fetch(
    `https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}`,
    {
      headers: { Authorization: `Basic ${btoa(`${TOSS_SECRET_KEY}:`)}` },
      signal: AbortSignal.timeout(5000),
    },
  )
  const result = await response.json().catch(() => ({}))
  if (!response.ok)
    throw Object.assign(new Error(result?.message || "결제 상태를 확인하지 못했습니다."), {
      status: response.status >= 500 ? 502 : 400,
      code: result?.code,
    })
  return result as Record<string, any>
}

function bytesFromHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value))
    throw Object.assign(new Error("토스 보안 키 형식이 올바르지 않습니다."), {
      status: 503,
    })
  return Uint8Array.from(value.match(/.{2}/g)!, (part) => parseInt(part, 16))
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index++)
    mismatch |= left[index]! ^ right[index]!
  return mismatch === 0
}

async function verifyTossWebhook(request: Request, rawBody: string) {
  if (!TOSS_WEBHOOK_SECURITY_KEY)
    throw Object.assign(new Error("웹훅 보안 키가 설정되지 않았습니다."), {
      status: 503,
    })
  const transmissionTime =
    request.headers.get("tosspayments-webhook-transmission-time") || ""
  const signature =
    request.headers.get("tosspayments-webhook-signature") || ""
  if (!transmissionTime || !signature)
    throw Object.assign(new Error("웹훅 서명 헤더가 없습니다."), {
      status: 401,
    })
  const key = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(TOSS_WEBHOOK_SECURITY_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${rawBody}:${transmissionTime}`),
    ),
  )
  const verified = signature.split(",").some((candidate) => {
    const encoded = candidate.trim().match(/^v1:(.+)$/)?.[1]
    if (!encoded) return false
    try {
      return sameBytes(expected, Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
    } catch {
      return false
    }
  })
  if (!verified)
    throw Object.assign(new Error("웹훅 서명이 일치하지 않습니다."), {
      status: 401,
    })
}

function webhookPaymentData(payload: Record<string, any>) {
  return payload.eventType === "PAYMENT_STATUS_CHANGED" ? payload.data : null
}

function lastCancellation(payment: Record<string, any>) {
  const cancellations = Array.isArray(payment.cancels) ? payment.cancels : []
  return cancellations.length ? cancellations[cancellations.length - 1] : null
}

async function sendPush(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {},
) {
  const targets = [...new Set(userIds.filter(Boolean))]
  if (!targets.length) return
  const devices = await admin
    .from("push_devices")
    .select("id, user_id, expo_push_token")
    .in("user_id", targets)
    .eq("active", true)
  if (devices.error) throw devices.error
  if (!devices.data?.length) return
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      devices.data.map((device) => ({
        to: device.expo_push_token,
        title,
        body,
        data,
        sound: "default",
        channelId: "curit-updates",
      })),
    ),
  })
  const result = await response.json().catch(() => ({}))
  const tickets = Array.isArray(result?.data) ? result.data : []
  const logs = devices.data.map((device, index) => {
    const ticket = tickets[index] || {}
    return {
      user_id: device.user_id,
      push_device_id: device.id,
      provider_ticket_id: typeof ticket.id === "string" ? ticket.id : null,
      status: ticket.status === "ok" ? "accepted" : "error",
      error_code: ticket.details?.error || null,
      error_message: ticket.message || null,
    }
  })
  await admin.from("push_delivery_logs").insert(logs)
  const invalidIds = devices.data
    .filter((_, index) => tickets[index]?.details?.error === "DeviceNotRegistered")
    .map((device) => device.id)
  if (invalidIds.length)
    await admin.from("push_devices").update({ active: false }).in("id", invalidIds)
  if (!response.ok) throw new Error("Expo 푸시 전송 요청이 실패했습니다.")
}

async function collaborationUsers(collaborationId: string) {
  const collaboration = await admin
    .from("collaborations")
    .select("creator_id, store_id")
    .eq("id", collaborationId)
    .maybeSingle()
  if (collaboration.error) throw collaboration.error
  if (!collaboration.data) return []
  const store = await admin
    .from("store_profiles")
    .select("owner_id")
    .eq("id", collaboration.data.store_id)
    .maybeSingle()
  if (store.error) throw store.error
  return [
    String(collaboration.data.creator_id || ""),
    String(store.data?.owner_id || ""),
  ]
}

async function sendOrderPaidPush(order: Record<string, any>) {
  const listing = await admin
    .from("qr_listings")
    .select("collaboration_id")
    .eq("id", order.listing_id)
    .maybeSingle()
  if (listing.error || !listing.data?.collaboration_id) return
  const users = (await collaborationUsers(listing.data.collaboration_id)).filter(Boolean)
  if (users.length)
    await admin.from("notifications").insert(
      users.map((userId) => ({
        user_id: userId,
        title: "새 QR 주문이 결제됐어요",
        body: `${(order.snapshot as Record<string, any>)?.product?.name || "상품"} ${Number(order.quantity)}개 주문을 확인해 주세요.`,
        kind: "order",
        entity_id: listing.data!.collaboration_id,
      })),
    )
  await sendPush(
    users,
    "새 QR 주문이 결제됐어요",
    `${(order.snapshot as Record<string, any>)?.product?.name || "상품"} ${Number(order.quantity)}개 주문을 확인해 주세요.`,
    { kind: "order", orderId: order.id, status: "paid" },
  )
}

async function encryptedTossPayoutRequest(
  path: string,
  body: Record<string, unknown> | Record<string, unknown>[],
  idempotencyKey: string,
) {
  if (PAYOUT_MODE !== "toss" || !TOSS_PAYOUT_SECRET_KEY || !TOSS_PAYOUT_SECURITY_KEY)
    throw Object.assign(new Error("지급대행 계약 키가 설정되지 않았습니다."), {
      status: 503,
    })
  const key = bytesFromHex(TOSS_PAYOUT_SECURITY_KEY)
  const protectedHeader = {
    alg: "dir",
    enc: "A256GCM",
    iat: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  }
  const encrypted = await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(body)),
  )
    .setProtectedHeader(protectedHeader)
    .encrypt(key)
  const response = await fetch(`https://api.tosspayments.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${TOSS_PAYOUT_SECRET_KEY}:`)}`,
      "Content-Type": "text/plain",
      "TossPayments-api-security-mode": "ENCRYPTION",
      "Idempotency-Key": idempotencyKey,
    },
    body: encrypted,
  })
  const encryptedResult = await response.text()
  let result: Record<string, any> = {}
  try {
    const decrypted = await compactDecrypt(encryptedResult, key)
    result = JSON.parse(new TextDecoder().decode(decrypted.plaintext))
  } catch {
    throw Object.assign(new Error("지급대행 응답을 검증하지 못했습니다."), {
      status: 502,
    })
  }
  if (!response.ok)
    throw Object.assign(new Error(result?.message || "지급대행 요청이 실패했습니다."), {
      status: response.status >= 500 ? 502 : 400,
      provider: result,
    })
  return result
}

async function tossPayoutAvailableAmount() {
  if (PAYOUT_MODE !== "toss" || !TOSS_PAYOUT_SECRET_KEY)
    throw Object.assign(new Error("지급대행 계약 키가 설정되지 않았습니다."), {
      status: 503,
    })
  const response = await fetch("https://api.tosspayments.com/v2/balances", {
    headers: {
      Authorization: `Basic ${btoa(`${TOSS_PAYOUT_SECRET_KEY}:`)}`,
      Accept: "application/json",
    },
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok)
    throw Object.assign(new Error(result?.message || "지급 가능 잔액을 확인하지 못했습니다."), {
      status: response.status >= 500 ? 502 : 400,
      provider: result,
    })
  const balance = result?.entityBody || result
  const availableAmount = Number(balance?.availableAmount?.value)
  if (!Number.isSafeInteger(availableAmount) || availableAmount < 0)
    throw Object.assign(new Error("토스 지급 가능 잔액 응답을 검증하지 못했습니다."), {
      status: 502,
    })
  return availableAmount
}

function authorizedJobRequest(request: Request) {
  const supplied = request.headers.get("x-curit-job-secret") || ""
  if (!OPERATIONS_JOB_SECRET || supplied.length !== OPERATIONS_JOB_SECRET.length) return false
  let mismatch = 0
  for (let index = 0; index < supplied.length; index++)
    mismatch |= supplied.charCodeAt(index) ^ OPERATIONS_JOB_SECRET.charCodeAt(index)
  return mismatch === 0
}

async function insertPending(body: Record<string, unknown>, phone: string) {
  const qrToken = String(body.qrToken || "")
  const quantity = Number(body.quantity)
  const name = String(body.name || "")
    .trim()
    .slice(0, 40)
  if (
    !/^[A-Za-z0-9_-]{12,128}$/.test(qrToken) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 20 ||
    !name
  )
    throw Object.assign(new Error("입력한 주문 정보를 다시 확인해 주세요."), {
      status: 400,
    })
  const { data: listing, error } = await admin
    .from("qr_listings")
    .select("id, stock, price, sale_status, snapshot")
    .eq("qr_token_hash", await digest(qrToken))
    .maybeSingle()
  if (error) throw error
  if (!listing)
    throw Object.assign(new Error("QR에 연결된 상품을 찾을 수 없어요."), {
      status: 404,
    })
  if (listing.sale_status !== "active")
    throw Object.assign(new Error("아직 판매가 시작되지 않은 상품이에요."), {
      status: 409,
    })
  if (Number(listing.stock) < quantity)
    throw Object.assign(new Error("남은 재고보다 주문 수량이 많아요."), {
      status: 409,
    })
  const snapshot = {
    ...listing.snapshot,
    qrToken,
    saleStatus: listing.sale_status,
    product: {
      ...listing.snapshot.product,
      price: Number(listing.price),
      stock: Number(listing.stock),
    },
  }
  const id = `QR-${crypto.randomUUID()}`
  const paymentMethod =
    body.paymentMethod === "kakaopay"
      ? "카카오페이"
      : body.paymentMethod === "tosspay"
        ? "토스페이"
        : `${String(body.cardIssuer || "선택")}카드 · ${
            body.installment === "0"
              ? "일시불"
              : `${String(body.installment || "0")}개월`
          }`
  const row = {
    id,
    listing_id: listing.id,
    customer_name: name,
    customer_phone: phone,
    quantity,
    amount: Number(listing.price) * quantity,
    status: "pending",
    simulated: PAYMENT_MODE === "demo",
    payment_method: paymentMethod,
    pickup_mode: snapshot.product.pickupMode,
    pickup_date: snapshot.product.exhibitionEnd || "",
    cafe_name: snapshot.store.name,
    cafe_phone: snapshot.store.phone,
    snapshot,
    store_id: snapshot.storeId,
    request_id: snapshot.requestId,
    artwork_id: snapshot.product.artworkId,
    payment_provider: PAYMENT_MODE,
  }
  const inserted = await admin
    .from("qr_orders")
    .insert(row)
    .select("*")
    .single()
  if (inserted.error) throw inserted.error
  return { row: inserted.data as Record<string, unknown>, qrToken }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors(request) })
  const path = routePath(request)
  try {
    if (request.method === "GET" && path === "/health")
      return json(request, {
        status: "ok",
        region: FUNCTION_REGION,
        paymentMode: PAYMENT_MODE,
        webhookReady: Boolean(TOSS_WEBHOOK_SECURITY_KEY),
        expectedMidReady: Boolean(TOSS_EXPECTED_MID),
        payoutMode: PAYOUT_MODE,
        payoutReady: Boolean(TOSS_PAYOUT_SECRET_KEY && TOSS_PAYOUT_SECURITY_KEY),
      })

    if (request.method === "POST" && path === "/api/webhooks/toss") {
      const rawBody = await request.text()
      await verifyTossWebhook(request, rawBody)
      let payload: Record<string, any>
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return json(request, { message: "웹훅 본문이 올바르지 않습니다." }, 400)
      }
      const eventType = String(payload.eventType || "")
      const eventKey = payload.eventId
        ? `${eventType}:${String(payload.eventId)}`
        : `${eventType}:${await digest(rawBody)}`
      const eventInsert = await admin
        .from("toss_webhook_events")
        .insert({
          event_key: eventKey,
          event_type: eventType,
          transmission_id:
            request.headers.get("tosspayments-webhook-transmission-id") || null,
          payload,
        })
        .select("id")
        .single()
      let eventId = eventInsert.data?.id as string | undefined
      if (eventInsert.error?.code === "23505") {
        const existing = await admin
          .from("toss_webhook_events")
          .select("id, processing_status, received_at")
          .eq("event_key", eventKey)
          .single()
        if (existing.error) throw existing.error
        const retryable =
          existing.data.processing_status === "failed" ||
          (existing.data.processing_status === "processing" &&
            Date.now() - new Date(existing.data.received_at).getTime() > 30_000)
        if (!retryable)
          return json(request, { received: true, duplicate: true })
        eventId = existing.data.id
        const claimed = await admin
          .from("toss_webhook_events")
          .update({
            processing_status: "processing",
            error_message: null,
            received_at: new Date().toISOString(),
          })
          .eq("id", eventId)
        if (claimed.error) throw claimed.error
      } else if (eventInsert.error) throw eventInsert.error
      if (!eventId) throw new Error("웹훅 처리 원장을 생성하지 못했습니다.")
      try {
        const paymentData = webhookPaymentData(payload)
        if (paymentData) {
          const paymentKey = String(paymentData.paymentKey || "")
          if (!paymentKey) throw new Error("결제 키가 없는 웹훅입니다.")
          const verified = await tossPayment(paymentKey)
          const orderId = String(verified.orderId || "")
          const order = await admin
            .from("qr_orders")
            .select("id, customer_phone, payment_key, amount, status")
            .eq("id", orderId)
            .maybeSingle()
          if (order.error) throw order.error
          if (!order.data) throw new Error("웹훅 주문을 찾지 못했습니다.")
          if (
            Number(verified.totalAmount) !== Number(order.data.amount) ||
            (order.data.payment_key && order.data.payment_key !== paymentKey) ||
            (TOSS_EXPECTED_MID && String(verified.mId || "") !== TOSS_EXPECTED_MID)
          )
            throw new Error("토스 조회 결과와 주문 정보가 일치하지 않습니다.")
          const providerStatus = String(verified.status || "")
          if (providerStatus === "DONE" && order.data.status === "pending") {
            const confirmed = await admin.rpc("confirm_curit_order", {
              p_order_id: order.data.id,
              p_customer_phone: order.data.customer_phone,
              p_payment_key: paymentKey,
            })
            if (confirmed.error) throw confirmed.error
          } else if (providerStatus === "CANCELED") {
            const cancellation = lastCancellation(verified)
            const cancelled = await admin.rpc("cancel_curit_order", {
              p_order_id: order.data.id,
              p_reason: cancellation?.cancelReason || "토스 결제 상태 변경",
              p_provider_status: providerStatus,
              p_transaction_key: cancellation?.transactionKey || null,
            })
            if (cancelled.error) throw cancelled.error
          }
          const updated = await admin
            .from("qr_orders")
            .update({
              provider_status: providerStatus,
              webhook_updated_at: new Date().toISOString(),
            })
            .eq("id", order.data.id)
          if (updated.error) throw updated.error
        } else if (eventType === "CANCEL_STATUS_CHANGED") {
          const cancel = payload.data || {}
          const transactionKey = String(cancel.transactionKey || "")
          const cancellation = await admin
            .from("payment_cancellations")
            .select("id, order_id")
            .eq("provider_transaction_key", transactionKey)
            .maybeSingle()
          if (cancellation.error) throw cancellation.error
          if (!cancellation.data) throw new Error("취소 거래를 찾지 못했습니다.")
          const completed = String(cancel.cancelStatus || "") === "DONE"
          const cancellationUpdate = await admin
            .from("payment_cancellations")
            .update({
              status: completed ? "completed" : "failed",
              provider_payload: cancel,
              completed_at: completed ? new Date().toISOString() : null,
            })
            .eq("id", cancellation.data.id)
          if (cancellationUpdate.error) throw cancellationUpdate.error
          if (completed) {
            const cancelled = await admin.rpc("cancel_curit_order", {
              p_order_id: cancellation.data.order_id,
              p_reason: cancel.cancelReason || "토스 비동기 취소 완료",
              p_provider_status: "CANCELED",
              p_transaction_key: transactionKey,
            })
            if (cancelled.error) throw cancelled.error
          }
        } else if (eventType === "payout.changed") {
          const payout = payload.entityBody || {}
          const providerStatus = String(payout.status || "")
          const status =
            providerStatus === "COMPLETED"
              ? "completed"
              : providerStatus === "CANCELED"
                ? "cancelled"
                : "failed"
          const payoutResult = await admin
            .from("payout_requests")
            .update({
              provider_payout_id: payout.id || null,
              status,
              provider_error: payout.error || null,
              completed_at:
                providerStatus === "COMPLETED" ? new Date().toISOString() : null,
              updated_at: new Date().toISOString(),
            })
            .eq("ref_payout_id", String(payout.refPayoutId || ""))
            .select("settlement_entry_id")
            .maybeSingle()
          if (payoutResult.error) throw payoutResult.error
          if (payoutResult.data?.settlement_entry_id) {
            const siblings = await admin
              .from("payout_requests")
              .select("status")
              .eq("settlement_entry_id", payoutResult.data.settlement_entry_id)
            if (siblings.error) throw siblings.error
            const allCompleted =
              Boolean(siblings.data?.length) &&
              siblings.data!.every((row) => row.status === "completed")
            if (allCompleted)
              await admin
                .from("settlement_entries")
                .update({ status: "paid", paid_at: new Date().toISOString() })
                .eq("id", payoutResult.data.settlement_entry_id)
          }
        } else if (eventType === "seller.changed") {
          const seller = payload.entityBody || {}
          const sellerUpdate = await admin
            .from("payout_sellers")
            .update({
              status: seller.status,
              synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("provider_seller_id", String(seller.id || ""))
          if (sellerUpdate.error) throw sellerUpdate.error
        }
        await admin
          .from("toss_webhook_events")
          .update({
            processing_status: paymentData || ["CANCEL_STATUS_CHANGED", "payout.changed", "seller.changed"].includes(eventType)
              ? "processed"
              : "ignored",
            processed_at: new Date().toISOString(),
          })
          .eq("id", eventId)
        return json(request, { received: true })
      } catch (error) {
        await admin
          .from("toss_webhook_events")
          .update({
            processing_status: "failed",
            error_message: error instanceof Error ? error.message.slice(0, 500) : "unknown",
          })
          .eq("id", eventId)
        throw error
      }
    }

    if (request.method === "POST" && path === "/api/internal/push/receipts") {
      if (!authorizedJobRequest(request))
        return json(request, { message: "푸시 영수증 확인 권한이 없습니다." }, 401)
      const logs = await admin
        .from("push_delivery_logs")
        .select("id, push_device_id, provider_ticket_id")
        .eq("status", "accepted")
        .not("provider_ticket_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(1000)
      if (logs.error) throw logs.error
      if (!logs.data?.length) return json(request, { checked: 0 })
      const response = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: logs.data.map((row) => row.provider_ticket_id) }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error("Expo 푸시 영수증 확인이 실패했습니다."), { status: 502 })
      let checked = 0
      for (const log of logs.data) {
        const receipt = result?.data?.[log.provider_ticket_id]
        if (!receipt) continue
        checked += 1
        const errorCode = receipt.details?.error || null
        await admin
          .from("push_delivery_logs")
          .update({
            status: receipt.status === "ok" ? "delivered" : "error",
            error_code: errorCode,
            error_message: receipt.message || null,
            checked_at: new Date().toISOString(),
          })
          .eq("id", log.id)
        if (errorCode === "DeviceNotRegistered" && log.push_device_id)
          await admin
            .from("push_devices")
            .update({ active: false, updated_at: new Date().toISOString() })
            .eq("id", log.push_device_id)
      }
      return json(request, { checked })
    }

    if (request.method === "POST" && path === "/api/internal/payouts/sellers") {
      if (!authorizedJobRequest(request))
        return json(request, { message: "판매자 등록 권한이 없습니다." }, 401)
      const body = await request.json()
      if (body.confirm !== "REGISTER_SELLER")
        return json(request, { message: "판매자 등록 확인값이 필요합니다." }, 400)
      const userId = String(body.userId || "")
      const seller = body.seller as Record<string, any>
      if (!/^[0-9a-f-]{36}$/i.test(userId) || !seller || typeof seller !== "object")
        return json(request, { message: "사용자와 판매자 정보를 확인해 주세요." }, 400)
      if (!/^[A-Za-z0-9_-]{7,20}$/.test(String(seller.refSellerId || "")))
        return json(request, { message: "판매자 참조 ID 형식을 확인해 주세요." }, 400)
      if (!["INDIVIDUAL", "INDIVIDUAL_BUSINESS", "CORPORATE"].includes(String(seller.businessType)))
        return json(request, { message: "판매자 유형을 확인해 주세요." }, 400)
      if (!seller.account?.bankCode || !seller.account?.accountNumber || !seller.account?.holderName)
        return json(request, { message: "정산 계좌 정보를 확인해 주세요." }, 400)
      const profile = await admin.from("profiles").select("id").eq("id", userId).maybeSingle()
      if (profile.error) throw profile.error
      if (!profile.data) return json(request, { message: "사용자를 찾지 못했습니다." }, 404)
      const registered = await encryptedTossPayoutRequest(
        "/v2/sellers",
        {
          refSellerId: seller.refSellerId,
          businessType: seller.businessType,
          ...(seller.businessType === "INDIVIDUAL"
            ? { individual: seller.individual }
            : { company: seller.company }),
          account: seller.account,
          metadata: { curitUserId: userId },
        },
        `curit-seller-${userId}`,
      )
      const providerSeller = registered.entityBody || registered
      if (!providerSeller.id || !providerSeller.status)
        throw Object.assign(new Error("토스 판매자 응답을 확인하지 못했습니다."), { status: 502 })
      const saved = await admin
        .from("payout_sellers")
        .upsert(
          {
            user_id: userId,
            provider_seller_id: providerSeller.id,
            ref_seller_id: seller.refSellerId,
            status: providerSeller.status,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        )
        .select("user_id, ref_seller_id, status")
        .single()
      if (saved.error) throw saved.error
      return json(request, { seller: saved.data }, 201)
    }

    if (request.method === "POST" && path === "/api/internal/payouts/run") {
      if (!authorizedJobRequest(request))
        return json(request, { message: "지급 실행 권한이 없습니다." }, 401)
      const body = await request.json()
      if (body.confirm !== "EXECUTE_PAYOUT")
        return json(request, { message: "지급 실행 확인값이 필요합니다." }, 400)
      const settlementId = String(body.settlementId || "")
      if (!/^[0-9a-f-]{36}$/i.test(settlementId))
        return json(request, { message: "정산 원장 식별자를 확인해 주세요." }, 400)
      const prepared = await admin.rpc("prepare_curit_payouts", {
        p_settlement_id: settlementId,
      })
      if (prepared.error) throw prepared.error
      const rows = (prepared.data || []) as Record<string, any>[]
      if (!rows.length)
        return json(request, { message: "승인된 판매자 지급 정보를 찾지 못했습니다." }, 409)
      const sellerIds = [...new Set(rows.map((row) => String(row.seller_id)))]
      const sellers = await admin
        .from("payout_sellers")
        .select("id, provider_seller_id")
        .in("id", sellerIds)
      if (sellers.error) throw sellers.error
      const sellerMap = new Map(
        (sellers.data || []).map((row) => [String(row.id), String(row.provider_seller_id)]),
      )
      const payoutBody = rows.map((row) => ({
        refPayoutId: row.ref_payout_id,
        destination: sellerMap.get(String(row.seller_id)),
        scheduleType: "EXPRESS",
        amount: { currency: "KRW", value: Number(row.amount) },
        transactionDescription: "큐릿정산",
        metadata: { settlementId, beneficiaryType: row.beneficiary_type },
      }))
      if (payoutBody.some((row) => !row.destination))
        return json(request, { message: "토스 판매자 식별자가 누락됐습니다." }, 409)
      const requestedAmount = payoutBody.reduce(
        (sum, row) => sum + Number(row.amount.value),
        0,
      )
      const availableAmount = await tossPayoutAvailableAmount()
      if (availableAmount < requestedAmount)
        return json(
          request,
          {
            message: "토스 지급 가능 잔액이 부족합니다.",
            availableAmount,
            requestedAmount,
          },
          409,
        )
      const payoutResult = await encryptedTossPayoutRequest(
        "/v2/payouts",
        payoutBody,
        `curit-payout-${settlementId}`,
      )
      const items = Array.isArray(payoutResult?.entityBody?.items)
        ? payoutResult.entityBody.items
        : []
      for (const item of items)
        await admin
          .from("payout_requests")
          .update({
            provider_payout_id: item.id,
            status: String(item.status || "") === "COMPLETED" ? "completed" : "requested",
            requested_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("ref_payout_id", item.refPayoutId)
      await admin
        .from("settlement_entries")
        .update({ status: "ready" })
        .eq("id", settlementId)
      return json(request, { requested: items.length, settlementId })
    }

    const pushCollaborationMatch = path.match(
      /^\/api\/push\/collaborations\/([0-9a-f-]{36})$/i,
    )
    if (request.method === "POST" && pushCollaborationMatch) {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const participant = await participantCollaboration(
        user.id,
        pushCollaborationMatch[1]!,
      )
      if (!participant)
        return json(request, { message: "협업 알림 권한이 없습니다." }, 403)
      const users = await collaborationUsers(pushCollaborationMatch[1]!)
      const recipients = users.filter((id) => id && id !== user.id)
      await sendPush(
        recipients,
        "협업 상태가 변경됐어요",
        `현재 상태: ${participant.collaboration.status}`,
        { kind: "collaboration", entityId: participant.collaboration.id },
      )
      return json(request, { sent: recipients.length })
    }

    if (path === "/api/management/listings" && request.method === "GET") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const collaborationIds = await managementListingIds(user.id)
      if (!collaborationIds.length)
        return json(request, { listings: [], candidates: [] })
      const { data, error } = await admin
        .from("qr_listings")
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, view_count, snapshot",
        )
        .in("collaboration_id", collaborationIds)
        .order("updated_at", { ascending: false })
      if (error) throw error
      const collaborations = await admin
        .from("collaborations")
        .select("id, project_id, status")
        .in("id", collaborationIds)
        .in("status", ["approved", "active"])
      if (collaborations.error) throw collaborations.error
      const projectIds = [
        ...new Set(
          (collaborations.data || []).map((row) => String(row.project_id)),
        ),
      ]
      const items = projectIds.length
        ? await admin
            .from("project_items")
            .select("id, project_id, name, price, stock, image_path, item_type")
            .in("project_id", projectIds)
            .eq("sale_mode", "display_sale")
        : { data: [], error: null }
      if (items.error) throw items.error
      const issued = new Set(
        (data || []).map(
          (row) => `${row.collaboration_id}:${row.project_item_id}`,
        ),
      )
      const candidates = (collaborations.data || []).flatMap((collaboration) =>
        (items.data || [])
          .filter(
            (item) =>
              item.project_id === collaboration.project_id &&
              !issued.has(`${collaboration.id}:${item.id}`),
          )
          .map((item) => ({
            id: `candidate-${collaboration.id}-${item.id}`,
            token: "",
            productItemId: item.id,
            collaborationId: collaboration.id,
            name: item.name,
            artistName: "",
            imageUrl: item.image_path
              ? admin.storage.from("curit-media").getPublicUrl(item.image_path)
                  .data.publicUrl
              : "",
            price: Number(item.price),
            stock: Number(item.stock),
            viewCount: 0,
            status: "PAUSED",
            pickupMode:
              item.item_type === "artwork" ? "exhibition" : "immediate",
            qrUrl: "",
            issuable: true,
          })),
      )
      return json(request, {
        listings: (data || []).map(managedListing),
        candidates,
      })
    }

    if (path === "/api/management/listings" && request.method === "POST") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const body = await request.json()
      const collaborationId = String(body.collaborationId || "")
      const projectItemId = String(body.projectItemId || "")
      if (
        !/^[0-9a-f-]{36}$/i.test(collaborationId) ||
        !/^[0-9a-f-]{36}$/i.test(projectItemId)
      )
        return json(
          request,
          { message: "협업과 상품 정보를 확인해 주세요." },
          400,
        )
      const participant = await participantCollaboration(
        user.id,
        collaborationId,
      )
      if (!participant)
        return json(
          request,
          { message: "이 협업의 QR을 발급할 권한이 없습니다." },
          403,
        )
      if (participant.store.owner_id !== user.id)
        return json(
          request,
          { message: "매장 운영자만 QR을 발급할 수 있습니다." },
          403,
        )
      if (!["approved", "active"].includes(participant.collaboration.status))
        return json(
          request,
          { message: "양측 승인이 끝난 협업만 QR을 발급할 수 있습니다." },
          409,
        )
      const item = await admin
        .from("project_items")
        .select(
          "id, project_id, name, description, item_type, sale_mode, price, stock, image_path, material",
        )
        .eq("id", projectItemId)
        .maybeSingle()
      if (item.error) throw item.error
      if (
        !item.data ||
        item.data.project_id !== participant.collaboration.project_id
      )
        return json(
          request,
          { message: "협업 프로젝트에 포함된 상품이 아닙니다." },
          400,
        )
      if (item.data.sale_mode !== "display_sale")
        return json(
          request,
          { message: "전시·판매 상품만 구매 QR을 발급할 수 있습니다." },
          409,
        )
      const existing = await admin
        .from("qr_listings")
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, view_count, snapshot",
        )
        .eq("collaboration_id", collaborationId)
        .eq("project_item_id", projectItemId)
        .maybeSingle()
      if (existing.error) throw existing.error
      if (existing.data)
        return json(
          request,
          managedListing(existing.data as Record<string, unknown>),
        )

      const project = await admin
        .from("projects")
        .select("id, title, story, concept, creator_id")
        .eq("id", item.data.project_id)
        .single()
      if (project.error) throw project.error
      const creator = await admin
        .from("profiles")
        .select("display_name, handle")
        .eq("id", project.data.creator_id)
        .single()
      if (creator.error) throw creator.error
      const creatorDetail = await admin
        .from("creator_profiles")
        .select("introduction, categories, regions")
        .eq("user_id", project.data.creator_id)
        .maybeSingle()
      if (creatorDetail.error) throw creatorDetail.error
      const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`
      const imageUrl = item.data.image_path
        ? admin.storage.from("curit-media").getPublicUrl(item.data.image_path)
            .data.publicUrl
        : ""
      const exhibitionEnd = participant.collaboration.ends_on || ""
      const snapshot = {
        v: 1,
        qrToken: token,
        storeId: participant.store.id,
        requestId: participant.collaboration.id,
        returnUrl: PUBLIC_WEB_URL,
        saleStatus:
          participant.collaboration.status === "active"
            ? "active"
            : "preparing",
        store: {
          name: participant.store.name,
          phone: "",
          address: participant.store.address,
          hours: "매장 운영시간 내 수령",
        },
        project: {
          title: project.data.title,
          concept: project.data.concept || project.data.story || "",
        },
        creator: {
          name: creator.data.display_name,
          handle: creator.data.handle || "",
          introduction: creatorDetail.data?.introduction || "",
          description: creatorDetail.data?.introduction || "",
          categories: creatorDetail.data?.categories || [],
          regions: creatorDetail.data?.regions || [],
        },
        product: {
          artworkId: item.data.id,
          name: item.data.name,
          artist: creator.data.display_name,
          price: Number(item.data.price),
          stock: Number(item.data.stock),
          image: imageUrl,
          description: item.data.description || "",
          composition: item.data.material || "",
          care: "작품별 안내와 매장 수령 조건을 확인해 주세요.",
          pickupMode:
            item.data.item_type === "artwork" ? "exhibition" : "immediate",
          exhibitionEnd,
        },
      }
      const inserted = await admin
        .from("qr_listings")
        .insert({
          id: crypto.randomUUID(),
          qr_token_hash: await digest(token),
          qr_token_value: token,
          token_hint: token.slice(-12),
          project_item_id: projectItemId,
          collaboration_id: collaborationId,
          sale_status: snapshot.saleStatus,
          price: Number(item.data.price),
          stock: Number(item.data.stock),
          snapshot,
        })
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, view_count, snapshot",
        )
        .single()
      if (inserted.error) throw inserted.error
      return json(
        request,
        managedListing(inserted.data as Record<string, unknown>),
        201,
      )
    }

    const managedMatch = path.match(
      /^\/api\/management\/listings\/([0-9a-f-]{36})$/i,
    )
    if (managedMatch && request.method === "PATCH") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const listing = await admin
        .from("qr_listings")
        .select("id, collaboration_id, snapshot")
        .eq("id", managedMatch[1]!)
        .maybeSingle()
      if (listing.error) throw listing.error
      if (!listing.data?.collaboration_id)
        return json(request, { message: "QR 상품을 찾지 못했습니다." }, 404)
      const participant = await participantCollaboration(
        user.id,
        listing.data.collaboration_id,
      )
      if (!participant)
        return json(
          request,
          { message: "이 상품을 수정할 권한이 없습니다." },
          403,
        )
      if (participant.store.owner_id !== user.id)
        return json(
          request,
          { message: "매장 운영자만 QR 판매 설정을 변경할 수 있습니다." },
          403,
        )
      const body = await request.json()
      const updates: Record<string, unknown> = {}
      if (body.stock !== undefined) {
        const stock = Number(body.stock)
        if (!Number.isSafeInteger(stock) || stock < 0 || stock > 100000)
          return json(request, { message: "재고 수량을 확인해 주세요." }, 400)
        updates.stock = stock
      }
      if (body.price !== undefined) {
        const price = Number(body.price)
        if (!Number.isSafeInteger(price) || price < 100 || price > 100000000)
          return json(request, { message: "판매 가격을 확인해 주세요." }, 400)
        updates.price = price
      }
      if (body.pickupMode !== undefined) {
        if (!["immediate", "exhibition"].includes(body.pickupMode))
          return json(request, { message: "수령 방식을 확인해 주세요." }, 400)
      }
      if (body.saleStatus !== undefined) {
        if (!["active", "preparing"].includes(body.saleStatus))
          return json(request, { message: "판매 상태를 확인해 주세요." }, 400)
        if (
          body.saleStatus === "active" &&
          participant.collaboration.status !== "active"
        )
          return json(
            request,
            { message: "운영 중인 협업만 판매를 시작할 수 있습니다." },
            409,
          )
        updates.sale_status = body.saleStatus
      }
      if (!Object.keys(updates).length)
        if (body.pickupMode === undefined)
          return json(request, { message: "변경할 값을 입력해 주세요." }, 400)
      if (body.price !== undefined || body.pickupMode !== undefined) {
        const snapshot = listing.data.snapshot as Record<string, any>
        updates.snapshot = {
          ...snapshot,
          product: {
            ...snapshot.product,
            ...(body.price !== undefined ? { price: Number(body.price) } : {}),
            ...(body.pickupMode !== undefined
              ? { pickupMode: body.pickupMode }
              : {}),
          },
        }
      }
      updates.updated_at = new Date().toISOString()
      const updated = await admin
        .from("qr_listings")
        .update(updates)
        .eq("id", listing.data.id)
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, view_count, snapshot",
        )
        .single()
      if (updated.error) throw updated.error
      return json(
        request,
        managedListing(updated.data as Record<string, unknown>),
      )
    }

    if (path === "/api/management/orders" && request.method === "GET") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const collaborationIds = await storeOwnerCollaborationIds(user.id)
      if (collaborationIds === null)
        return json(
          request,
          { message: "매장 운영자만 주문을 확인할 수 있습니다." },
          403,
        )
      if (!collaborationIds.length) return json(request, { orders: [] })
      const listings = await admin
        .from("qr_listings")
        .select("id, collaboration_id")
        .in("collaboration_id", collaborationIds)
      if (listings.error) throw listings.error
      const listingIds = (listings.data || []).map((row) => String(row.id))
      if (!listingIds.length) return json(request, { orders: [] })
      const orders = await admin
        .from("qr_orders")
        .select(
          "id, listing_id, customer_name, customer_phone, quantity, amount, status, payment_method, pickup_mode, pickup_date, snapshot, fulfillment_status, delivered_at, created_at",
        )
        .in("listing_id", listingIds)
        .eq("status", "paid")
        .order("created_at", { ascending: false })
      if (orders.error) throw orders.error
      return json(request, {
        orders: (orders.data || []).map((row) => ({
          id: row.id,
          listingId: row.listing_id,
          productName:
            (row.snapshot as Record<string, any>)?.product?.name || "등록 상품",
          imageUrl:
            (row.snapshot as Record<string, any>)?.product?.image || "",
          customerName: row.customer_name,
          customerPhoneLast4: String(row.customer_phone || "").slice(-4),
          quantity: Number(row.quantity),
          amount: Number(row.amount),
          paymentMethod: row.payment_method,
          pickupMode: row.pickup_mode,
          pickupDate: row.pickup_date,
          fulfillmentStatus: row.fulfillment_status,
          deliveredAt: row.delivered_at,
          createdAt: row.created_at,
        })),
      })
    }

    const managedOrderMatch = path.match(
      /^\/api\/management\/orders\/(QR-[0-9a-f-]+)$/i,
    )
    if (managedOrderMatch && request.method === "PATCH") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const order = await admin
        .from("qr_orders")
        .select("id, listing_id, status")
        .eq("id", managedOrderMatch[1]!)
        .maybeSingle()
      if (order.error) throw order.error
      if (!order.data || order.data.status !== "paid")
        return json(request, { message: "결제 완료 주문을 찾지 못했습니다." }, 404)
      const listing = await admin
        .from("qr_listings")
        .select("collaboration_id")
        .eq("id", order.data.listing_id)
        .maybeSingle()
      if (listing.error) throw listing.error
      if (!listing.data?.collaboration_id)
        return json(request, { message: "협업 정보를 찾지 못했습니다." }, 404)
      const participant = await participantCollaboration(
        user.id,
        listing.data.collaboration_id,
      )
      if (!participant || participant.store.owner_id !== user.id)
        return json(request, { message: "매장 운영자만 수령 상태를 변경할 수 있습니다." }, 403)
      const body = await request.json()
      const next = String(body.fulfillmentStatus || "")
      if (!["awaiting_pickup", "reserved", "delivered"].includes(next))
        return json(request, { message: "수령 상태를 확인해 주세요." }, 400)
      const updated = await admin
        .from("qr_orders")
        .update({
          fulfillment_status: next,
          delivered_at: next === "delivered" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.data.id)
        .select("id, fulfillment_status, delivered_at")
        .single()
      if (updated.error) throw updated.error
      return json(request, {
        id: updated.data.id,
        fulfillmentStatus: updated.data.fulfillment_status,
        deliveredAt: updated.data.delivered_at,
      })
    }

    const cancelOrderMatch = path.match(
      /^\/api\/management\/orders\/(QR-[0-9a-f-]+)\/cancel$/i,
    )
    if (cancelOrderMatch && request.method === "POST") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const order = await admin
        .from("qr_orders")
        .select(
          "id, listing_id, status, payment_key, payment_provider, simulated, amount, quantity, fulfillment_status",
        )
        .eq("id", cancelOrderMatch[1]!)
        .maybeSingle()
      if (order.error) throw order.error
      if (!order.data)
        return json(request, { message: "주문을 찾지 못했습니다." }, 404)
      if (order.data.status === "cancelled")
        return json(request, { id: order.data.id, status: "cancelled", duplicate: true })
      if (order.data.status !== "paid")
        return json(request, { message: "결제 완료 주문만 취소할 수 있습니다." }, 409)
      if (order.data.fulfillment_status === "delivered")
        return json(request, { message: "이미 전달한 상품은 앱에서 취소할 수 없습니다." }, 409)
      const listing = await admin
        .from("qr_listings")
        .select("collaboration_id")
        .eq("id", order.data.listing_id)
        .maybeSingle()
      if (listing.error) throw listing.error
      if (!listing.data?.collaboration_id)
        return json(request, { message: "협업 정보를 찾지 못했습니다." }, 404)
      const participant = await participantCollaboration(
        user.id,
        listing.data.collaboration_id,
      )
      if (!participant || participant.store.owner_id !== user.id)
        return json(request, { message: "매장 운영자만 결제를 취소할 수 있습니다." }, 403)
      const settlement = await admin
        .from("settlement_entries")
        .select("status")
        .eq("order_id", order.data.id)
        .maybeSingle()
      if (settlement.error) throw settlement.error
      if (settlement.data?.status === "paid")
        return json(request, { message: "이미 지급된 정산 건은 운영팀 확인이 필요합니다." }, 409)
      const body = await request.json().catch(() => ({}))
      const reason = String(body.reason || "매장 운영자 요청")
        .trim()
        .slice(0, 200)
      if (!reason)
        return json(request, { message: "취소 사유를 입력해 주세요." }, 400)

      let providerStatus = "CANCELED"
      let transactionKey: string | null = null
      let providerPayload: Record<string, any> = { mode: "demo" }
      if (!order.data.simulated && order.data.payment_provider === "toss") {
        if (!TOSS_SECRET_KEY || !order.data.payment_key)
          return json(request, { message: "토스 결제 취소 설정을 확인해 주세요." }, 503)
        providerPayload = await toss(
          `/${encodeURIComponent(order.data.payment_key)}/cancel`,
          { cancelReason: reason, cancelRequestId: `cancel-${order.data.id}` },
          `cancel-${order.data.id}`,
        )
        providerStatus = String(providerPayload.status || "")
        const cancellation = lastCancellation(providerPayload)
        transactionKey = cancellation?.transactionKey || null
        await admin.from("payment_cancellations").upsert(
          {
            order_id: order.data.id,
            provider_transaction_key: transactionKey,
            provider_cancel_request_id: `cancel-${order.data.id}`,
            amount: Number(order.data.amount),
            reason,
            status:
              providerStatus === "CANCELED" || cancellation?.cancelStatus === "DONE"
                ? "completed"
                : "in_progress",
            provider_payload: providerPayload,
            completed_at:
              providerStatus === "CANCELED" || cancellation?.cancelStatus === "DONE"
                ? new Date().toISOString()
                : null,
          },
          { onConflict: "order_id" },
        )
        if (providerStatus !== "CANCELED" && cancellation?.cancelStatus !== "DONE")
          return json(request, {
            id: order.data.id,
            status: "cancellation_pending",
            message: "취소 승인 결과를 기다리고 있습니다.",
          }, 202)
      }
      const cancelled = await admin.rpc("cancel_curit_order", {
        p_order_id: order.data.id,
        p_reason: reason,
        p_provider_status: providerStatus,
        p_transaction_key: transactionKey,
      })
      if (cancelled.error) throw cancelled.error
      const users = await collaborationUsers(listing.data.collaboration_id)
      await sendPush(
        users,
        "결제 취소가 완료됐어요",
        `주문 ${order.data.id.slice(-8)}의 재고와 정산 내역이 갱신됐습니다.`,
        { kind: "order", orderId: order.data.id, status: "cancelled" },
      )
      return json(request, {
        id: order.data.id,
        status: "cancelled",
        amount: Number(order.data.amount),
      })
    }

    const qrMatch = path.match(/^\/api\/v1\/qr\/([^/]+)$/)
    if (request.method === "GET" && qrMatch) {
      const token = decodeURIComponent(qrMatch[1]!)
      if (!/^[A-Za-z0-9_-]{12,128}$/.test(token))
        return json(request, { message: "구매 링크를 확인해 주세요." }, 404)
      const { data, error } = await admin
        .from("qr_listings")
        .select("id, stock, price, sale_status, snapshot")
        .eq("qr_token_hash", await digest(token))
        .maybeSingle()
      if (error) throw error
      if (!data)
        return json(
          request,
          { message: "QR에 연결된 상품을 찾을 수 없어요." },
          404,
        )
      const visitorId = request.headers.get("x-curit-visitor-id") || ""
      if (/^[A-Za-z0-9_-]{16,128}$/.test(visitorId)) {
        const viewedOn = new Date(Date.now() + 9 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10)
        const view = await admin.from("qr_view_events").upsert(
          {
            listing_id: data.id,
            visitor_hash: await digest(visitorId),
            viewed_on: viewedOn,
          },
          {
            onConflict: "listing_id,visitor_hash,viewed_on",
            ignoreDuplicates: true,
          },
        )
        if (view.error)
          console.warn("QR view analytics failed", view.error.message)
      }
      return json(request, {
        ...data.snapshot,
        qrToken: token,
        saleStatus: data.sale_status,
        product: {
          ...data.snapshot.product,
          price: Number(data.price),
          stock: Number(data.stock),
        },
      })
    }

    if (request.method === "POST" && path === "/api/auth/identity/start") {
      const body = await request.json()
      const phone = String(body.phone || "")
      if (!/^01[016789]\d{7,8}$/.test(phone) || body.consent !== true)
        return json(
          request,
          { message: "휴대폰 번호와 동의를 확인해 주세요." },
          400,
        )
      const token =
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "")
      const maxAge = body.remember === true ? 30 * 86400 : 86400
      const { error } = await admin.from("customer_sessions").upsert({
        token_hash: await digest(token),
        customer_phone: phone,
        expires_at: new Date(Date.now() + maxAge * 1000).toISOString(),
      })
      if (error) throw error
      return json(request, {
        verified: true,
        phone,
        accessToken: token,
        expiresIn: maxAge,
        simulated: true,
      })
    }

    if (request.method === "GET" && path === "/api/auth/session") {
      const phone = await phoneFor(request)
      return json(
        request,
        phone ? { verified: true, phone } : { verified: false },
      )
    }

    const phone = await phoneFor(request)
    if (!phone)
      return json(
        request,
        { message: "휴대폰 번호를 다시 확인해 주세요." },
        401,
      )

    if (request.method === "GET" && path === "/api/orders") {
      const { data, error } = await admin
        .from("qr_orders")
        .select("*")
        .eq("customer_phone", phone)
        .eq("status", "paid")
        .order("created_at", { ascending: false })
      if (error) throw error
      return json(request, { orders: (data || []).map(orderResponse) })
    }
    const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/)
    if (request.method === "GET" && orderMatch) {
      const { data } = await admin
        .from("qr_orders")
        .select("*")
        .eq("id", decodeURIComponent(orderMatch[1]!))
        .eq("customer_phone", phone)
        .eq("status", "paid")
        .maybeSingle()
      return data
        ? json(request, orderResponse(data))
        : json(request, { message: "주문 내역을 찾지 못했어요." }, 404)
    }

    if (request.method === "POST" && path === "/api/checkout") {
      const body = await request.json()
      const { row, qrToken } = await insertPending(body, phone)
      if (PAYMENT_MODE === "toss") {
        if (!TOSS_CLIENT_KEY || !TOSS_SECRET_KEY)
          return json(
            request,
            { message: "결제 상점 키가 설정되지 않았습니다." },
            503,
          )
        const successUrl = qrWebUrl(qrToken)
        successUrl.searchParams.set("payment", "success")
        const failUrl = qrWebUrl(qrToken)
        failUrl.searchParams.set("payment", "fail")
        const pendingSnapshot = row.snapshot as { product?: { name?: string } }
        return json(request, {
          simulated: false,
          payment: {
            provider: "toss",
            clientKey: TOSS_CLIENT_KEY,
            customerKey: "ANONYMOUS",
            orderId: row.id,
            amount: Number(row.amount),
            orderName: pendingSnapshot.product?.name || "CURI:T 작품·굿즈",
            customerName: row.customer_name,
            successUrl: successUrl.href,
            failUrl: failUrl.href,
          },
        })
      }
      const confirmed = await admin.rpc("confirm_curit_order", {
        p_order_id: row.id,
        p_customer_phone: phone,
        p_payment_key: "demo",
      })
      if (confirmed.error) throw confirmed.error
      const paid = Array.isArray(confirmed.data)
        ? confirmed.data[0]
        : confirmed.data
      if (paid) await sendOrderPaidPush(paid as Record<string, any>)
      const destination = qrWebUrl(qrToken)
      destination.searchParams.set("order", String(row.id))
      return json(request, { checkoutUrl: destination.href, simulated: true })
    }

    const abandonedCheckoutMatch = path.match(
      /^\/api\/checkout\/([^/]+)\/abandon$/,
    )
    if (request.method === "POST" && abandonedCheckoutMatch) {
      const orderId = decodeURIComponent(abandonedCheckoutMatch[1]!)
      const { error } = await admin
        .from("qr_orders")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .eq("customer_phone", phone)
        .eq("status", "pending")
      if (error) throw error
      return json(request, { abandoned: true })
    }

    if (request.method === "POST" && path === "/api/payments/confirm") {
      if (PAYMENT_MODE !== "toss")
        return json(request, { message: "현재 테스트 결제 모드입니다." }, 409)
      const body = await request.json()
      const orderId = String(body.orderId || "")
      const paymentKey = String(body.paymentKey || "")
      const amount = Number(body.amount)
      const { data: pending } = await admin
        .from("qr_orders")
        .select("*")
        .eq("id", orderId)
        .eq("customer_phone", phone)
        .maybeSingle()
      if (!pending)
        return json(request, { message: "주문 내역을 찾지 못했어요." }, 404)
      if (pending.status === "paid")
        return json(request, orderResponse(pending))
      if (pending.status !== "pending" || Number(pending.amount) !== amount)
        return json(
          request,
          { message: "결제 금액 또는 주문 상태가 일치하지 않습니다." },
          400,
        )
      const tossPayment = await toss(
        "/confirm",
        { paymentKey, orderId, amount },
        `confirm-${orderId}`,
      )
      const confirmed = await admin.rpc("confirm_curit_order", {
        p_order_id: orderId,
        p_customer_phone: phone,
        p_payment_key: paymentKey,
      })
      if (confirmed.error) {
        await toss(
          `/${encodeURIComponent(paymentKey)}/cancel`,
          { cancelReason: "재고 또는 주문 상태 불일치로 자동 취소" },
          `cancel-${orderId}`,
        ).catch(() => undefined)
        await admin
          .from("qr_orders")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
          })
          .eq("id", orderId)
          .eq("status", "pending")
        throw confirmed.error
      }
      let paid = Array.isArray(confirmed.data)
        ? confirmed.data[0]
        : confirmed.data
      const actualPaymentMethod = tossPaymentMethod(tossPayment)
      if (
        actualPaymentMethod &&
        actualPaymentMethod !== paid?.payment_method
      ) {
        const corrected = await admin
          .from("qr_orders")
          .update({ payment_method: actualPaymentMethod })
          .eq("id", orderId)
          .eq("status", "paid")
          .select("*")
          .single()
        if (corrected.error) console.error(corrected.error)
        else paid = corrected.data
      }
      await sendOrderPaidPush(paid as Record<string, any>)
      return json(request, orderResponse(paid as Record<string, unknown>))
    }

    return json(request, { message: "요청 경로를 찾지 못했습니다." }, 404)
  } catch (error) {
    console.error(error)
    const status = Number((error as { status?: number }).status) || 500
    const message =
      error instanceof Error && status < 500
        ? error.message
        : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요."
    return json(request, { message }, status)
  }
})

import { createClient } from "npm:@supabase/supabase-js@2.118.0"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
const PUBLIC_WEB_URL = (
  Deno.env.get("PUBLIC_WEB_URL") || "http://localhost:5173"
).replace(/\/$/, "")
const PAYMENT_MODE = Deno.env.get("PAYMENT_MODE") === "toss" ? "toss" : "demo"
const TOSS_CLIENT_KEY = Deno.env.get("TOSS_CLIENT_KEY") || ""
const TOSS_SECRET_KEY = Deno.env.get("TOSS_SECRET_KEY") || ""
const origins = (Deno.env.get("WEB_ORIGIN") || "http://localhost:5173")
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
      "authorization, content-type, x-client-info, apikey",
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

async function phoneFor(request: Request) {
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1]
  if (!bearer) return ""
  const tokenHash = await digest(bearer)
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
    status:
      row.sale_status === "active"
        ? Number(row.stock) > 0
          ? "ACTIVE"
          : "SOLD_OUT"
        : "PAUSED",
    pickupMode: snapshot?.product?.pickupMode || "immediate",
    qrUrl: token
      ? new URL(`./q/${encodeURIComponent(token)}`, `${PUBLIC_WEB_URL}/`).href
      : "",
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
      return json(request, { status: "ok" })

    if (path === "/api/management/listings" && request.method === "GET") {
      const user = await appUserFor(request)
      if (!user) return json(request, { message: "로그인이 필요합니다." }, 401)
      const collaborationIds = await managementListingIds(user.id)
      if (!collaborationIds.length)
        return json(request, { listings: [], candidates: [] })
      const { data, error } = await admin
        .from("qr_listings")
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, snapshot",
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
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, snapshot",
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
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, snapshot",
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
        .select("id, collaboration_id")
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
      const body = await request.json()
      const updates: Record<string, unknown> = {}
      if (body.stock !== undefined) {
        const stock = Number(body.stock)
        if (!Number.isSafeInteger(stock) || stock < 0 || stock > 100000)
          return json(request, { message: "재고 수량을 확인해 주세요." }, 400)
        updates.stock = stock
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
        return json(request, { message: "변경할 값을 입력해 주세요." }, 400)
      updates.updated_at = new Date().toISOString()
      const updated = await admin
        .from("qr_listings")
        .update(updates)
        .eq("id", listing.data.id)
        .select(
          "id, qr_token_value, token_hint, project_item_id, collaboration_id, sale_status, price, stock, snapshot",
        )
        .single()
      if (updated.error) throw updated.error
      return json(
        request,
        managedListing(updated.data as Record<string, unknown>),
      )
    }

    const qrMatch = path.match(/^\/api\/v1\/qr\/([^/]+)$/)
    if (request.method === "GET" && qrMatch) {
      const token = decodeURIComponent(qrMatch[1]!)
      if (!/^[A-Za-z0-9_-]{12,128}$/.test(token))
        return json(request, { message: "구매 링크를 확인해 주세요." }, 404)
      const { data } = await admin
        .from("qr_listings")
        .select("stock, price, sale_status, snapshot")
        .eq("qr_token_hash", await digest(token))
        .maybeSingle()
      if (!data)
        return json(
          request,
          { message: "QR에 연결된 상품을 찾을 수 없어요." },
          404,
        )
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
        const successUrl = new URL(
          `./q/${encodeURIComponent(qrToken)}`,
          `${PUBLIC_WEB_URL}/`,
        )
        successUrl.searchParams.set("payment", "success")
        const failUrl = new URL(
          `./q/${encodeURIComponent(qrToken)}`,
          `${PUBLIC_WEB_URL}/`,
        )
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
      const destination = new URL(
        `./q/${encodeURIComponent(qrToken)}`,
        `${PUBLIC_WEB_URL}/`,
      )
      destination.searchParams.set("order", String(row.id))
      return json(request, { checkoutUrl: destination.href, simulated: true })
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
      await toss(
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
      const paid = Array.isArray(confirmed.data)
        ? confirmed.data[0]
        : confirmed.data
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

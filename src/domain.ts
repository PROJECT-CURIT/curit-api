export type PickupMode = "immediate" | "exhibition"
export type SaleStatus = "preparing" | "active"

export type QrSnapshot = {
  v: 1
  qrToken: string
  storeId: string
  requestId: string
  returnUrl: string
  saleStatus: SaleStatus
  store: {
    name: string
    phone: string
    address: string
    hours: string
  }
  project?: { title: string; concept: string }
  creator?: {
    name: string
    handle: string
    introduction: string
    description: string
    categories: string[]
    regions: string[]
  }
  product: {
    artworkId: string
    projectId?: number
    goodsIndex?: number
    name: string
    artist: string
    price: number
    stock: number
    image: string
    description: string
    composition: string
    care: string
    pickupMode: PickupMode
    exhibitionEnd: string
  }
}

export type Order = {
  v: 1
  id: string
  status: "paid"
  simulated: boolean
  artworkId: string
  quantity: number
  amount: number
  paymentMethod: string
  pickupMode: PickupMode
  pickupDate: string
  cafeName: string
  cafePhone: string
  snapshot: QrSnapshot
  storeId: string
  requestId: string
  customerLabel: string
}

export type CreateOrderInput = {
  qrToken: string
  quantity: number
  customerName: string
  customerPhone: string
  paymentMethod: string
  simulated: boolean
}

export interface CommerceStore {
  getListing(qrToken: string): Promise<QrSnapshot | null>
  createSession(token: string, customerPhone: string, expiresAt: Date): Promise<void>
  getSessionPhone(token: string): Promise<string | null>
  createOrder(input: CreateOrderInput): Promise<Order>
  listOrders(customerPhone: string): Promise<Order[]>
  getOrder(orderId: string, customerPhone: string): Promise<Order | null>
  close(): Promise<void>
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message)
  }
}

import type { QrSnapshot } from "./domain.js"

export type SeedListing = {
  token: string
  snapshot: QrSnapshot
}

const common = {
  v: 1 as const,
  storeId: "store-anukhan-seoul",
  requestId: "exhibition-heuk-memory-2026-10",
  returnUrl: "http://localhost:5173",
  saleStatus: "active" as const,
  store: {
    name: "아늑한 서울",
    phone: "02-123-4567",
    address: "서울 성동구 성수동",
    hours: "매일 10:00–21:00",
  },
  project: {
    title: "흙의 기억",
    concept:
      "제주 흙과 자연의 색을 담아, 매일 쓰는 그릇에 손으로 만든 온기를 남깁니다.",
  },
  creator: {
    name: "김서연",
    handle: "@soyeon_craft",
    introduction: "제주 자연에서 영감을 받은 도예 작가",
    description: "조금씩 다른 손자국과 유약의 흐름을 작품의 일부로 남깁니다.",
    categories: ["도예", "세라믹", "생활공예"],
    regions: ["제주", "서울"],
  },
}

export const seedListings: SeedListing[] = [
  {
    token: "demo-mug-white-gray",
    snapshot: {
      ...common,
      qrToken: "demo-mug-white-gray",
      product: {
        artworkId: "0-0",
        projectId: 0,
        goodsIndex: 0,
        name: "머그컵 (화이트·그레이)",
        artist: "김서연",
        price: 35000,
        stock: 12,
        image: "/artworks/reference-1.jpg",
        description: "손으로 빚어 각기 다른 결을 지닌 세라믹 머그컵입니다.",
        composition: "세라믹 머그컵 1개",
        care: "전자레인지 사용 가능 · 식기세척기보다 손세척을 권장합니다.",
        pickupMode: "immediate",
        exhibitionEnd: "",
      },
    },
  },
  {
    token: "demo-bowl-set-2026",
    snapshot: {
      ...common,
      requestId: "exhibition-heuk-memory-bowl-2026-10",
      qrToken: "demo-bowl-set-2026",
      product: {
        artworkId: "0-1",
        projectId: 0,
        goodsIndex: 1,
        name: "볼 세트 (2개)",
        artist: "김서연",
        price: 82000,
        stock: 6,
        image: "/artworks/bowl-set.jpg",
        description:
          "밥과 국, 디저트까지 편안하게 담을 수 있는 2인 볼 세트입니다.",
        composition: "세라믹 볼 2개",
        care: "급격한 온도 변화와 강한 충격을 피해주세요.",
        pickupMode: "immediate",
        exhibitionEnd: "",
      },
    },
  },
  {
    token: "demo-dessert-plate",
    snapshot: {
      ...common,
      requestId: "exhibition-heuk-memory-plate-2026-10",
      qrToken: "demo-dessert-plate",
      product: {
        artworkId: "0-2",
        projectId: 0,
        goodsIndex: 2,
        name: "제주빛 디저트 플레이트",
        artist: "김서연",
        price: 55000,
        stock: 8,
        image: "/artworks/dessert-plate.jpg",
        description: "제주의 모래빛을 담은 작은 디저트 플레이트입니다.",
        composition: "세라믹 플레이트 1개",
        care: "사용 전 세척하고, 표면을 긁는 금속 수세미는 피해주세요.",
        pickupMode: "exhibition",
        exhibitionEnd: "2026-12-31",
      },
    },
  },
]

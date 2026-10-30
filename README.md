# CURI:T API

QR 웹과 향후 모바일 앱이 함께 사용하는 작품 전시·재고·주문 API입니다. 상품별 QR 토큰을 서버 데이터에 연결하고, 주문 금액과 재고를 클라이언트가 아닌 서버에서 확정합니다.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
pnpm dev
```

`DATABASE_URL`이 비어 있으면 세 가지 데모 상품을 가진 메모리 저장소로 실행됩니다. 프로세스를 재시작하면 주문이 초기화되므로 시연·개발에만 사용해야 합니다.

## PostgreSQL 실행

Supabase 등 PostgreSQL 프로젝트를 준비한 뒤 `.env`에 `DATABASE_URL`을 입력합니다.

```bash
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Supabase의 서버리스 transaction pooler를 사용하면 prepared statement를 끄는 설정이 필요합니다. 현재 API는 장기 실행 서버 연결을 기준으로 하므로 direct/session 연결을 권장합니다.

## 상품별 QR 생성

```bash
pnpm qr:generate -- --base-url https://qr.curit.example --output generated-qr
```

데모용 토큰은 읽기 쉽지만 운영용 토큰은 충분히 긴 난수로 발급합니다. 공개 조회에는 SHA-256 해시를 사용하고, 매장 앱에서 QR을 다시 열 수 있도록 원문은 RLS로 직접 접근을 차단한 서버 전용 열에만 보관합니다.

## 검증

```bash
pnpm typecheck
pnpm test
pnpm build
```

테스트는 다음을 확인합니다.

- 서로 다른 QR이 서로 다른 상품으로 연결됨
- 클라이언트가 가격을 위조해도 서버 가격으로 주문됨
- 실시간 재고보다 많은 주문은 거절됨

## 운영 구조

- 앱 인증·사용자 데이터·이미지: Supabase Auth, PostgreSQL RLS, Storage
- QR 공개 상품·주문: Fastify API 또는 `supabase/functions/commerce`
- 결제: 토스페이먼츠 SDK v2 요청 → 서버 승인 → 재고 원자적 차감
- 정산: 결제 승인과 같은 트랜잭션에서 참여자별 정산 원장 생성
- 상품별 QR: 승인된 협업의 전시·판매 상품만 앱에서 발급하며, 매장·작가 본인 JWT를 서버에서 다시 검증

`PAYMENT_MODE=toss`에서는 `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`가 모두 있어야 서버가 시작됩니다. 시크릿 키는 서버나 Edge Function secret에만 저장합니다. `demo` 모드는 실제 과금 없이 같은 주문·재고 흐름을 검증합니다.

`supabase/functions/commerce`는 방문객 주문 API와 인증 사용자용 `/api/management/listings`를 함께 제공합니다. 앱은 Supabase access token을 보내고, 함수가 협업 참여자 여부를 확인한 뒤 상품별 QR 발급·조회·재고 상태 변경을 처리합니다.

## 운영 전 남은 외부 준비

1. 토스페이먼츠 상점 계약·테스트/라이브 키 발급과 카드사 심사
2. 결제 취소·부분취소·웹훅 대사 정책 확정
3. 개인정보 처리방침, 전자상거래 고지, 환불·교환 책임 주체 확정
4. 실제 판매자 정산을 위한 사업자·세무·지급 계좌 확인 절차
5. 운영 로그에서 휴대폰 번호·결제키 마스킹과 장애 알림 연결

API 계약은 [OpenAPI 문서](docs/openapi.yaml), 설계 판단은 [아키텍처 문서](docs/architecture.md), 남은 사업·운영 준비는 [개발·PoC 체크리스트](docs/launch-checklist.md)를 참고하세요.

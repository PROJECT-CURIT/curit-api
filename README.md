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

데모용 토큰은 읽기 쉽지만 운영용 토큰은 `createQrToken()`으로 24바이트 난수를 생성해야 합니다. DB에는 토큰 원문 대신 SHA-256 해시를 저장합니다.

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

## 운영 전 필수 작업

1. `PAYMENT_MODE=toss` 전환과 토스페이먼츠 v2 주문서형 결제의 서버 승인 구현
2. 결제 승인 전 `pending`, 승인 후 `paid` 상태 전이와 실패·취소·부분취소 처리
3. 결제 웹훅 서명 검증과 중복 승인 방지
4. NICE/KCB 등 실제 본인확인이 필요한지 검토. 단순 주문 연락처라면 불필요한 본인인증을 제거
5. 개인정보 처리방침, 전자상거래 고지, 환불·교환 책임 주체 확정
6. 이미지 저장소, 관리자 권한, QR 재발급·폐기 이력 추가
7. 운영 로그에서 휴대폰 번호·결제키 마스킹

API 계약은 [OpenAPI 문서](docs/openapi.yaml), 설계 판단은 [아키텍처 문서](docs/architecture.md), 남은 사업·운영 준비는 [개발·PoC 체크리스트](docs/launch-checklist.md)를 참고하세요.

# CURI:T 결제·푸시 운영 체크리스트

## 결제 취소

- 매장 운영자는 `주문 · 현장 수령`에서 전달 전 주문만 전액 취소할 수 있다.
- 서버는 토스 취소 API가 완료된 뒤에만 주문을 취소하고 재고를 복원한다.
- 이미 지급된 정산 또는 전달 완료 주문은 자동 취소하지 않고 운영 확인 대상으로 남긴다.
- 같은 주문의 취소 요청과 웹훅을 여러 번 받아도 재고와 정산은 한 번만 변경된다.

## 토스 웹훅

운영 URL은 다음과 같다.

`https://gmfjejxtqkuviwbxpgrw.supabase.co/functions/v1/commerce/api/webhooks/toss?forceFunctionRegion=ap-northeast-2`

토스 개발자센터에서 MID별로 다음 이벤트를 등록한다.

- `PAYMENT_STATUS_CHANGED`
- `CANCEL_STATUS_CHANGED`
- 지급대행 계약 후 `payout.changed`, `seller.changed`

Edge Function secret에 같은 MID에서 발급된 `TOSS_WEBHOOK_SECURITY_KEY`와 `TOSS_EXPECTED_MID`를 등록해야 한다. 서버는 HMAC SHA-256 서명, 결제 조회 API의 `orderId`, `totalAmount`, `mId`, `status`를 모두 확인한다. URL의 `forceFunctionRegion=ap-northeast-2`는 웹훅 처리와 결제 재조회 요청을 서울 리전에서 실행하도록 고정한다.

## 네이티브 푸시

- Android 배포 빌드는 EAS 프로젝트에 FCM v1 서비스 계정 키가 있어야 한다.
- iOS 실기기 배포는 Apple Developer 계정과 APNs 자격증명이 있어야 한다.
- 로그인한 기기의 Expo Push Token은 `push_devices`에 저장되고 로그아웃 시 비활성화된다.
- `DeviceNotRegistered` 응답을 받은 토큰은 서버에서 자동 비활성화한다.
- 스케줄러는 `POST /api/internal/push/receipts`를 호출해 Expo 전송 영수증을 회수한다. 이 요청에는 `x-curit-job-secret`이 필요하다.

## 판매대금 지급

지급대행은 기본값이 `PAYOUT_MODE=disabled`다. 다음 조건을 모두 충족하기 전에는 활성화하지 않는다.

1. 토스 지급대행 별도 계약 완료
2. API 개별 시크릿 키와 64자 보안 키 발급
3. 판매자의 토스 Seller 등록과 본인확인/KYC 완료
4. 지급 가능한 잔액과 운영 취소 절차 확인
5. 토스 API 키 접근 정책을 운영 환경에 맞게 설정

Supabase Edge Function은 고정된 아웃바운드 IP를 제공하지 않는다. 따라서 토스 접근 정책을 IP 기준으로 적용하려면 고정 IP를 가진 아웃바운드 프록시를 두고 그 IP를 등록해야 한다. 별도 프록시를 두지 않는 초기 운영에서는 모든 Edge Function 호출에 `forceFunctionRegion=ap-northeast-2`를 붙이고, 토스 접근 정책을 국가 `대한민국`으로 설정한 뒤 테스트 환경에서 먼저 검증한다. 웹훅 수신 자체는 토스에서 CURI:T으로 들어오는 요청이므로 아웃바운드 정책의 대상이 아니지만, 웹훅 처리 중 수행하는 결제 재조회는 대상이다.

판매자 등록은 `POST /api/internal/payouts/sellers`, 지급 실행은 `POST /api/internal/payouts/run`을 사용한다. 두 엔드포인트 모두 `x-curit-job-secret`과 명시적인 실행 확인값이 필요하다. 계좌·사업자 정보는 토스에 JWE(`dir` + `A256GCM`)로 전송하고 CURI:T DB에는 저장하지 않으며, 토스 Seller 식별자와 심사 상태만 보관한다. 지급 실행 전 토스의 지급 가능 잔액을 조회해 요청 합계보다 부족하면 실행을 차단하고, 실제 지급 요청에는 JWE와 멱등키를 적용한다.

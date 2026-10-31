-- CURI:T 본선 시연 데이터
-- 전제: Supabase Auth에 아래 이메일의 자동 확인 사용자가 먼저 생성되어 있어야 한다.
--   creator.demo@curit.app / store.demo@curit.app

DO $$
DECLARE
  creator_user_id UUID;
  store_user_id UUID;
  demo_store_id CONSTANT UUID := '10000000-0000-4000-8000-000000000001';
  demo_project_id CONSTANT UUID := '20000000-0000-4000-8000-000000000001';
  demo_item_id CONSTANT UUID := '30000000-0000-4000-8000-000000000001';
  demo_mug_item_id CONSTANT UUID := '30000000-0000-4000-8000-000000000002';
  demo_bowl_item_id CONSTANT UUID := '30000000-0000-4000-8000-000000000003';
  demo_collaboration_id CONSTANT UUID := '40000000-0000-4000-8000-000000000001';
  demo_listing_id CONSTANT UUID := '50000000-0000-4000-8000-000000000001';
  demo_mug_listing_id CONSTANT UUID := '50000000-0000-4000-8000-000000000002';
  demo_bowl_listing_id CONSTANT UUID := '50000000-0000-4000-8000-000000000003';
  demo_qr_token CONSTANT TEXT := 'demo-dessert-plate';
  demo_mug_qr_token CONSTANT TEXT := 'demo-mug-white-gray';
  demo_bowl_qr_token CONSTANT TEXT := 'demo-bowl-set-2026';
BEGIN
  SELECT id INTO creator_user_id
  FROM auth.users
  WHERE email = 'creator.demo@curit.app';

  SELECT id INTO store_user_id
  FROM auth.users
  WHERE email = 'store.demo@curit.app';

  IF creator_user_id IS NULL OR store_user_id IS NULL THEN
    RAISE EXCEPTION 'Create the CURI:T creator/store demo auth users first.';
  END IF;

  INSERT INTO public.profiles (id, role, display_name, handle)
  VALUES
    (creator_user_id, 'creator', '김서연', '@soyeon_craft'),
    (store_user_id, 'store', '아늑한 서울 운영자', NULL)
  ON CONFLICT (id) DO UPDATE SET
    role = EXCLUDED.role,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle;

  DELETE FROM public.creator_profiles WHERE user_id = store_user_id;

  INSERT INTO public.creator_profiles (
    user_id, introduction, categories, regions, portfolio_url, sns_url
  ) VALUES (
    creator_user_id,
    '제주 자연에서 영감을 받은 도예 작가',
    ARRAY['도예', '세라믹', '생활공예'],
    ARRAY['제주', '서울'],
    'https://project-curit.github.io/curit-qr-web/?qr=demo-dessert-plate',
    'https://instagram.com/soyeon_craft'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    introduction = EXCLUDED.introduction,
    categories = EXCLUDED.categories,
    regions = EXCLUDED.regions,
    portfolio_url = EXCLUDED.portfolio_url,
    sns_url = EXCLUDED.sns_url;

  INSERT INTO public.store_profiles (
    id, owner_id, name, category, address, introduction, target_audience,
    mood_tags, purpose_tags, monthly_budget_min, monthly_budget_max,
    exhibition_zones, onboarding_step, onboarding_complete
  ) VALUES (
    demo_store_id,
    store_user_id,
    '아늑한 서울',
    '카페',
    '서울 성동구 성수동',
    '우드톤 공간에서 커피와 독립 창작자의 작품을 함께 소개하는 30석 카페입니다.',
    '20~30대 직장인·대학생, 예술과 공예에 관심 있는 방문객',
    ARRAY['우드톤', '미니멀', '따뜻함'],
    ARRAY['공간 분위기 전환', '지역 작가 소개', 'QR 판매'],
    200000,
    500000,
    '[{"type":"shelf","label":"카운터 선반","widthMm":1800,"heightMm":800},{"type":"wall","label":"메인 벽면","widthMm":2400,"heightMm":1600}]'::jsonb,
    5,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    introduction = EXCLUDED.introduction,
    target_audience = EXCLUDED.target_audience,
    mood_tags = EXCLUDED.mood_tags,
    purpose_tags = EXCLUDED.purpose_tags,
    monthly_budget_min = EXCLUDED.monthly_budget_min,
    monthly_budget_max = EXCLUDED.monthly_budget_max,
    exhibition_zones = EXCLUDED.exhibition_zones,
    onboarding_step = 5,
    onboarding_complete = TRUE;

  INSERT INTO public.projects (
    id, creator_id, title, story, concept, region, purpose, status
  ) VALUES (
    demo_project_id,
    creator_user_id,
    '흙의 기억',
    '제주 흙과 자연의 색을 담아 매일 쓰는 그릇에 손으로 만든 온기를 남깁니다.',
    '우드톤 매장과 어울리는 따뜻한 세라믹 생활 공예',
    '서울·제주',
    '작품 전시 및 QR 판매',
    'matched'
  )
  ON CONFLICT (id) DO UPDATE SET
    creator_id = EXCLUDED.creator_id,
    title = EXCLUDED.title,
    story = EXCLUDED.story,
    concept = EXCLUDED.concept,
    region = EXCLUDED.region,
    purpose = EXCLUDED.purpose,
    status = EXCLUDED.status;

  INSERT INTO public.project_items (
    id, project_id, name, description, item_type, sale_mode,
    price, stock, image_path, material, width_mm, height_mm
  ) VALUES
  (
    demo_item_id, demo_project_id, '제주빛 디저트 플레이트',
    '제주의 모래빛을 담은 작은 세라믹 디저트 플레이트입니다.',
    'goods', 'display_sale', 55000, 8,
    'https://project-curit.github.io/curit-qr-web/artworks/dessert-plate.jpg',
    '세라믹', 180, 180
  ),
  (
    demo_mug_item_id, demo_project_id, '머그컵 (화이트·그레이)',
    '손으로 빚어 각기 다른 결을 지닌 세라믹 머그컵입니다.',
    'goods', 'display_sale', 35000, 12,
    'https://project-curit.github.io/curit-qr-web/artworks/reference-1.jpg',
    '세라믹', 90, 100
  ),
  (
    demo_bowl_item_id, demo_project_id, '볼 세트 (2개)',
    '밥과 국, 디저트까지 편안하게 담을 수 있는 2인 볼 세트입니다.',
    'goods', 'display_sale', 82000, 6,
    'https://project-curit.github.io/curit-qr-web/artworks/bowl-set.jpg',
    '세라믹', 160, 80
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    item_type = EXCLUDED.item_type,
    sale_mode = EXCLUDED.sale_mode,
    price = EXCLUDED.price,
    stock = EXCLUDED.stock,
    image_path = EXCLUDED.image_path,
    material = EXCLUDED.material,
    width_mm = EXCLUDED.width_mm,
    height_mm = EXCLUDED.height_mm;

  INSERT INTO public.collaborations (
    id, project_id, store_id, creator_id, status, starts_on, ends_on,
    creator_share_percent, store_share_percent, platform_share_percent, terms
  ) VALUES (
    demo_collaboration_id,
    demo_project_id,
    demo_store_id,
    creator_user_id,
    'active',
    CURRENT_DATE,
    DATE '2026-12-31',
    80,
    10,
    10,
    '{"installation":"self","pickup":"exhibition_end","approvedForDemo":true}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE SET
    status = 'active',
    starts_on = EXCLUDED.starts_on,
    ends_on = EXCLUDED.ends_on,
    creator_share_percent = EXCLUDED.creator_share_percent,
    store_share_percent = EXCLUDED.store_share_percent,
    platform_share_percent = EXCLUDED.platform_share_percent,
    terms = EXCLUDED.terms;

  INSERT INTO public.qr_listings (
    id, qr_token_hash, token_hint, sale_status, price, stock, snapshot,
    project_item_id, collaboration_id, qr_token_value
  ) VALUES (
    demo_listing_id,
    encode(digest(demo_qr_token, 'sha256'), 'hex'),
    right(demo_qr_token, 12),
    'active',
    55000,
    8,
    jsonb_build_object(
      'v', 1,
      'qrToken', demo_qr_token,
      'storeId', 'store-anukhan-seoul',
      'requestId', 'exhibition-heuk-memory-plate-2026-10',
      'returnUrl', 'https://project-curit.github.io/curit-qr-web',
      'saleStatus', 'active',
      'store', jsonb_build_object(
        'name', '아늑한 서울',
        'phone', '02-123-4567',
        'address', '서울 성동구 성수동',
        'hours', '매일 10:00–21:00'
      ),
      'project', jsonb_build_object(
        'title', '흙의 기억',
        'concept', '제주 흙과 자연의 색을 담아 매일 쓰는 그릇에 손으로 만든 온기를 남깁니다.'
      ),
      'creator', jsonb_build_object(
        'name', '김서연',
        'handle', '@soyeon_craft',
        'introduction', '제주 자연에서 영감을 받은 도예 작가',
        'description', '조금씩 다른 손자국과 유약의 흐름을 작품의 일부로 남깁니다.',
        'categories', jsonb_build_array('도예', '세라믹', '생활공예'),
        'regions', jsonb_build_array('제주', '서울')
      ),
      'product', jsonb_build_object(
        'artworkId', demo_item_id::text,
        'projectId', 1,
        'goodsIndex', 0,
        'name', '제주빛 디저트 플레이트',
        'artist', '김서연',
        'price', 55000,
        'stock', 8,
        'image', 'https://project-curit.github.io/curit-qr-web/artworks/dessert-plate.jpg',
        'description', '제주의 모래빛을 담은 작은 디저트 플레이트입니다.',
        'composition', '세라믹 플레이트 1개',
        'care', '사용 전 세척하고 표면을 긁는 금속 수세미는 피해주세요.',
        'pickupMode', 'exhibition',
        'exhibitionEnd', '2026-12-31'
      )
    ),
    demo_item_id,
    demo_collaboration_id,
    demo_qr_token
  )
  ON CONFLICT (id) DO UPDATE SET
    qr_token_hash = EXCLUDED.qr_token_hash,
    token_hint = EXCLUDED.token_hint,
    sale_status = 'active',
    price = EXCLUDED.price,
    stock = EXCLUDED.stock,
    snapshot = EXCLUDED.snapshot,
    project_item_id = EXCLUDED.project_item_id,
    collaboration_id = EXCLUDED.collaboration_id,
    qr_token_value = EXCLUDED.qr_token_value,
    updated_at = NOW();

  INSERT INTO public.qr_listings (
    id, qr_token_hash, token_hint, sale_status, price, stock, snapshot,
    project_item_id, collaboration_id, qr_token_value
  )
  SELECT
    demo_mug_listing_id,
    encode(digest(demo_mug_qr_token, 'sha256'), 'hex'),
    right(demo_mug_qr_token, 12),
    'active',
    35000,
    12,
    (snapshot - 'qrToken' - 'requestId' - 'product') || jsonb_build_object(
      'qrToken', demo_mug_qr_token,
      'requestId', 'exhibition-heuk-memory-mug-2026-10',
      'product', jsonb_build_object(
        'artworkId', demo_mug_item_id::text,
        'projectId', 0,
        'goodsIndex', 0,
        'name', '머그컵 (화이트·그레이)',
        'artist', '김서연',
        'price', 35000,
        'stock', 12,
        'image', 'https://project-curit.github.io/curit-qr-web/artworks/reference-1.jpg',
        'description', '손으로 빚어 각기 다른 결을 지닌 세라믹 머그컵입니다.',
        'composition', '세라믹 머그컵 1개',
        'care', '전자레인지 사용 가능 · 식기세척기보다 손세척을 권장합니다.',
        'pickupMode', 'immediate',
        'exhibitionEnd', ''
      )
    ),
    demo_mug_item_id,
    demo_collaboration_id,
    demo_mug_qr_token
  FROM public.qr_listings
  WHERE id = demo_listing_id
  ON CONFLICT (id) DO UPDATE SET
    qr_token_hash = EXCLUDED.qr_token_hash,
    token_hint = EXCLUDED.token_hint,
    sale_status = 'active',
    price = EXCLUDED.price,
    stock = EXCLUDED.stock,
    snapshot = EXCLUDED.snapshot,
    project_item_id = EXCLUDED.project_item_id,
    collaboration_id = EXCLUDED.collaboration_id,
    qr_token_value = EXCLUDED.qr_token_value,
    updated_at = NOW();

  INSERT INTO public.qr_listings (
    id, qr_token_hash, token_hint, sale_status, price, stock, snapshot,
    project_item_id, collaboration_id, qr_token_value
  )
  SELECT
    demo_bowl_listing_id,
    encode(digest(demo_bowl_qr_token, 'sha256'), 'hex'),
    right(demo_bowl_qr_token, 12),
    'active',
    82000,
    6,
    (snapshot - 'qrToken' - 'requestId' - 'product') || jsonb_build_object(
      'qrToken', demo_bowl_qr_token,
      'requestId', 'exhibition-heuk-memory-bowl-2026-10',
      'product', jsonb_build_object(
        'artworkId', demo_bowl_item_id::text,
        'projectId', 0,
        'goodsIndex', 1,
        'name', '볼 세트 (2개)',
        'artist', '김서연',
        'price', 82000,
        'stock', 6,
        'image', 'https://project-curit.github.io/curit-qr-web/artworks/bowl-set.jpg',
        'description', '밥과 국, 디저트까지 편안하게 담을 수 있는 2인 볼 세트입니다.',
        'composition', '세라믹 볼 2개',
        'care', '급격한 온도 변화와 강한 충격을 피해주세요.',
        'pickupMode', 'immediate',
        'exhibitionEnd', ''
      )
    ),
    demo_bowl_item_id,
    demo_collaboration_id,
    demo_bowl_qr_token
  FROM public.qr_listings
  WHERE id = demo_listing_id
  ON CONFLICT (id) DO UPDATE SET
    qr_token_hash = EXCLUDED.qr_token_hash,
    token_hint = EXCLUDED.token_hint,
    sale_status = 'active',
    price = EXCLUDED.price,
    stock = EXCLUDED.stock,
    snapshot = EXCLUDED.snapshot,
    project_item_id = EXCLUDED.project_item_id,
    collaboration_id = EXCLUDED.collaboration_id,
    qr_token_value = EXCLUDED.qr_token_value,
    updated_at = NOW();
END;
$$;

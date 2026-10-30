-- 본선 시연 계정에서 커뮤니티와 알림 화면이 빈 상태로 보이지 않도록
-- 기존 데모 계정이 있을 때만 멱등적으로 샘플 콘텐츠를 추가한다.

INSERT INTO public.creator_posts (creator_id, content, image_path)
SELECT
  u.id,
  '새 계절 전시를 준비하고 있어요. 흙의 자연스러운 질감이 우드톤 공간에서 어떻게 보일지 기대됩니다.',
  (
    SELECT pi.image_path
    FROM public.project_items pi
    JOIN public.projects p ON p.id = pi.project_id
    WHERE p.creator_id = u.id AND pi.image_path IS NOT NULL
    ORDER BY pi.created_at
    LIMIT 1
  )
FROM auth.users u
WHERE u.email = 'creator.demo@curit.app'
  AND NOT EXISTS (
    SELECT 1 FROM public.creator_posts cp
    WHERE cp.creator_id = u.id
      AND cp.content = '새 계절 전시를 준비하고 있어요. 흙의 자연스러운 질감이 우드톤 공간에서 어떻게 보일지 기대됩니다.'
  );

INSERT INTO public.notifications (user_id, title, body, kind)
SELECT u.id, 'CURI:T의 모든 기능이 준비됐어요', '프로필, 프로젝트, 커뮤니티, QR 판매와 수령 관리까지 직접 확인해 보세요.', 'system'
FROM auth.users u
WHERE u.email IN ('creator.demo@curit.app', 'store.demo@curit.app')
  AND NOT EXISTS (
    SELECT 1 FROM public.notifications n
    WHERE n.user_id = u.id AND n.kind = 'system' AND n.title = 'CURI:T의 모든 기능이 준비됐어요'
  );

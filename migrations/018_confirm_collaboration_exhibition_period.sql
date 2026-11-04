-- Lock changed dates with the same collaboration row used by QR issuance.
CREATE FUNCTION public.guard_curit_exhibition_period()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.starts_on IS NOT DISTINCT FROM OLD.starts_on
    AND NEW.ends_on IS NOT DISTINCT FROM OLD.ends_on THEN RETURN NEW; END IF;
  IF NEW.starts_on IS NULL OR NEW.ends_on IS NULL OR NOT isfinite(NEW.starts_on)
    OR NOT isfinite(NEW.ends_on) OR NEW.ends_on <= NEW.starts_on
    OR NEW.starts_on < DATE '0001-01-01' OR NEW.ends_on > DATE '9999-12-31'
  THEN RAISE EXCEPTION 'INVALID_EXHIBITION_DATES'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('active', 'completed')
      OR (OLD.status = 'cancelled' AND NEW.status = 'cancelled')
      OR EXISTS (SELECT 1 FROM public.qr_listings WHERE collaboration_id = OLD.id)
    THEN RAISE EXCEPTION 'COLLABORATION_SCHEDULE_LOCKED'; END IF;
    NEW.terms := NEW.terms || jsonb_build_object('scheduleNeedsReview', true);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_curit_exhibition_period() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER curit_guard_exhibition_period
BEFORE INSERT OR UPDATE OF starts_on, ends_on ON public.collaborations
FOR EACH ROW EXECUTE FUNCTION public.guard_curit_exhibition_period();

CREATE FUNCTION public.notify_curit_exhibition_period_change()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE recipient UUID;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF auth.uid() = NEW.creator_id THEN
    SELECT owner_id INTO recipient FROM public.store_profiles WHERE id = NEW.store_id;
  ELSE
    recipient := NEW.creator_id;
  END IF;
  INSERT INTO public.notifications (user_id, title, body, kind, entity_id)
  VALUES (recipient, '전시 기간이 바뀌었어요', '새 전시 기간과 작품 수량을 확인해 주세요.', 'collaboration', NEW.id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_curit_exhibition_period_change() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER curit_notify_exhibition_period_change
AFTER UPDATE OF starts_on, ends_on ON public.collaborations
FOR EACH ROW
WHEN (OLD.starts_on IS DISTINCT FROM NEW.starts_on OR OLD.ends_on IS DISTINCT FROM NEW.ends_on)
EXECUTE FUNCTION public.notify_curit_exhibition_period_change();

-- Only the store may change the layout or proposed quantity.
-- Only the creator may confirm the saved quantity.
CREATE OR REPLACE FUNCTION public.save_curit_collaboration_terms(
  p_collaboration_id UUID,
  p_terms JSONB DEFAULT '{}'::jsonb,
  p_items JSONB DEFAULT '[]'::jsonb
)
RETURNS public.collaborations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor UUID := auth.uid();
  selected public.collaborations;
  item JSONB;
  product_id UUID;
  product_stock INTEGER;
  requested INTEGER;
  current_item public.collaboration_items;
  is_creator BOOLEAN;
  next_start DATE;
  next_end DATE;
  dates_supplied BOOLEAN := COALESCE(p_terms ? 'startsOn' OR p_terms ? 'endsOn', FALSE);
BEGIN
  SELECT c.* INTO selected
  FROM public.collaborations c
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE c.id = p_collaboration_id AND (c.creator_id = actor OR s.owner_id = actor)
  FOR UPDATE OF c;
  IF selected.id IS NULL THEN RAISE EXCEPTION 'COLLABORATION_NOT_FOUND'; END IF;
  IF selected.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'COLLABORATION_CLOSED'; END IF;
  is_creator := selected.creator_id = actor;
  next_start := selected.starts_on;
  next_end := selected.ends_on;

  IF dates_supplied THEN
    IF is_creator THEN
      IF p_terms ->> 'startsOn' IS DISTINCT FROM to_char(next_start, 'YYYY-MM-DD')
        OR p_terms ->> 'endsOn' IS DISTINCT FROM to_char(next_end, 'YYYY-MM-DD')
      THEN RAISE EXCEPTION 'COLLABORATION_SCHEDULE_CHANGED'; END IF;
    ELSE
      IF COALESCE(p_terms ->> 'startsOn', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        OR COALESCE(p_terms ->> 'endsOn', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      THEN RAISE EXCEPTION 'INVALID_EXHIBITION_DATES'; END IF;
      BEGIN
        next_start := (p_terms ->> 'startsOn')::date;
        next_end := (p_terms ->> 'endsOn')::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION 'INVALID_EXHIBITION_DATES';
      END;
      IF next_end <= next_start THEN RAISE EXCEPTION 'INVALID_EXHIBITION_DATES'; END IF;
    END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    product_id := (item ->> 'projectItemId')::uuid;
    SELECT stock INTO product_stock
    FROM public.project_items
    WHERE id = product_id AND project_id = selected.project_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_COLLABORATION_ITEM'; END IF;
    SELECT * INTO current_item FROM public.collaboration_items
    WHERE collaboration_id = selected.id AND project_item_id = product_id;

    IF item -> 'selected' = 'false'::jsonb THEN
      IF is_creator THEN RAISE EXCEPTION 'COLLABORATION_CONFIRM_CREATOR_ONLY'; END IF;
      IF current_item.collaboration_id IS NULL THEN CONTINUE; END IF;
      IF EXISTS (
        SELECT 1 FROM public.qr_listings
        WHERE collaboration_id = selected.id AND project_item_id = product_id
      ) THEN RAISE EXCEPTION 'COLLABORATION_QUANTITY_LOCKED'; END IF;
      DELETE FROM public.collaboration_items
      WHERE collaboration_id = selected.id AND project_item_id = product_id;
      CONTINUE;
    END IF;

    IF jsonb_typeof(item -> 'quantity') IS DISTINCT FROM 'number'
      OR (item ->> 'quantity') !~ '^[0-9]{1,6}$'
    THEN RAISE EXCEPTION 'INVALID_COLLABORATION_QUANTITY'; END IF;
    requested := (item ->> 'quantity')::integer;
    IF requested < 1 OR requested > LEAST(product_stock, 100000)
    THEN RAISE EXCEPTION 'INVALID_COLLABORATION_QUANTITY'; END IF;

    IF is_creator THEN
      IF requested IS DISTINCT FROM current_item.quantity
        THEN RAISE EXCEPTION 'COLLABORATION_QUANTITY_CHANGED'; END IF;
      IF item -> 'creatorConfirmed' IS DISTINCT FROM 'true'::jsonb THEN CONTINUE; END IF;
    ELSE
      IF item -> 'creatorConfirmed' = 'true'::jsonb
        AND (current_item.creator_confirmed IS DISTINCT FROM TRUE OR current_item.quantity <> requested)
      THEN RAISE EXCEPTION 'COLLABORATION_CONFIRM_CREATOR_ONLY'; END IF;
      IF current_item.quantity IS DISTINCT FROM requested AND EXISTS (
        SELECT 1 FROM public.qr_listings
        WHERE collaboration_id = selected.id AND project_item_id = product_id
          AND snapshot -> 'product' ? 'supplyLimit'
      ) THEN RAISE EXCEPTION 'COLLABORATION_QUANTITY_LOCKED'; END IF;
    END IF;

    INSERT INTO public.collaboration_items AS saved
      (collaboration_id, project_item_id, quantity, creator_confirmed)
    VALUES (selected.id, product_id, requested, is_creator)
    ON CONFLICT (collaboration_id, project_item_id) DO UPDATE
    SET quantity = EXCLUDED.quantity,
        creator_confirmed = is_creator OR (saved.creator_confirmed AND saved.quantity = EXCLUDED.quantity);
  END LOOP;

  IF NOT is_creator THEN
    UPDATE public.collaborations
    SET starts_on = next_start, ends_on = next_end,
        terms = terms
      || CASE WHEN p_terms ? 'installationZone' THEN jsonb_build_object('installationZone', left(p_terms ->> 'installationZone', 100)) ELSE '{}'::jsonb END
      || CASE WHEN p_terms ? 'note' THEN jsonb_build_object('note', left(p_terms ->> 'note', 1000)) ELSE '{}'::jsonb END,
      updated_at = NOW()
    WHERE id = selected.id RETURNING * INTO selected;
  ELSIF dates_supplied AND selected.terms -> 'scheduleNeedsReview' = 'true'::jsonb
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS entry(value)
      WHERE entry.value -> 'creatorConfirmed' = 'true'::jsonb
    )
    AND EXISTS (SELECT 1 FROM public.collaboration_items WHERE collaboration_id = selected.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.collaboration_items
      WHERE collaboration_id = selected.id AND creator_confirmed IS DISTINCT FROM TRUE
    )
  THEN
    UPDATE public.collaborations
    SET terms = terms - 'scheduleNeedsReview', updated_at = NOW()
    WHERE id = selected.id RETURNING * INTO selected;
  END IF;
  RETURN selected;
END;
$$;

REVOKE ALL ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_curit_collaboration_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.terms -> 'scheduleNeedsReview' = 'true'::jsonb
  THEN RAISE EXCEPTION 'COLLABORATION_SCHEDULE_UNCONFIRMED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collaboration_items WHERE collaboration_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM public.collaboration_items
    WHERE collaboration_id = NEW.id AND creator_confirmed IS DISTINCT FROM TRUE
  ) THEN RAISE EXCEPTION 'COLLABORATION_SUPPLY_UNCONFIRMED'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.collaboration_items item
    JOIN public.project_items product ON product.id = item.project_item_id
    WHERE item.collaboration_id = NEW.id AND item.quantity > product.stock
  ) THEN RAISE EXCEPTION 'COLLABORATION_SUPPLY_OUT_OF_STOCK'; END IF;
  RETURN NEW;
END;
$$;

-- Revalidate current agreements under the same collaboration lock as term edits.
-- Keep existing standalone and pre-agreement listings compatible.
CREATE OR REPLACE FUNCTION public.guard_curit_qr_listing_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  parent_status TEXT;
  confirmed_quantity INTEGER;
  parent_end DATE;
  parent_terms JSONB;
  checks_agreement BOOLEAN := TG_OP = 'INSERT' AND COALESCE(NEW.snapshot -> 'product' ? 'supplyLimit', FALSE);
BEGIN
  IF NEW.collaboration_id IS NULL OR (NEW.sale_status <> 'active' AND NOT checks_agreement) THEN
    RETURN NEW;
  END IF;

  SELECT status, ends_on, terms INTO parent_status, parent_end, parent_terms
  FROM public.collaborations WHERE id = NEW.collaboration_id FOR SHARE;
  IF NEW.sale_status = 'active' AND parent_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'COLLABORATION_INACTIVE';
  END IF;

  IF checks_agreement THEN
    IF parent_status IS NULL OR parent_status NOT IN ('approved', 'active') THEN
      RAISE EXCEPTION 'COLLABORATION_INACTIVE';
    END IF;
    IF parent_terms -> 'scheduleNeedsReview' = 'true'::jsonb
    THEN RAISE EXCEPTION 'COLLABORATION_SCHEDULE_UNCONFIRMED'; END IF;
    IF (NEW.snapshot -> 'product' ? 'pickupMode')
      AND NEW.snapshot -> 'product' ->> 'exhibitionEnd' IS DISTINCT FROM COALESCE(to_char(parent_end, 'YYYY-MM-DD'), '')
    THEN RAISE EXCEPTION 'COLLABORATION_SCHEDULE_CHANGED'; END IF;
    SELECT quantity INTO confirmed_quantity FROM public.collaboration_items
    WHERE collaboration_id = NEW.collaboration_id AND project_item_id = NEW.project_item_id
      AND creator_confirmed;
    IF confirmed_quantity IS NULL
      OR to_jsonb(confirmed_quantity) IS DISTINCT FROM NEW.snapshot -> 'product' -> 'supplyLimit'
    THEN RAISE EXCEPTION 'COLLABORATION_SUPPLY_CHANGED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

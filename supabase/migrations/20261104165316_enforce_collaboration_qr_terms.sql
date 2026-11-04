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
BEGIN
  SELECT c.* INTO selected
  FROM public.collaborations c
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE c.id = p_collaboration_id AND (c.creator_id = actor OR s.owner_id = actor)
  FOR UPDATE OF c;
  IF selected.id IS NULL THEN RAISE EXCEPTION 'COLLABORATION_NOT_FOUND'; END IF;
  IF selected.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'COLLABORATION_CLOSED'; END IF;
  is_creator := selected.creator_id = actor;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    product_id := (item ->> 'projectItemId')::uuid;
    SELECT stock INTO product_stock
    FROM public.project_items
    WHERE id = product_id AND project_id = selected.project_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_COLLABORATION_ITEM'; END IF;
    IF jsonb_typeof(item -> 'quantity') IS DISTINCT FROM 'number'
      OR (item ->> 'quantity') !~ '^[0-9]{1,6}$'
    THEN RAISE EXCEPTION 'INVALID_COLLABORATION_QUANTITY'; END IF;
    requested := (item ->> 'quantity')::integer;
    IF requested < 1 OR requested > LEAST(product_stock, 100000)
    THEN RAISE EXCEPTION 'INVALID_COLLABORATION_QUANTITY'; END IF;

    SELECT * INTO current_item FROM public.collaboration_items
    WHERE collaboration_id = selected.id AND project_item_id = product_id;

    IF is_creator THEN
      IF requested <> COALESCE(current_item.quantity, 1)
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
    SET terms = terms
      || CASE WHEN p_terms ? 'installationZone' THEN jsonb_build_object('installationZone', left(p_terms ->> 'installationZone', 100)) ELSE '{}'::jsonb END
      || CASE WHEN p_terms ? 'note' THEN jsonb_build_object('note', left(p_terms ->> 'note', 1000)) ELSE '{}'::jsonb END,
      updated_at = NOW()
    WHERE id = selected.id RETURNING * INTO selected;
  END IF;
  RETURN selected;
END;
$$;

REVOKE ALL ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.pause_curit_closed_collaboration_listings()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  UPDATE public.qr_listings SET sale_status = 'preparing', updated_at = NOW()
  WHERE collaboration_id = NEW.id AND sale_status = 'active';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pause_curit_closed_collaboration_listings() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS curit_pause_closed_collaboration_listings ON public.collaborations;
CREATE TRIGGER curit_pause_closed_collaboration_listings
AFTER UPDATE OF status ON public.collaborations
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'cancelled'))
EXECUTE FUNCTION public.pause_curit_closed_collaboration_listings();

UPDATE public.qr_listings AS listing SET sale_status = 'preparing', updated_at = NOW()
FROM public.collaborations AS collaboration
WHERE listing.collaboration_id = collaboration.id AND listing.sale_status = 'active'
  AND collaboration.status IN ('completed', 'cancelled');

-- An activation racing the collaboration's closing transaction must also
-- observe the final state. Existing standalone QR listings have no parent.
CREATE OR REPLACE FUNCTION public.guard_curit_qr_listing_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE parent_status TEXT;
BEGIN
  IF NEW.sale_status <> 'active' OR NEW.collaboration_id IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO parent_status
  FROM public.collaborations WHERE id = NEW.collaboration_id FOR SHARE;
  IF parent_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'COLLABORATION_INACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_curit_qr_listing_activation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS curit_guard_qr_listing_activation ON public.qr_listings;
CREATE TRIGGER curit_guard_qr_listing_activation
BEFORE INSERT OR UPDATE OF sale_status ON public.qr_listings
FOR EACH ROW EXECUTE FUNCTION public.guard_curit_qr_listing_activation();

CREATE OR REPLACE FUNCTION public.curit_qr_paid_quantity(p_listing_id UUID)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT COALESCE(sum(quantity), 0) FROM public.qr_orders
  WHERE listing_id = p_listing_id AND status = 'paid';
$$;

REVOKE ALL ON FUNCTION public.curit_qr_paid_quantity(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.curit_qr_paid_quantity(UUID) TO service_role;

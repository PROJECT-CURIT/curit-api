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

-- Term updates and transitions both lock the collaboration row first.
CREATE OR REPLACE FUNCTION public.guard_curit_collaboration_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public.guard_curit_collaboration_activation() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER curit_guard_collaboration_activation
BEFORE UPDATE OF status ON public.collaborations
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'active')
EXECUTE FUNCTION public.guard_curit_collaboration_activation();

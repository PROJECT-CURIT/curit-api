-- Revalidate current agreements under the same collaboration lock as term edits.
-- Keep existing standalone and pre-agreement listings compatible.
CREATE OR REPLACE FUNCTION public.guard_curit_qr_listing_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  parent_status TEXT;
  confirmed_quantity INTEGER;
  checks_agreement BOOLEAN := TG_OP = 'INSERT' AND COALESCE(NEW.snapshot -> 'product' ? 'supplyLimit', FALSE);
BEGIN
  IF NEW.collaboration_id IS NULL OR (NEW.sale_status <> 'active' AND NOT checks_agreement) THEN
    RETURN NEW;
  END IF;

  SELECT status INTO parent_status
  FROM public.collaborations WHERE id = NEW.collaboration_id FOR SHARE;
  IF NEW.sale_status = 'active' AND parent_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'COLLABORATION_INACTIVE';
  END IF;

  IF checks_agreement THEN
    IF parent_status IS NULL OR parent_status NOT IN ('approved', 'active') THEN
      RAISE EXCEPTION 'COLLABORATION_INACTIVE';
    END IF;
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

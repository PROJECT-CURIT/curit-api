ALTER TABLE public.field_product_view_events
  DROP CONSTRAINT IF EXISTS field_product_view_events_product_id_check,
  ADD CONSTRAINT field_product_view_events_product_id_check
    CHECK (product_id IN (
      'kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards',
      'jjukkumi-keyring', 'tea-coaster'
    ));

ALTER TABLE public.field_product_purchase_intent_events
  DROP CONSTRAINT IF EXISTS field_product_purchase_intent_events_product_id_check,
  ADD CONSTRAINT field_product_purchase_intent_events_product_id_check
    CHECK (product_id IN (
      'kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards',
      'jjukkumi-keyring', 'tea-coaster'
    ));

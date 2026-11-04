ALTER TABLE public.field_product_view_events
  DROP CONSTRAINT field_product_view_events_product_id_check,
  ADD CONSTRAINT field_product_view_events_product_id_check CHECK (
    product_id IN ('kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards', 'tea-coaster', 'jjukkumi-keyring')
  );

ALTER TABLE public.field_product_purchase_intent_events
  DROP CONSTRAINT field_product_purchase_intent_events_product_id_check,
  ADD CONSTRAINT field_product_purchase_intent_events_product_id_check CHECK (
    product_id IN ('kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards', 'tea-coaster', 'jjukkumi-keyring')
  );

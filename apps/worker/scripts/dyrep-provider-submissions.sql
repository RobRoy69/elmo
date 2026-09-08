CREATE TABLE public.dyrep_provider_submissions (
  batch_id uuid NOT NULL REFERENCES public.cell_batches(id),
  surface text NOT NULL CHECK (surface IN ('chatgpt-search','google-ai','perplexity')),
  request_body jsonb NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitting','submitted','complete','failed','outcome_unknown')),
  provider_id text UNIQUE,
  submitted_at timestamptz,
  next_poll_at timestamptz,
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts BETWEEN 0 AND 60),
  results jsonb,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id,surface),
  CHECK (provider_id IS NULL OR provider_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CHECK (status NOT IN ('submitted','complete') OR provider_id IS NOT NULL),
  CHECK ((request_body->>'country' = 'NL' AND jsonb_array_length(request_body->'items') = 4) IS TRUE)
);
ALTER TABLE public.dyrep_provider_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dyrep_provider_submissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.dyrep_provider_submissions TO geo_elmo_netlify_dyrep_r1;
GRANT UPDATE(status,provider_id,submitted_at,next_poll_at,poll_attempts,results,error_code,updated_at)
  ON public.dyrep_provider_submissions TO geo_elmo_netlify_dyrep_r1;
CREATE POLICY dyrep_provider_bound ON public.dyrep_provider_submissions
FOR ALL TO geo_elmo_netlify_dyrep_r1
USING (EXISTS (SELECT 1 FROM public.cell_batches b WHERE b.id=batch_id
  AND b.target_ref='dyrep-org' AND b.brand_website='https://dyrep.org'
  AND b.request_hash='sha256:c187522e6857ce7dff5348b90f09aa7fcc98ff62a7136730e2461da469685d83'))
WITH CHECK (EXISTS (SELECT 1 FROM public.cell_batches b WHERE b.id=batch_id
  AND b.target_ref='dyrep-org' AND b.brand_website='https://dyrep.org'
  AND b.request_hash='sha256:c187522e6857ce7dff5348b90f09aa7fcc98ff62a7136730e2461da469685d83'));

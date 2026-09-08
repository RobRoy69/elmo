SET LOCAL search_path = public;
DO $guard$ BEGIN
  IF (SELECT count(*) FROM geo_pilot.pilot_cell WHERE target_ref='dyrep-org'
    AND project_ref='dgrrwlamisfgtlwuhpqu' AND branch_name='geo-pilot-dyrep-org'
    AND transport_enabled AND NOT provider_enabled) <> 1 THEN
    RAISE EXCEPTION 'dyrep_preview_binding_required';
  END IF;
END $guard$;
CREATE ROLE geo_elmo_netlify_dyrep_r1 LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE geo_elmo_netlify_dyrep_r1 SET statement_timeout = '12s';
ALTER ROLE geo_elmo_netlify_dyrep_r1 SET lock_timeout = '3s';
ALTER ROLE geo_elmo_netlify_dyrep_r1 SET idle_in_transaction_session_timeout = '15s';
GRANT USAGE ON SCHEMA public TO geo_elmo_netlify_dyrep_r1;
GRANT SELECT, INSERT ON public.cell_batches, public.cell_batch_cells TO geo_elmo_netlify_dyrep_r1;
GRANT UPDATE(status,completed_at,updated_at) ON public.cell_batches TO geo_elmo_netlify_dyrep_r1;
GRANT UPDATE(status,model_version,text,brand_mentioned,citations_supported,citations,observed_at,error_code,updated_at) ON public.cell_batch_cells TO geo_elmo_netlify_dyrep_r1;
CREATE POLICY dyrep_netlify_batch ON public.cell_batches FOR ALL TO geo_elmo_netlify_dyrep_r1
USING (target_ref='dyrep-org' AND brand_website='https://dyrep.org'
 AND request_hash='sha256:c187522e6857ce7dff5348b90f09aa7fcc98ff62a7136730e2461da469685d83')
WITH CHECK (target_ref='dyrep-org' AND brand_website='https://dyrep.org'
 AND request_hash='sha256:c187522e6857ce7dff5348b90f09aa7fcc98ff62a7136730e2461da469685d83');
CREATE POLICY dyrep_netlify_cells ON public.cell_batch_cells FOR ALL TO geo_elmo_netlify_dyrep_r1
USING (EXISTS (SELECT 1 FROM public.cell_batches b WHERE b.id=batch_id))
WITH CHECK (EXISTS (SELECT 1 FROM public.cell_batches b WHERE b.id=batch_id));


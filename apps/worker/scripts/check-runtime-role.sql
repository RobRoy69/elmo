GRANT geo_elmo_netlify_dyrep_r1 TO postgres WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE geo_elmo_netlify_dyrep_r1;
DO $proof$ DECLARE bid uuid; denied int := 0; BEGIN
 INSERT INTO public.cell_batches(target_ref,brand_name,brand_website,idempotency_key,request_hash,request_body)
 VALUES ('dyrep-org','DyReP','https://dyrep.org','rollback-permission-proof','sha256:c187522e6857ce7dff5348b90f09aa7fcc98ff62a7136730e2461da469685d83','{}') RETURNING id INTO bid;
 UPDATE public.cell_batches SET status='processing',updated_at=now() WHERE id=bid;
 BEGIN
  INSERT INTO public.cell_batches(target_ref,brand_name,brand_website,idempotency_key,request_hash,request_body)
  VALUES ('other','Other','https://other.example','rollback-wrong-target','wrong','{}');
 EXCEPTION WHEN insufficient_privilege THEN denied := denied+1; END;
 BEGIN UPDATE public.cell_batches SET request_hash='wrong' WHERE id=bid;
 EXCEPTION WHEN insufficient_privilege THEN denied := denied+1; END;
 BEGIN DELETE FROM public.cell_batches WHERE id=bid;
 EXCEPTION WHEN insufficient_privilege THEN denied := denied+1; END;
 BEGIN PERFORM count(*) FROM geo_pilot.runs;
 EXCEPTION WHEN insufficient_privilege THEN denied := denied+1; END;
 IF denied <> 4 THEN RAISE EXCEPTION 'permission_proof_failed'; END IF;
END $proof$;
SELECT 'allowed insert/update; denied wrong target, binding update, delete, transport; rolled back' AS proof;
RESET ROLE;

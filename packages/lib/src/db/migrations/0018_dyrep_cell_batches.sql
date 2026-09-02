CREATE TYPE "public"."cell_batch_cell_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "cell_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_ref" text NOT NULL,
	"brand_name" text NOT NULL,
	"brand_website" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_body" json NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_batches_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "cell_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cell_batch_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"query_ref" text NOT NULL,
	"query_text" text NOT NULL,
	"query_ordinal" integer NOT NULL,
	"surface" text NOT NULL,
	"surface_ordinal" integer NOT NULL,
	"repetition" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text,
	"probe_modality" text DEFAULT 'consumer' NOT NULL,
	"status" "cell_batch_cell_status" DEFAULT 'pending' NOT NULL,
	"text" text,
	"brand_mentioned" boolean,
	"citations_supported" boolean DEFAULT true NOT NULL,
	"citations" json DEFAULT '[]'::json NOT NULL,
	"observed_at" timestamp with time zone,
	"error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cell_batch_cells" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cell_batch_cells" ADD CONSTRAINT "cell_batch_cells_batch_id_cell_batches_id_fk"
	FOREIGN KEY ("batch_id") REFERENCES "public"."cell_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cell_batch_cells_coordinate_unique" ON "cell_batch_cells" USING btree
	("batch_id","query_ref","surface","repetition");--> statement-breakpoint
CREATE INDEX "cell_batch_cells_batch_order_idx" ON "cell_batch_cells" USING btree
	("batch_id","query_ordinal","surface_ordinal","repetition");--> statement-breakpoint
CREATE INDEX "cell_batches_target_created_idx" ON "cell_batches" USING btree ("target_ref","created_at");

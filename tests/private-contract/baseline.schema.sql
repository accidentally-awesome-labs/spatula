--
--



SET check_function_bodies = false;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: action_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.action_source AS ENUM (
    'extraction',
    'schema_evolution',
    'reconciliation',
    'quality_audit'
);


--
-- Name: action_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.action_status AS ENUM (
    'pending_review',
    'approved',
    'applied',
    'rejected',
    'rolled_back'
);


--
-- Name: crawl_task_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.crawl_task_status AS ENUM (
    'pending',
    'in_progress',
    'completed',
    'failed',
    'skipped'
);


--
-- Name: crawler_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.crawler_type AS ENUM (
    'playwright',
    'firecrawl'
);


--
-- Name: job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status AS ENUM (
    'pending',
    'queued',
    'running',
    'paused',
    'reconciling',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: page_classification; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.page_classification AS ENUM (
    'single_entry',
    'multiple_entries',
    'navigation',
    'irrelevant',
    'partial'
);


--
-- Name: task_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_priority AS ENUM (
    'high',
    'medium',
    'low'
);


--
-- Name: trust_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.trust_level AS ENUM (
    'authoritative',
    'high',
    'medium',
    'low'
);


SET default_tablespace = '';


--
-- Name: __drizzle_migrations_oss; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations_oss (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_oss_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_oss_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_oss_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_oss_id_seq OWNED BY drizzle.__drizzle_migrations_oss.id;


--
-- Name: actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    source public.action_source NOT NULL,
    status public.action_status DEFAULT 'pending_review'::public.action_status NOT NULL,
    confidence real NOT NULL,
    reasoning text NOT NULL,
    state_changes jsonb,
    reviewed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    name text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    actor_id text NOT NULL,
    actor_type text NOT NULL,
    action text NOT NULL,
    resource_type text,
    resource_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: content_store; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_store (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    content text,
    binary_content bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_at_least_one CHECK (((content IS NOT NULL) OR (binary_content IS NOT NULL))),
    CONSTRAINT content_not_both CHECK ((NOT ((content IS NOT NULL) AND (binary_content IS NOT NULL))))
);


--
-- Name: crawl_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crawl_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    url text NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    status public.crawl_task_status DEFAULT 'pending'::public.crawl_task_status NOT NULL,
    priority public.task_priority DEFAULT 'medium'::public.task_priority NOT NULL,
    classification public.page_classification,
    parent_task_id uuid,
    crawler_type public.crawler_type,
    content_ref text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: dead_letter_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dead_letter_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    queue_name text NOT NULL,
    job_id text NOT NULL,
    tenant_id uuid,
    spatula_job_id uuid,
    payload jsonb NOT NULL,
    error_message text,
    error_stack text,
    attempts integer NOT NULL,
    failed_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution text
);


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    merged_data jsonb NOT NULL,
    provenance jsonb NOT NULL,
    categories text[] DEFAULT '{}'::text[] NOT NULL,
    quality_score real DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_sources (
    entity_id uuid NOT NULL,
    extraction_id uuid NOT NULL,
    match_confidence real NOT NULL
);


--
-- Name: exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    format text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    include_provenance boolean DEFAULT false NOT NULL,
    entity_count integer,
    content_ref text,
    file_size integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: extractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extractions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    page_id uuid NOT NULL,
    schema_version integer NOT NULL,
    data jsonb NOT NULL,
    unmapped_fields jsonb DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    config jsonb NOT NULL,
    status public.job_status DEFAULT 'pending'::public.job_status NOT NULL,
    schema_id uuid,
    stats jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_id uuid,
    model text NOT NULL,
    prompt_tokens integer NOT NULL,
    completion_tokens integer NOT NULL,
    total_tokens integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    purpose text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: raw_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    content_ref text NOT NULL,
    content_hash text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schemas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_trust; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_trust (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    domain text NOT NULL,
    trust_level public.trust_level NOT NULL,
    reasoning text NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    quotas jsonb DEFAULT '{"maxStorageMb": 1000, "maxPagesPerJob": 5000, "maxConcurrentJobs": 2, "maxEntitiesPerExport": 50000}'::jsonb NOT NULL,
    storage_bytes_used bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_tenants (
    user_id text NOT NULL,
    tenant_id uuid NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: __drizzle_migrations_oss id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations_oss ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_oss_id_seq'::regclass);


--
-- Name: __drizzle_migrations_oss __drizzle_migrations_oss_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations_oss
    ADD CONSTRAINT __drizzle_migrations_oss_pkey PRIMARY KEY (id);


--
-- Name: actions actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: content_store content_store_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_store
    ADD CONSTRAINT content_store_key_unique UNIQUE (key);


--
-- Name: content_store content_store_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_store
    ADD CONSTRAINT content_store_pkey PRIMARY KEY (id);


--
-- Name: crawl_tasks crawl_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_tasks
    ADD CONSTRAINT crawl_tasks_pkey PRIMARY KEY (id);


--
-- Name: dead_letter_queue dead_letter_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dead_letter_queue
    ADD CONSTRAINT dead_letter_queue_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_sources entity_sources_entity_id_extraction_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_sources
    ADD CONSTRAINT entity_sources_entity_id_extraction_id_pk PRIMARY KEY (entity_id, extraction_id);


--
-- Name: exports exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_pkey PRIMARY KEY (id);


--
-- Name: extractions extractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extractions
    ADD CONSTRAINT extractions_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);


--
-- Name: raw_pages raw_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_pages
    ADD CONSTRAINT raw_pages_pkey PRIMARY KEY (id);


--
-- Name: schemas schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schemas
    ADD CONSTRAINT schemas_pkey PRIMARY KEY (id);


--
-- Name: source_trust source_trust_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust
    ADD CONSTRAINT source_trust_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: user_tenants user_tenants_user_id_tenant_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tenants
    ADD CONSTRAINT user_tenants_user_id_tenant_id_pk PRIMARY KEY (user_id, tenant_id);


--
-- Name: actions_job_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX actions_job_created_idx ON public.actions USING btree (job_id, created_at);


--
-- Name: actions_job_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX actions_job_status_idx ON public.actions USING btree (job_id, status);


--
-- Name: actions_job_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX actions_job_type_idx ON public.actions USING btree (job_id, type);


--
-- Name: crawl_tasks_job_depth_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crawl_tasks_job_depth_idx ON public.crawl_tasks USING btree (job_id, depth);


--
-- Name: crawl_tasks_job_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crawl_tasks_job_status_idx ON public.crawl_tasks USING btree (job_id, status);


--
-- Name: crawl_tasks_url_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crawl_tasks_url_idx ON public.crawl_tasks USING btree (url);


--
-- Name: dlq_queue_failed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dlq_queue_failed_idx ON public.dead_letter_queue USING btree (queue_name, failed_at);


--
-- Name: dlq_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dlq_tenant_idx ON public.dead_letter_queue USING btree (tenant_id);


--
-- Name: entities_categories_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_categories_gin_idx ON public.entities USING gin (categories);


--
-- Name: entities_job_quality_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_job_quality_idx ON public.entities USING btree (job_id, quality_score, id);


--
-- Name: exports_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exports_job_idx ON public.exports USING btree (job_id);


--
-- Name: exports_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exports_tenant_idx ON public.exports USING btree (tenant_id);


--
-- Name: extractions_job_schema_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extractions_job_schema_idx ON public.extractions USING btree (job_id, schema_version);


--
-- Name: extractions_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extractions_page_idx ON public.extractions USING btree (page_id);


--
-- Name: idx_actions_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_updated ON public.actions USING btree (updated_at);


--
-- Name: idx_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_api_keys_hash ON public.api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: idx_audit_action_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_action_time ON public.audit_log USING btree (action, created_at);


--
-- Name: idx_audit_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_tenant_time ON public.audit_log USING btree (tenant_id, created_at);


--
-- Name: idx_entities_job_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_job_tenant ON public.entities USING btree (job_id, tenant_id);


--
-- Name: idx_entities_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_updated ON public.entities USING btree (updated_at);


--
-- Name: idx_exports_job_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exports_job_tenant ON public.exports USING btree (job_id, tenant_id);


--
-- Name: idx_exports_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exports_updated ON public.exports USING btree (updated_at);


--
-- Name: idx_extractions_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extractions_job ON public.extractions USING btree (job_id, tenant_id);


--
-- Name: idx_extractions_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extractions_updated ON public.extractions USING btree (updated_at);


--
-- Name: idx_llm_usage_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_usage_job ON public.llm_usage USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: idx_llm_usage_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_usage_tenant_time ON public.llm_usage USING btree (tenant_id, created_at);


--
-- Name: idx_user_tenants_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_tenants_owner ON public.user_tenants USING btree (user_id) WHERE ((role)::text = 'owner'::text);


--
-- Name: idx_user_tenants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tenants_user ON public.user_tenants USING btree (user_id);


--
-- Name: jobs_tenant_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_tenant_created_idx ON public.jobs USING btree (tenant_id, created_at);


--
-- Name: jobs_tenant_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_tenant_status_idx ON public.jobs USING btree (tenant_id, status);


--
-- Name: raw_pages_content_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_pages_content_hash_idx ON public.raw_pages USING btree (content_hash);


--
-- Name: raw_pages_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_pages_task_idx ON public.raw_pages USING btree (task_id);


--
-- Name: schemas_job_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schemas_job_version_idx ON public.schemas USING btree (job_id, version);


--
-- Name: source_trust_job_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_trust_job_domain_idx ON public.source_trust USING btree (job_id, domain);


--
-- Name: source_trust_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_trust_tenant_idx ON public.source_trust USING btree (tenant_id);


--
-- Name: actions actions_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: actions actions_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: api_keys api_keys_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: audit_log audit_log_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: crawl_tasks crawl_tasks_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_tasks
    ADD CONSTRAINT crawl_tasks_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: crawl_tasks crawl_tasks_parent_task_id_crawl_tasks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_tasks
    ADD CONSTRAINT crawl_tasks_parent_task_id_crawl_tasks_id_fk FOREIGN KEY (parent_task_id) REFERENCES public.crawl_tasks(id);


--
-- Name: crawl_tasks crawl_tasks_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_tasks
    ADD CONSTRAINT crawl_tasks_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: dead_letter_queue dead_letter_queue_spatula_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dead_letter_queue
    ADD CONSTRAINT dead_letter_queue_spatula_job_id_jobs_id_fk FOREIGN KEY (spatula_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: dead_letter_queue dead_letter_queue_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dead_letter_queue
    ADD CONSTRAINT dead_letter_queue_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: entities entities_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: entities entities_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: entity_sources entity_sources_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_sources
    ADD CONSTRAINT entity_sources_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_sources entity_sources_extraction_id_extractions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_sources
    ADD CONSTRAINT entity_sources_extraction_id_extractions_id_fk FOREIGN KEY (extraction_id) REFERENCES public.extractions(id);


--
-- Name: exports exports_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: exports exports_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: extractions extractions_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extractions
    ADD CONSTRAINT extractions_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: extractions extractions_page_id_raw_pages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extractions
    ADD CONSTRAINT extractions_page_id_raw_pages_id_fk FOREIGN KEY (page_id) REFERENCES public.raw_pages(id);


--
-- Name: extractions extractions_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extractions
    ADD CONSTRAINT extractions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: jobs jobs_schema_id_schemas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_schema_id_schemas_id_fk FOREIGN KEY (schema_id) REFERENCES public.schemas(id);


--
-- Name: jobs jobs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: llm_usage llm_usage_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: llm_usage llm_usage_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: raw_pages raw_pages_task_id_crawl_tasks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_pages
    ADD CONSTRAINT raw_pages_task_id_crawl_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.crawl_tasks(id);


--
-- Name: raw_pages raw_pages_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_pages
    ADD CONSTRAINT raw_pages_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: schemas schemas_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schemas
    ADD CONSTRAINT schemas_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: schemas schemas_parent_id_schemas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schemas
    ADD CONSTRAINT schemas_parent_id_schemas_id_fk FOREIGN KEY (parent_id) REFERENCES public.schemas(id);


--
-- Name: schemas schemas_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schemas
    ADD CONSTRAINT schemas_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: source_trust source_trust_job_id_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust
    ADD CONSTRAINT source_trust_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: source_trust source_trust_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust
    ADD CONSTRAINT source_trust_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: user_tenants user_tenants_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tenants
    ADD CONSTRAINT user_tenants_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
--



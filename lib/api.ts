export type UserRole = "owner" | "admin" | "analyst" | "viewer";

export type PlatformAdmin = {
  campaigns_owner?: boolean;
  id: string;
  email: string;
  full_name: string;
  status: "active" | "suspended" | string;
};

export type PlatformOrganization = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | string;
  plan_code: string | null;
  onboarding_status: "started" | "profile_incomplete" | "ready" | "blocked" | string;
  created_at: string;
  user_count: number;
  active_user_count: number;
  subscription_status: string | null;
  founder_number: number | null;
  current_period_end: string | null;
  owner_email: string | null;
  owner_name: string | null;
};

export type PlatformOverview = {
  organizations: { total: number; active: number; suspended: number; onboarding_pending: number };
  users: { total: number; active: number };
  subscriptions: Array<{ status: string; total: number }>;
  founders: { assigned: number; available: number; confirmed?: number; reserved?: number };
  services: Array<{ service_name: string; status: string; checked_at: string }>;
  workflow_runs: Array<{ status: string; total: number }>;
  audit: Array<{ id: string; action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown>; created_at: string }>;
};

export type User = {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: "active" | "invited" | "suspended" | string;
};

export type TeamUser = Omit<User, "organization_id"> & {
  last_login_at: string | null;
  created_at: string;
  updated_at?: string;
};

export type OpportunityStage = "watching" | "reviewing" | "preparing" | "submitted" | "dismissed";

export type ProcessScheduleDate = { value: string; precision: "date" | "datetime" };
export type ProcessSchedule = {
  code: string; label: string; tone: "amber" | "teal" | "sky" | "violet" | "slate" | "rose";
  later_stage: boolean; deadline: ProcessScheduleDate | null; deadline_label: string;
  interest_deadline: ProcessScheduleDate | null;
  milestones: Array<ProcessScheduleDate & { kind: string; label: string }>;
  source: string; source_url: string | null; source_link_kind: "process" | "search"; message: string;
};

export type Opportunity = {
  id: string;
  process_id: string;
  secop_process_id?: string;
  reference: string | null;
  entity_name: string | null;
  entity_nit?: string | null;
  department: string | null;
  city: string | null;
  process_name: string | null;
  description?: string | null;
  procurement_method?: string | null;
  contract_type?: string | null;
  base_price: string | number | null;
  publication_date?: string | null;
  response_deadline: string | null;
  schedule?: ProcessSchedule;
  phase?: string | null;
  summary_status?: string | null;
  process_status?: string | null;
  process_url: string | null;
  match_score: string | number;
  match_status: string;
  ai_compatibility_score?: string | number | null;
  ai_decision?: string | null;
  compatibility?: { score: number; summary: string; recommendation: string; disclaimer: string; strengths: string[]; gaps: string[]; criteria: { label: string; weight: number; earned: number; configured: boolean }[] } | null;
  matched_reasons?: Record<string, unknown> | unknown[] | null;
  last_matched_at?: string;
  stage: OpportunityStage;
  is_favorite: boolean;
  notes: string | null;
};

export type Requirement = {
  id: string;
  requirement_code?: string | null;
  requirement_category: string;
  requirement_name: string;
  normalized_document_type: string | null;
  requirement_description: string | null;
  mandatory: boolean;
  condition_text: string | null;
  maximum_age_days: number | null;
  requires_signature: boolean;
  requires_entity_template: boolean;
  requires_original: boolean;
  requires_notarization: boolean;
  requires_translation: boolean;
  applies_to: string | null;
  source_page: number | null;
  source_section: string | null;
  evidence_text: string | null;
  confidence_score: string | number | null;
  status: string;
  risk_level?: string | null;
  due_at?: string | null;
  requirement_stage?: string | null;
  is_bid_requirement?: boolean;
  document_name: string | null;
  organization_document_id: string | null;
  organization_document_name: string | null;
  organization_document_expiry: string | null;
  document_match_status: string | null;
  document_match_score: string | number | null;
  document_match_reason: string | null;
};

export type OpportunitySourceDocument = {
  id: string;
  document_name: string;
  primary_category: string | null;
  source_file_extension: string | null;
  source_download_url: string | null;
  source_file_size_bytes: string | number | null;
  relevant_for_analysis: boolean;
  download_status: string;
  extraction_status: string;
  ai_requirement_status: string;
  ai_requirement_count: number | null;
};

export type OrganizationDocument = {
  document_type_label?: string | null;
  metadata_status?: string | null;
  expiration_source?: string | null;
  metadata_issues?: string[];
  id: string;
  document_type: string;
  document_name: string;
  original_filename: string | null;
  description: string | null;
  storage_url: string | null;
  mime_type: string | null;
  file_size_bytes: string | number | null;
  issue_date: string | null;
  expiry_date: string | null;
  status: string;
  verification_status: string | null;
  extraction_status: string | null;
  review_status?: string | null;
  extraction_confidence?: string | number | null;
  ocr_status?: string | null;
  ocr_provider?: string | null;
  malware_scan_status?: string | null;
  encryption_version?: string | null;
  policy_validity_days: number | null;
  alert_days_before: number | null;
  renewal_status?: string | null;
  validity_status: "valid" | "expiring" | "expired" | "unknown";
};

export type SignatureProfile = {
  id: string;
  signer_name: string;
  signer_role: string | null;
  signature_kind: "drawn" | "uploaded";
  mime_type: "image/png" | "image/jpeg" | string;
  file_size_bytes: string | number;
  file_hash_sha256: string;
  consent_version: string;
  consented_at: string;
  created_at: string;
  updated_at: string;
  preview_url: string;
};

export type ProposalPackage = {
  id: string;
  process_id: string;
  title: string;
  status: "queued" | "drafting" | "rendering" | "ready" | "needs_review" | "failed" | "cancelled";
  include_electronic_signature: boolean;
  review_required: boolean;
  generation_mode: string;
  storage_url: string | null;
  mime_type: string | null;
  file_size_bytes: string | number | null;
  file_hash_sha256: string | null;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
};

export type MaterializedDocumentAlert = {
  id: string;
  organization_document_id: string;
  alert_type: "expiring" | "expired" | "missing_date" | "review_required";
  severity: "info" | "warning" | "critical";
  status: "open" | "read" | "resolved" | "dismissed";
  title: string;
  message: string;
  due_date: string | null;
  first_triggered_at: string;
  last_triggered_at: string;
  read_at: string | null;
  document_name: string;
  document_type: string;
  issue_date: string | null;
  expiry_date: string | null;
};

export type AlertDigest = {
  id: string;
  digest_date: string;
  status: "queued" | "ready" | "fallback" | "failed";
  headline: string;
  summary_text: string;
  recommended_actions: string[];
  source_snapshot: Record<string, unknown>;
  model_provider: string | null;
  model_name: string | null;
  generated_at: string;
};

export type WorkflowRun = {
  id: string;
  workflow_code: string;
  source_code: string | null;
  n8n_execution_id: string | null;
  trigger_type: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  records_read: string | number | null;
  records_written: string | number | null;
  completion_reason: string | null;
  error_message: string | null;
};

export type WorkflowReadiness = {
  online: boolean;
  can_start: boolean;
  base_connection_ready: boolean;
  pipeline_ready: boolean;
  inventory_verified: boolean;
  database_ready: boolean;
  webhook_configured: boolean;
  document_webhook_configured: boolean;
  proposal_webhook_configured: boolean;
  chat_webhook_configured: boolean;
  ocr_webhook_configured: boolean;
  stages: Array<{
    code: string;
    name: string;
    status: "active" | "inactive" | "missing" | "unverified";
  }>;
  support_workflows: Array<{
    code: string;
    name: string;
    status: "active" | "inactive" | "missing" | "unverified";
  }>;
  missing_database_objects: string[];
  configuration_problems: string[];
};

export type OrganizationPreferences = {
  notification_email: string | null;
  minimum_match_score: string | number;
  default_departments: string[];
  notify_new_matches: boolean;
  notify_deadlines: boolean;
  daily_digest: boolean;
  updated_at: string | null;
};

export type Account = {
  organization: {
    id: string;
    name: string;
    legal_name: string;
    slug: string | null;
    status: string;
    tax_id: string | null;
    city: string | null;
    department: string | null;
    website: string | null;
    representative_name?: string | null;
    organization_type: "unconfirmed" | "legal_entity" | "natural_person" | "consortium" | "temporary_union" | "nonprofit" | "other";
  };
  organization_type_suggestion: {
    document_id: string;
    document_name: string;
    organization_type: "legal_entity" | "natural_person" | "consortium" | "temporary_union" | "nonprofit" | "other";
    confidence: string | number | null;
  } | null;
  capability_profile: {
    matrix_field_modes?:Record<string,string>;
    automatic_profile?:{unspsc_status?:string;unspsc_suggestions?:Array<{code:string;label:string;reason:string}>;message:string;missing_fields:string[];document_ids:string[]};
    id: string;
    name: string;
    profile_version: string | number | null;
    is_active: boolean;
    is_ready_for_ai: boolean;
    sectors: string[];
    company_summary: string | null;
    experience_summary: string | null;
    products_services: string[];
    unspsc_codes: string[];
    service_departments: string[];
    procurement_methods: string[];
    contract_types: string[];
    minimum_contract_value: string | number | null;
    maximum_contract_value: string | number | null;
    years_experience: string | number | null;
    updated_at: string | null;
  } | null;
  search_profiles: Array<{
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    departments: string[];
    keywords: string[];
    excluded_keywords: string[];
    procurement_methods: string[];
    process_statuses: string[];
    cities: string[];
    contract_types: string[];
    keywords_all: string[];
    unspsc_codes: string[];
    minimum_budget: string | number | null;
    maximum_budget: string | number | null;
    only_open: boolean;
    updated_at: string | null;
  }>;
  preferences: OrganizationPreferences;
  onboarding: {
    organization_complete: boolean;
    capability_ready: boolean;
    active_search_profiles: number;
    ready_for_matching: boolean;
  };
};

export type Session = {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
};

export type ChatThread = {
  id: string;
  title: string;
  status: "active" | "archived";
  context_mode: "organization" | "opportunity" | "documents" | "market";
  process_id: string | null;
  process_reference?: string | null;
  process_name?: string | null;
  last_message_at: string | null;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "queued" | "ready" | "failed" | "blocked";
  citations: Array<{ title: string; url?: string; process_id?: string }>;
  model_provider?: string | null;
  model_name?: string | null;
  error_message?: string | null;
  created_at: string;
};

export type MarketMetric = {
  name: string;
  amount_cop: string | number;
  processes: number;
  payers: number;
  cities?: number;
  nit?: string | null;
  latest_publication?: string | null;
};

export type MarketSnapshot = {
  period: { from: string; to: string };
  national: { amount_cop: string | number; processes: number; payers: number; departments: number };
  departments: MarketMetric[];
  trend: Array<{ month: string; amount_cop: string | number; processes: number }>;
  top_payers: MarketMetric[];
  metric_definition: string;
};

export type SubscriptionPlan = {
  code: string;
  name: string;
  description: string;
  amount_cop: string | number;
  billing_interval: "monthly";
  protected_price_months: number | null;
  customer_limit: number | null;
  features: Record<string, boolean>;
};

export type BillingOrder = {
  marketing_is_test?: boolean;
  provider_status?: string;
  provider_checked_at?: string;
  id: string;
  reference: string;
  plan_code: string;
  billing_reason: string;
  amount_cop: string | number;
  currency: "COP";
  founder_number: number | null;
  status: string;
  checkout_url: string | null;
  expires_at: string | null;
  approved_at: string | null;
  created_at: string;
};

export type BillingOverview = {
  tracking_started_at?: string;
  plans: SubscriptionPlan[];
  subscription: null | {
    id: string;
    plan_code: string;
    plan_name: string;
    status: string;
    founder_number: number | null;
    founder_price_ends_at: string | null;
    current_period_end: string | null;
    next_payment_due_at: string | null;
    paid_cycles: number;
    can_renew: boolean;
  };
  orders: BillingOrder[];
  founders: { assigned: number; available: number; confirmed?: number; reserved?: number };
  gateway: { provider: "bold"; configured: boolean; environment: "test" | "production" };
};

export type DocumentTemplate = {
  id: string;
  version_id: string;
  name: string;
  description: string | null;
  template_type: "docx" | "pdf_form" | "xlsx";
  scope: string;
  status: string;
  original_filename: string;
  file_size_bytes: string | number;
  field_schema: Array<{ name: string; type: string; required: boolean }>;
  field_mapping: Record<string, string>;
  updated_at: string;
};

export type GeneratedTemplateDocument = {
  id: string;
  template_version_id: string;
  template_id: string;
  process_id: string | null;
  status: string;
  validation_issues: Array<{ field: string; code: string }>;
  storage_url: string | null;
  mime_type: string | null;
  file_size_bytes: string | number | null;
  generated_at: string | null;
  created_at: string;
  template_name: string;
  process_reference: string | null;
};

export type OperationsSummary = {
  services: Record<string, { status?: string; configured?: boolean; email?: boolean; whatsapp?: boolean; detail?: unknown }>;
  workflows: Array<{ status: string; total: number }>;
  quota: Array<{ outcome: string; total: number; daily_used: number | null; daily_limit: number | null }>;
  notifications: Array<{ status: string; total: number }>;
  billing: Array<{ status: string; total: number }>;
  dead_letters: Array<{ id: string; job_type: string; status: string; last_error: string; attempt_count: number; created_at: string }>;
  checked_at: string;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let csrfToken = "";

function isMutation(method = "GET") {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

async function getCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch("/api/auth/csrf", { credentials: "include", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.csrfToken) {
    throw new ApiError(data.error ?? "No fue posible iniciar la validación segura.", response.status);
  }
  csrfToken = String(data.csrfToken);
  return csrfToken;
}

export function resetApiSecurityState() {
  csrfToken = "";
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const url = path.startsWith("/api") ? path : `/api${path}`;
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  const body = options.body;

  if (body && typeof body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (isMutation(method)) headers.set("x-csrf-token", await getCsrfToken(retried));

  const response = await fetch(url, {
    ...options,
    method,
    body,
    headers,
    credentials: "include",
    cache: options.cache ?? "no-store",
  });

  if (response.status === 403 && isMutation(method) && !retried) {
    csrfToken = "";
    return apiFetch<T>(path, options, true);
  }
  if (
    response.status === 401
    && typeof window !== "undefined"
    && !url.includes("/auth/login")
    && !url.includes("/auth/password-reset")
  ) {
    window.dispatchEvent(new Event("cernoia:unauthorized"));
  }
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : { error: await response.text().catch(() => "") };
  if (!response.ok) throw new ApiError(data.error ?? "No fue posible completar la solicitud.", response.status);
  if (data.csrfToken) csrfToken = String(data.csrfToken);
  return data as T;
}

export async function uploadOrganizationDocument(
  file: File,
  metadata: {
    name: string;
    type: string;
    description?: string;
    issueDate?: string;
    expiryDate?: string;
  },
) {
  const parameters = new URLSearchParams({
    filename: file.name,
    name: metadata.name,
    type: metadata.type,
  });
  if (metadata.description) parameters.set("description", metadata.description);
  if (metadata.issueDate) parameters.set("issueDate", metadata.issueDate);
  if (metadata.expiryDate) parameters.set("expiryDate", metadata.expiryDate);
  return apiFetch<{ document: OrganizationDocument; automation_queued: boolean }>(
    `/documents/upload?${parameters.toString()}`,
    { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } },
  );
}

export async function uploadSignatureProfile(
  file: Blob,
  metadata: {
    filename: string;
    signerName: string;
    signerRole: string;
    kind: "drawn" | "uploaded";
  },
) {
  const parameters = new URLSearchParams({
    filename: metadata.filename,
    signerName: metadata.signerName,
    signerRole: metadata.signerRole,
    kind: metadata.kind,
    consent: "true",
  });
  return apiFetch<{ signature: SignatureProfile }>(
    `/signature-profile?${parameters.toString()}`,
    { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } },
  );
}

export async function uploadDocumentTemplate(
  file: File,
  metadata: { name: string; description?: string; scope?: string; entityNit?: string; processId?: string },
) {
  const parameters = new URLSearchParams({
    filename: file.name,
    name: metadata.name,
    scope: metadata.scope ?? "organization",
  });
  if (metadata.description) parameters.set("description", metadata.description);
  if (metadata.entityNit) parameters.set("entityNit", metadata.entityNit);
  if (metadata.processId) parameters.set("processId", metadata.processId);
  return apiFetch<{ template: DocumentTemplate }>(
    `/templates/upload?${parameters.toString()}`,
    { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } },
  );
}

export async function downloadBidZip(processId:string,body:Record<string,unknown>) {
  let response=await fetch(`/api/bids/processes/${encodeURIComponent(processId)}/export`,{method:"POST",credentials:"include",headers:{"content-type":"application/json","x-csrf-token":await getCsrfToken()},body:JSON.stringify(body)});
  if(response.status===403)response=await fetch(`/api/bids/processes/${encodeURIComponent(processId)}/export`,{method:"POST",credentials:"include",headers:{"content-type":"application/json","x-csrf-token":await getCsrfToken(true)},body:JSON.stringify(body)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||"No fue posible descargar el paquete.");}
  const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`oferta-${processId.slice(0,8)}.zip`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}

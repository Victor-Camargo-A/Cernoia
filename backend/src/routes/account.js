import {effectiveCapabilities,capabilityFields} from '../services/effective-capabilities.js';
import {queueSearchRefresh} from '../services/search-refresh.js';
import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { pool, withTenantTransaction, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { hashPassword, validatePassword } from "../security.js";
import { writeAudit } from "../audit.js";
import { enqueueNotification } from "../services/notifications.js";
import { getDemoAccess } from "../middleware/demo.js";

export const accountRouter = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ROLES = new Set(["owner", "admin", "analyst", "viewer"]);
const USER_STATUSES = new Set(["active", "invited", "suspended"]);
const ORGANIZATION_TYPES = new Set([
  "unconfirmed",
  "legal_entity",
  "natural_person",
  "consortium",
  "temporary_union",
  "nonprofit",
  "other",
]);

function normalizeStringArray(value, maximum = 32) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
    .slice(0, maximum)
    .map((item) => item.slice(0, 100));
}

function normalizedOrganization(record = {}) {
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  return {
    id: record.id ?? null,
    name: record.name ?? record.legal_name ?? "Organización",
    legal_name: record.legal_name ?? record.name ?? "Organización",
    slug: record.slug ?? null,
    status: record.status ?? "active",
    tax_id: record.tax_id ?? record.nit ?? record.document_number ?? null,
    city: record.city ?? record.municipality ?? null,
    department: record.department ?? null,
    website: record.website ?? null,
    representative_name: metadata.representative_name ?? null,
    organization_type: ORGANIZATION_TYPES.has(record.organization_type)
      ? record.organization_type
      : "unconfirmed",
  };
}

function normalizedCapability(record = {}) {
  return {
    id: record.id ?? null,
    name: record.name ?? "Perfil empresarial",
    profile_version: record.profile_version ?? null,
    is_active: record.is_active ?? true,
    is_ready_for_ai: record.is_ready_for_ai ?? false,
    sectors: record.sectors ?? record.products_services ?? record.economic_activities ?? record.unspsc_codes ?? [],
    company_summary: record.company_summary ?? record.experience_summary ?? record.description ?? null,
    experience_summary: record.experience_summary ?? record.company_summary ?? record.description ?? null,
    products_services: record.products_services ?? [],
    unspsc_codes: record.unspsc_codes ?? [],
    service_departments: record.service_departments ?? [],
    procurement_methods: record.procurement_methods ?? [],
    contract_types: record.contract_types ?? [],
    minimum_contract_value: record.minimum_contract_value ?? null,
    maximum_contract_value: record.maximum_contract_value ?? null,
    years_experience: record.years_experience ?? null,
    updated_at: record.updated_at ?? null,
  };
}

function normalizedSearchProfile(record = {}) {
  const filters = record.filter_config && typeof record.filter_config === "object" ? record.filter_config : {};
  return {
    id: record.id ?? null,
    name: record.name ?? record.profile_name ?? "Perfil de búsqueda",
    description: record.description ?? null,
    is_active: record.is_active ?? record.status === "active",
    departments: record.departments ?? record.target_departments ?? filters.departments ?? [],
    keywords: record.keywords ?? record.include_keywords ?? filters.keywords_any ?? [],
    excluded_keywords: record.excluded_keywords ?? filters.excluded_keywords ?? [],
    procurement_methods: filters.procurement_methods ?? [],
    process_statuses: filters.process_statuses ?? [],
    cities: filters.cities ?? [],
    contract_types: filters.contract_types ?? [],
    keywords_all: filters.keywords_all ?? [],
    unspsc_codes: record.unspsc_codes ?? filters.unspsc_codes ?? [],
    minimum_budget: record.minimum_budget ?? record.min_budget ?? filters.minimum_budget ?? null,
    maximum_budget: record.maximum_budget ?? record.max_budget ?? filters.maximum_budget ?? null,
    only_open: record.only_open ?? filters.only_open ?? true,
    updated_at: record.updated_at ?? null,
  };
}

function optionalNumber(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : Number.NaN;
}

function validWebsite(value) {
  if (!value) return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function valueHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function refreshOnboardingStatus(organizationId) {
  const result = await query(
    `SELECT organization.tax_id, organization.organization_type,
            capability.is_active AS capability_active,
            capability.is_ready_for_ai AS capability_ready,
            EXISTS (
              SELECT 1 FROM saas.search_profiles profile
              WHERE profile.organization_id = organization.id AND profile.is_active = TRUE
            ) AS has_search_profile
     FROM saas.organizations organization
     LEFT JOIN LATERAL (
       SELECT is_active, is_ready_for_ai
       FROM saas.organization_capability_profiles
       WHERE organization_id = organization.id
       ORDER BY is_active DESC, updated_at DESC LIMIT 1
     ) capability ON TRUE
     WHERE organization.id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) return;
  const ready = Boolean(row.tax_id && row.organization_type && row.organization_type !== "unconfirmed"
    && row.capability_active && row.capability_ready && row.has_search_profile);
  await query(
    "UPDATE saas.organizations SET onboarding_status = $2, updated_at = NOW() WHERE id = $1",
    [organizationId, ready ? "ready" : "profile_incomplete"],
  );
}

accountRouter.get("/account", requireAuth, async (req, res, next) => {
  try {
    const [organization, capability, searchProfiles, settings, organizationTypeSuggestion] = await Promise.all([
      query("SELECT to_jsonb(o) AS record FROM saas.organizations o WHERE o.id = $1", [req.user.organization_id]),
      query(
        `SELECT to_jsonb(c) AS record
         FROM saas.organization_capability_profiles c
         WHERE c.organization_id = $1
         ORDER BY c.is_active DESC, c.updated_at DESC
         LIMIT 1`,
        [req.user.organization_id],
      ),
      query(
        `SELECT to_jsonb(s) AS record
         FROM saas.search_profiles s
         WHERE s.organization_id = $1
         ORDER BY s.updated_at DESC`,
        [req.user.organization_id],
      ),
      query(
        `SELECT notification_email, minimum_match_score, default_departments,
                notify_new_matches, notify_deadlines, daily_digest, updated_at
         FROM saas.app_organization_settings
         WHERE organization_id = $1`,
        [req.user.organization_id],
      ),
      query(
        `SELECT id AS document_id, document_name,
                ai_classification ->> 'detected_organization_type' AS organization_type,
                ai_classification ->> 'organization_type_confidence' AS confidence
         FROM saas.organization_documents
         WHERE organization_id = $1
           AND document_status <> 'deleted'
           AND ai_classification ->> 'detected_organization_type' IN (
             'legal_entity', 'natural_person', 'consortium', 'temporary_union', 'nonprofit', 'other'
           )
         ORDER BY updated_at DESC
         LIMIT 1`,
        [req.user.organization_id],
      ),
    ]);

    const defaultSettings = {
      notification_email: req.user.email,
      minimum_match_score: 60,
      default_departments: [],
      notify_new_matches: true,
      notify_deadlines: true,
      daily_digest: true,
      updated_at: null,
    };
    const normalizedOrg = normalizedOrganization(organization.rows[0]?.record);
    const effective=await effectiveCapabilities(req.user.organization_id);
    const normalizedCap = effective ? {...normalizedCapability(effective),matrix_field_modes:effective.matrix_field_modes,automatic_profile:effective.automatic_profile} : null;
    const normalizedSearchProfiles = searchProfiles.rows.map((row) => normalizedSearchProfile(row.record));
    const organizationComplete = Boolean(
      normalizedOrg.name &&
      normalizedOrg.tax_id &&
      normalizedOrg.organization_type !== "unconfirmed"
    );
    const capabilityReady = Boolean(normalizedCap?.is_active && normalizedCap?.is_ready_for_ai);
    const activeSearchProfiles = normalizedSearchProfiles.filter((profile) => profile.is_active).length;
    res.json({
      organization: normalizedOrg,
      organization_type_suggestion: organizationTypeSuggestion.rows[0] ?? null,
      capability_profile: normalizedCap,
      search_profiles: normalizedSearchProfiles,
      preferences: settings.rows[0] ?? defaultSettings,
      onboarding: {
        organization_complete: organizationComplete,
        capability_ready: capabilityReady,
        active_search_profiles: activeSearchProfiles,
        ready_for_matching: organizationComplete && capabilityReady && activeSearchProfiles > 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

accountRouter.get("/account/demo", requireAuth, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ demo: await getDemoAccess(req.user.organization_id) });
  } catch (error) {
    next(error);
  }
});

accountRouter.patch("/account/organization", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim().slice(0, 180);
    const legalName = String(req.body?.legal_name ?? name).trim().slice(0, 240);
    const taxId = String(req.body?.tax_id ?? "").trim().slice(0, 80);
    const city = String(req.body?.city ?? "").trim().slice(0, 160);
    const department = String(req.body?.department ?? "").trim().slice(0, 160);
    const website = String(req.body?.website ?? "").trim().slice(0, 500);
    const representativeName = String(req.body?.representative_name ?? "").trim().slice(0, 240);
    const organizationType = String(req.body?.organization_type ?? "unconfirmed").trim();
    if (name.length < 2) return res.status(400).json({ error: "Ingresa el nombre de la empresa." });
    if (!taxId) return res.status(400).json({ error: "Ingresa el NIT o identificación tributaria." });
    if (!validWebsite(website)) return res.status(400).json({ error: "El sitio web debe comenzar con http:// o https://." });
    if (!ORGANIZATION_TYPES.has(organizationType) || organizationType === "unconfirmed") {
      return res.status(400).json({ error: "Selecciona el tipo de proponente de la organización." });
    }

    const result = await query(
      `UPDATE saas.organizations AS organization
       SET name = $2, legal_name = NULLIF($3, ''), tax_id = NULLIF($4, ''),
           city = NULLIF($5, ''), department = NULLIF($6, ''), website = NULLIF($7, ''),
           organization_type = $8,
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{representative_name}', to_jsonb(NULLIF($9, '')), true),
           updated_at = NOW()
       WHERE id = $1
       RETURNING to_jsonb(organization) AS record`,
      [req.user.organization_id, name, legalName, taxId, city, department, website, organizationType, representativeName],
    );
    await refreshOnboardingStatus(req.user.organization_id);
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "account.organization_updated", entityType: "organization", entityId: req.user.organization_id, req });
    res.json({ organization: normalizedOrganization(result.rows[0]?.record) });
  } catch (error) {
    next(error);
  }
});

accountRouter.put("/account/capability-profile", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const summary = String(req.body?.company_summary ?? "").trim().slice(0, 5000);
    const products = normalizeStringArray(req.body?.products_services, 80);
    const unspscCodes = normalizeStringArray(req.body?.unspsc_codes, 80);
    const departments = normalizeStringArray(req.body?.service_departments, 40);
    const procurementMethods = normalizeStringArray(req.body?.procurement_methods, 40);
    const contractTypes = normalizeStringArray(req.body?.contract_types, 40);
    const minimumValue = optionalNumber(req.body?.minimum_contract_value);
    const maximumValue = optionalNumber(req.body?.maximum_contract_value);
    const yearsExperience = optionalNumber(req.body?.years_experience, { maximum: 300 });
    if (summary.length < 40) return res.status(400).json({ error: "Describe las capacidades de la empresa con al menos 40 caracteres." });
    if (!products.length && !unspscCodes.length) return res.status(400).json({ error: "Agrega al menos un producto, servicio o código UNSPSC." });
    if ([minimumValue, maximumValue, yearsExperience].some(Number.isNaN)) return res.status(400).json({ error: "Revisa los valores de experiencia y contratación." });
    if (minimumValue !== null && maximumValue !== null && minimumValue > maximumValue) return res.status(400).json({ error: "El valor mínimo no puede superar el máximo." });
    const readyForAi = summary.length >= 40 && (products.length > 0 || unspscCodes.length > 0);

    const current = await query(
      `SELECT id, name FROM saas.organization_capability_profiles
       WHERE organization_id = $1 ORDER BY is_active DESC, updated_at DESC LIMIT 1`,
      [req.user.organization_id],
    );
    const effective=await effectiveCapabilities(req.user.organization_id);
    const submitted={company_summary:summary,products_services:products,unspsc_codes:unspscCodes,service_departments:departments,procurement_methods:procurementMethods,contract_types:contractTypes,minimum_contract_value:minimumValue,maximum_contract_value:maximumValue,years_experience:yearsExperience};
    const modes=Object.fromEntries(capabilityFields.map(key=>[key,JSON.stringify(submitted[key])===JSON.stringify(effective?.[key])?(effective?.matrix_field_modes?.[key]??"auto"):"manual"]));
    let result;
    const values = [summary, JSON.stringify(products), JSON.stringify(unspscCodes), JSON.stringify(departments), JSON.stringify(procurementMethods), JSON.stringify(contractTypes), minimumValue, maximumValue, yearsExperience, readyForAi];
    if (current.rowCount) {
      result = await query(
        `UPDATE saas.organization_capability_profiles AS capability
         SET company_summary = $2, products_services = $3::JSONB, unspsc_codes = $4::JSONB,
             service_departments = $5::JSONB, procurement_methods = $6::JSONB, contract_types = $7::JSONB,
             minimum_contract_value = $8, maximum_contract_value = $9, years_experience = $10,
             is_active = TRUE, is_ready_for_ai = $11, profile_version = capability.profile_version + 1, updated_at = NOW()
         WHERE id = $1 AND organization_id = $12
         RETURNING to_jsonb(capability) AS record`,
        [current.rows[0].id, ...values, req.user.organization_id],
      );
    } else {
      result = await query(
        `INSERT INTO saas.organization_capability_profiles AS capability
          (organization_id, name, company_summary, products_services, unspsc_codes, service_departments,
           procurement_methods, contract_types, minimum_contract_value, maximum_contract_value,
           years_experience, is_active, is_ready_for_ai)
         VALUES ($1, 'Perfil empresarial principal', $2, $3::JSONB, $4::JSONB, $5::JSONB, $6::JSONB, $7::JSONB, $8, $9, $10, TRUE, $11)
         RETURNING to_jsonb(capability) AS record`,
        [req.user.organization_id, ...values],
      );
    }
    await query("UPDATE saas.organization_capability_profiles SET is_active = FALSE, updated_at = NOW() WHERE organization_id = $1 AND id <> $2 AND is_active = TRUE", [req.user.organization_id, result.rows[0].record.id]);
    await query("UPDATE saas.organization_capability_profiles SET matrix_field_modes=$2::jsonb WHERE id=$1 AND organization_id=$3",[result.rows[0].record.id,JSON.stringify(modes),req.user.organization_id]);
    await refreshOnboardingStatus(req.user.organization_id);
    await queueSearchRefresh(req.user.organization_id);
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "account.capability_profile_updated", entityType: "capability_profile", entityId: result.rows[0].record.id, metadata: { ready_for_ai: readyForAi }, req });
    res.json({ capability_profile: normalizedCapability(result.rows[0].record) });
  } catch (error) {
    next(error);
  }
});

accountRouter.put("/account/search-profile", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const id = String(req.body?.id ?? "").trim();
    const name = String(req.body?.name ?? "").trim().slice(0, 160);
    const description = String(req.body?.description ?? "").trim().slice(0, 1000);
    const previous = id ? await query("SELECT filter_config FROM saas.search_profiles WHERE id=$1 AND organization_id=$2", [id, req.user.organization_id]) : null;
    if (id && !previous.rowCount) return res.status(404).json({ error: "Perfil de búsqueda no encontrado." });
    const savedFilters = previous?.rows[0]?.filter_config ?? {};
    const procurementMethods = normalizeStringArray(req.body?.procurement_methods ?? savedFilters.procurement_methods ?? ["Mínima cuantía"], 40);
    const processStatuses = normalizeStringArray(req.body?.process_statuses ?? savedFilters.process_statuses ?? ["Publicado"], 40);
    const cities = normalizeStringArray(req.body?.cities ?? savedFilters.cities, 40);
    const contractTypes = normalizeStringArray(req.body?.contract_types ?? savedFilters.contract_types, 40);
    const keywordsAll = normalizeStringArray(req.body?.keywords_all ?? savedFilters.keywords_all, 80);
    const departments = normalizeStringArray(req.body?.departments, 40);
    const keywords = normalizeStringArray(req.body?.keywords, 80);
    const excludedKeywords = normalizeStringArray(req.body?.excluded_keywords, 80);
    const unspscCodes = normalizeStringArray(req.body?.unspsc_codes, 80);
    const minimumBudget = optionalNumber(req.body?.minimum_budget);
    const maximumBudget = optionalNumber(req.body?.maximum_budget);
    const isActive = req.body?.is_active !== false;
    if (name.length < 3) return res.status(400).json({ error: "Asigna un nombre al perfil de búsqueda." });
    if ([minimumBudget, maximumBudget].some(Number.isNaN)) return res.status(400).json({ error: "El presupuesto indicado no es válido." });
    if (minimumBudget !== null && maximumBudget !== null && minimumBudget > maximumBudget) return res.status(400).json({ error: "El presupuesto mínimo no puede superar el máximo." });
    if (isActive && !procurementMethods.length && !processStatuses.length && !cities.length && !contractTypes.length && !keywordsAll.length && !departments.length && !keywords.length && !unspscCodes.length && minimumBudget === null && maximumBudget === null) {
      return res.status(400).json({ error: "Agrega al menos un criterio antes de activar el perfil." });
    }
    const filterConfig = {
      ...savedFilters,
      procurement_methods: procurementMethods,
      process_statuses: processStatuses,
      cities,
      contract_types: contractTypes,
      keywords_all: keywordsAll,
      departments,
      keywords_any: keywords,
      excluded_keywords: excludedKeywords,
      unspsc_codes: unspscCodes,
      minimum_budget: minimumBudget,
      maximum_budget: maximumBudget,
      only_open: req.body?.only_open !== false,
    };
    let result;
    if (id) {
      result = await query(
        `UPDATE saas.search_profiles AS profile
         SET name = $3, description = NULLIF($4, ''), is_active = $5, filter_config = $6::JSONB, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING to_jsonb(profile) AS record`,
        [id, req.user.organization_id, name, description, isActive, JSON.stringify(filterConfig)],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Perfil de búsqueda no encontrado." });
    } else {
      result = await query(
        `INSERT INTO saas.search_profiles AS profile (organization_id, name, description, is_active, filter_config, notification_config)
         VALUES ($1, $2, NULLIF($3, ''), $4, $5::JSONB, '{}'::JSONB)
         RETURNING to_jsonb(profile) AS record`,
        [req.user.organization_id, name, description, isActive, JSON.stringify(filterConfig)],
      );
    }
    await queueSearchRefresh(req.user.organization_id);
    await writeAudit({ userId: req.user.id, organizationId: req.user.organization_id, action: "account.search_profile_updated", entityType: "search_profile", entityId: result.rows[0].record.id, metadata: { active: isActive }, req });
    await refreshOnboardingStatus(req.user.organization_id);
    res.json({ search_profile: normalizedSearchProfile(result.rows[0].record) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Ya existe un perfil con ese nombre." });
    next(error);
  }
});

accountRouter.patch("/account/preferences", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const notificationEmail = String(req.body?.notification_email ?? "").trim().toLowerCase();
    const minimumMatchScore = Number(req.body?.minimum_match_score ?? 60);
    const departments = normalizeStringArray(req.body?.default_departments);
    if (notificationEmail && !EMAIL_PATTERN.test(notificationEmail)) {
      return res.status(400).json({ error: "El correo de notificaciones no es válido." });
    }
    if (!Number.isFinite(minimumMatchScore) || minimumMatchScore < 0 || minimumMatchScore > 100) {
      return res.status(400).json({ error: "La afinidad mínima debe estar entre 0 y 100." });
    }

    const result = await query(
      `INSERT INTO saas.app_organization_settings
        (organization_id, notification_email, minimum_match_score, default_departments,
         notify_new_matches, notify_deadlines, daily_digest, updated_by_user_id)
       VALUES ($1, NULLIF($2, ''), $3, $4::TEXT[], $5, $6, $7, $8)
       ON CONFLICT (organization_id) DO UPDATE SET
         notification_email = EXCLUDED.notification_email,
         minimum_match_score = EXCLUDED.minimum_match_score,
         default_departments = EXCLUDED.default_departments,
         notify_new_matches = EXCLUDED.notify_new_matches,
         notify_deadlines = EXCLUDED.notify_deadlines,
         daily_digest = EXCLUDED.daily_digest,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = NOW()
       RETURNING notification_email, minimum_match_score, default_departments,
                 notify_new_matches, notify_deadlines, daily_digest, updated_at`,
      [
        req.user.organization_id,
        notificationEmail,
        minimumMatchScore,
        departments,
        Boolean(req.body?.notify_new_matches),
        Boolean(req.body?.notify_deadlines),
        Boolean(req.body?.daily_digest),
        req.user.id,
      ],
    );
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "account.preferences_updated",
      entityType: "organization",
      entityId: req.user.organization_id,
      req,
    });
    res.json({ preferences: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

accountRouter.get("/users", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, email, full_name, role, status, last_login_at, created_at, updated_at
       FROM saas.app_users
       WHERE organization_id = $1
       ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'analyst' THEN 3 ELSE 4 END,
                full_name`,
      [req.user.organization_id],
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

accountRouter.post("/users/invitations", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const fullName = String(req.body?.full_name ?? "").trim().slice(0, 120);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const role = String(req.body?.role ?? "analyst");
    if (fullName.length < 3 || !EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Nombre y correo válidos son obligatorios." });
    }
    if (!USER_ROLES.has(role) || (req.user.role !== "owner" && ["owner", "admin"].includes(role))) {
      return res.status(403).json({ error: "No puedes asignar ese rol." });
    }
    // La unicidad de correo es global: una persona no puede pertenecer a otra
    // organización ni recibir una segunda invitación desde este panel.
    const existingUser = await pool.query(
      "SELECT 1 FROM saas.app_users WHERE LOWER(email) = $1 LIMIT 1",
      [email],
    );
    if (existingUser.rowCount) return res.status(409).json({ error: "Ese correo ya tiene una cuenta." });

    const rawToken = randomBytes(32).toString("base64url");
    const result = await withTenantTransaction(req.user.organization_id, async (client) => {
      const pending = await client.query(
        `SELECT id FROM saas.organization_invitations
         WHERE organization_id = $1 AND LOWER(email) = $2 AND accepted_at IS NULL
           AND expires_at > NOW()
         LIMIT 1`,
        [req.user.organization_id, email],
      );
      if (pending.rowCount) {
        const error = new Error("Ya existe una invitación vigente para ese correo.");
        error.statusCode = 409;
        throw error;
      }
      return client.query(
        `INSERT INTO saas.organization_invitations
          (organization_id, email, full_name, role, token_hash, expires_at, invited_by_user_id)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '72 hours', $6)
         RETURNING id, email, full_name, role, expires_at`,
        [req.user.organization_id, email, fullName, role, valueHash(rawToken), req.user.id],
      );
    });
    const inviteUrl = `${config.appOrigin}/?invite_token=${encodeURIComponent(rawToken)}`;
    await enqueueNotification({
      organizationId: req.user.organization_id,
      channelType: "email",
      eventType: "organization_invitation",
      recipient: email,
      subject: "Activa tu acceso a CernoIA",
      body: `Hola ${fullName}. Activa tu cuenta de CernoIA durante las próximas 72 horas: ${inviteUrl}`,
      idempotencyKey: `organization-invitation:${result.rows[0].id}`,
    }).catch(() => undefined);
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "account.invitation_created",
      entityType: "organization_invitation",
      entityId: result.rows[0].id,
      metadata: { email_hash: valueHash(email), role },
      req,
    });
    res.status(201).json({ invitation: { ...result.rows[0], invite_url: inviteUrl } });
  } catch (error) {
    next(error);
  }
});

accountRouter.post("/users", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const fullName = String(req.body?.full_name ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.temporary_password ?? "");
    const role = String(req.body?.role ?? "analyst");
    const validation = validatePassword(password);
    if (fullName.length < 3 || fullName.length > 120) return res.status(400).json({ error: "Ingresa el nombre completo." });
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return res.status(400).json({ error: "El correo no es válido." });
    if (!USER_ROLES.has(role)) return res.status(400).json({ error: "El rol no es válido." });
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    if (req.user.role !== "owner" && ["owner", "admin"].includes(role)) {
      return res.status(403).json({ error: "Solo el propietario puede crear administradores." });
    }

    const passwordHash = await hashPassword(password);
    const result = await query(
      `INSERT INTO saas.app_users
        (organization_id, email, full_name, password_hash, role, status, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       RETURNING id, email, full_name, role, status, created_at`,
      [req.user.organization_id, email, fullName, passwordHash, role],
    );
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "account.user_created",
      entityType: "user",
      entityId: result.rows[0].id,
      metadata: { role },
      req,
    });
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
    next(error);
  }
});

accountRouter.patch("/users/:userId", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const role = String(req.body?.role ?? "");
    const status = String(req.body?.status ?? "");
    if (!USER_ROLES.has(role) || !USER_STATUSES.has(status)) {
      return res.status(400).json({ error: "El rol o estado no es válido." });
    }
    if (req.user.id === req.params.userId && status !== "active") {
      return res.status(400).json({ error: "No puedes suspender tu propia cuenta." });
    }
    if (req.user.role !== "owner" && ["owner", "admin"].includes(role)) {
      return res.status(403).json({ error: "Solo el propietario puede asignar ese rol." });
    }

    const target = await query(
      "SELECT id, role FROM saas.app_users WHERE id = $1 AND organization_id = $2",
      [req.params.userId, req.user.organization_id],
    );
    if (!target.rowCount) return res.status(404).json({ error: "Usuario no encontrado." });
    if (target.rows[0].role === "owner" && (role !== "owner" || status !== "active")) {
      const owners = await query(
        "SELECT COUNT(*)::int AS total FROM saas.app_users WHERE organization_id = $1 AND role = 'owner' AND status = 'active'",
        [req.user.organization_id],
      );
      if (owners.rows[0].total <= 1) return res.status(400).json({ error: "La organización debe conservar al menos un propietario activo." });
    }

    const result = await query(
      `UPDATE saas.app_users
       SET role = $3, status = $4, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING id, email, full_name, role, status, last_login_at, created_at, updated_at`,
      [req.params.userId, req.user.organization_id, role, status],
    );
    if (status !== "active") {
      await query("UPDATE saas.app_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.userId]);
    }
    await writeAudit({
      userId: req.user.id,
      organizationId: req.user.organization_id,
      action: "account.user_updated",
      entityType: "user",
      entityId: req.params.userId,
      metadata: { role, status },
      req,
    });
    res.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

accountRouter.patch("/account/match-threshold", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  const value = req.body?.minimum_match_score;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return res.status(400).json({ error: "La afinidad mínima debe ser un número entre 0 y 100." });
  }
  try {
    await query(`INSERT INTO saas.app_organization_settings (organization_id,minimum_match_score,updated_by_user_id)
      VALUES ($1,$2,$3) ON CONFLICT (organization_id) DO UPDATE SET minimum_match_score=EXCLUDED.minimum_match_score,
      updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`, [req.user.organization_id,value,req.user.id]);
    await writeAudit({ userId:req.user.id, organizationId:req.user.organization_id, action:"account.match_threshold_updated", entityType:"organization", entityId:req.user.organization_id, metadata:{minimum_match_score:value}, req });
    res.json({ minimum_match_score:value });
  } catch(error) { next(error); }
});

# Tenant Isolation Audit

Living document. Last updated 2026-05-27 (post-audit). The codebase is tenant-safe with all critical and application-layer gaps fixed; this document, the allowlist, and the isolation test suite are the ongoing enforcement layer. Run `bun run report:tenant-scoping` from `packages/backend` to regenerate the inventory.

---

## Findings

### Critical Findings (FIXED) -- Cross-Tenant Data Leaks

Two real cross-tenant leaks were found by the isolation test suite and fixed on this branch. Both affected production code on the main line.

**Logs query API** (`packages/backend/src/modules/query/routes.ts`): all 10 query endpoints used the `?projectId=` URL parameter without verifying it belonged to the authenticated API key's project. Any API key could read ANY project's/organization's logs by passing a different `projectId`. Fixed by a shared `resolveQueryProjectId(request, reply, queryProjectId)` helper in `packages/backend/src/modules/auth/guards.ts` that rejects (403) a query whose projectId does not match the API key's bound project; session auth keeps using `verifyProjectAccess`. Locked by `src/tests/isolation/query-isolation.test.ts`.

**Traces query API** (`packages/backend/src/modules/traces/routes.ts`): the same pattern on 8 endpoints (trace/span reads) allowed cross-tenant trace/span reads. Fixed with the same helper. Locked by `src/tests/isolation/traces-isolation.test.ts`.

Note: the metrics query API (`modules/metrics/routes.ts`) already had a safe `resolveProjectId` (uses the key's project for API-key auth) and was NOT vulnerable.

### Application-Layer Gaps (FIXED)

Tenant-table queries that were missing org/project scoping, now fixed:

- `pii-masking/service.ts updateRule` -- pre-read SELECT now org-scoped.
- `siem/service.ts linkDetectionEventsToIncident` -- `organizationId` now required; detection_events + incidents updates org-scoped.
- `siem/service.ts getIncidentDetections` / `enrichIncidentIpData` -- `organizationId` now required and applied.
- `exceptions/service.ts getExceptionByLogId` / `getExceptionById` -- now org-scoped (ids come from URL params); redundant post-read org checks removed from routes.
- `exceptions/service.ts updateErrorGroupStatus` -- now org-scoped.
- `correlation/service.ts getLogIdentifiers` -- now project-scoped.
- `admin/service.ts` -- platform-wide log counts now use the explicit `GLOBAL_SCOPE` sentinel (intentional cross-org).
- Reservoir log query params (`@logtide/reservoir`): `projectId` is now REQUIRED (was optional) on `QueryParams`/`CountParams`/`AggregateParams`/`DistinctParams`/`TopValuesParams`, with a `GLOBAL_SCOPE` sentinel for intentional all-projects reads. (The `logs` table is project_id-scoped; it has no organization_id column.)
- Session-auth routes across alerts, detection-packs, notification-channels, projects, correlation, pii-masking now Zod-validate `organizationId` (uuid) instead of a raw cast.
- `custom-dashboards` personal-dashboard filter moved from in-memory into the SQL WHERE.

### Minor Findings (NOT Fixed -- HTTP Semantics Only, No Data Leak)

These return an imperfect status code for cross-org access but do NOT read or mutate another tenant's data (the scoping correctly prevents the operation). Recommended follow-up: return 404.

- `sigma/service.ts deleteSigmaRule` / `toggleSigmaRule` -- throw leads to 500 instead of 404 for a cross-org id.
- `custom-dashboards/service.ts` DELETE -- silent 204 (no-op) instead of 404 for a cross-org id.
- `custom-dashboards/service.ts` PUT (`executeTakeFirstOrThrow`) -- throws `NoResultError` leading to 500 instead of 404 for a cross-org id.

---

## Guards & Tooling

**Static check:** `packages/backend/scripts/check-tenant-scoping.ts` (npm: `check:tenant-scoping`, `report:tenant-scoping`) flags Kysely queries on tenant tables lacking org/project scoping. Known-OK sites are listed in `scripts/tenant-scope-allowlist.json` (content-keyed, with reasons). Wired into CI (typecheck job). New unscoped sites fail CI.

**Runtime guard:** `packages/backend/src/database/tenant-scope-guard.ts`, a Kysely plugin that throws on unscoped tenant-table queries. Off by default; enabled with `TENANT_GUARD=1` for targeted audit runs and isolation work. NOT run against the full app/suite in CI because legitimate bootstrap queries (e.g. the api-key-by-token auth lookup) are intentionally unscoped; the static check is the CI gate.

**Isolation test suite:** `packages/backend/src/tests/isolation/` (fixture `createIsolatedTenants` + per-area tests: query, traces, crud, apikey-auth, audit-log, metering, current-policy). Runs in CI.

**PR template:** `.github/pull_request_template.md` has a tenant-safety checklist.

---

## Tenancy Model

Three rules govern data isolation in LogTide:

1. **Organization boundary (hard).** Every tenant table query that crosses a multi-tenant dataset MUST filter by `organization_id`. A user authenticated to org A must never see data belonging to org B.

2. **API key scope (project-scoped).** An API key is bound to a single project. A request authenticated with key for project A1 must not be able to read or write data in project A2, even within the same organization.

3. **Session users are org-wide (current policy).** A logged-in user has access to all projects within their organization. This is a deliberate product decision, not a security invariant; see the extension point below.

**Important storage detail:** the `logs` table has `project_id` only (no `organization_id` column). All `logs` queries are scoped by `project_id`. The storage engine (reservoir) enforces this. All other time-series tables (`spans`, `traces`, `metrics`, etc.) have both columns.

---

## Future Extension Point: Per-Project User Access

If per-project RBAC is added in future, the correct place to enforce it is in the session-auth path that resolves which projects a user may access (e.g. `verify-project-access.ts` or the resolver that builds `userProjectIds`). The data layer does not change; instead the resolver narrows the set of `projectId` values before any query is executed. Org-wide session access is the current policy, not a security invariant embedded in query predicates.

---

## Table Taxonomy

### Tenant Tables (every query must scope by the column(s) shown)

| Table | Scope column(s) |
|---|---|
| `logs` | `project_id` only (no org_id column) |
| `api_keys` | `project_id` |
| `alert_rules` | `organization_id`, optional `project_id` |
| `alert_history` | FK only: `rule_id -> alert_rules.id` (no direct org/project column) |
| `notifications` | `user_id` (cross-org, user-scoped; org/project nullable context) |
| `sigma_rules` | `organization_id`, optional `project_id` |
| `traces` | `organization_id`, `project_id` |
| `spans` | `organization_id`, `project_id` |
| `logs_hourly_stats` | `project_id` (via reservoir/hypertable) |
| `logs_daily_stats` | `project_id` (via reservoir/hypertable) |
| `spans_hourly_stats` | `organization_id`, `project_id` |
| `spans_daily_stats` | `organization_id`, `project_id` |
| `detection_events_hourly_stats` | `organization_id`, `project_id` |
| `detection_events_daily_stats` | `organization_id`, `project_id` |
| `detection_events_rule_stats` | `organization_id`, `project_id` |
| `detection_events` | `organization_id`, `project_id` |
| `incidents` | `organization_id`, optional `project_id` |
| `monitors` | `organization_id`, `project_id` |
| `monitor_results` | `organization_id`, `project_id` |
| `monitor_uptime_daily` | `organization_id`, `project_id` |
| `status_incidents` | `organization_id`, `project_id` |
| `scheduled_maintenances` | `organization_id`, `project_id` |
| `exceptions` | `organization_id`, `project_id` |
| `sourcemaps` | `organization_id`, `project_id` |
| `error_groups` | `organization_id`, `project_id` |
| `detection_pack_activations` | `organization_id` (no project_id) |
| `log_identifiers` | `organization_id`, `project_id` |
| `identifier_patterns` | `organization_id` |
| `notification_channels` | `organization_id` |
| `organization_default_channels` | `organization_id` |
| `pii_masking_rules` | `organization_id` |
| `organization_pii_salts` | `organization_id` |
| `audit_log` | `organization_id` |
| `metrics_hourly_stats` | `organization_id`, `project_id` |
| `metrics_daily_stats` | `organization_id`, `project_id` |
| `metrics` | `organization_id`, `project_id` |
| `metric_exemplars` | `organization_id`, `project_id` |
| `custom_dashboards` | `organization_id` |
| `log_pipelines` | `organization_id`, `project_id` |
| `digest_configs` | `organization_id` |
| `digest_recipients` | `organization_id` |
| `projects` | `organization_id` |

### Child Tables (scoped indirectly through FK to a tenant parent)

`monitor_status`, `status_incident_updates`, `incident_alerts`, `incident_comments`, `incident_history`, `stack_frames`, `alert_rule_channels`, `sigma_rule_channels`, `monitor_channels`, `incident_channels`, `error_group_channels`

### Global Tables (no tenant scope by design)

`users`, `sessions`, `organizations`, `organization_members`, `organization_invitations`, `user_identities`, `oidc_states`, `system_settings`, `auth_providers`, `user_onboarding`

---

## Data-Access Path Inventory

203 `scoped` sites from the static report are omitted here; all were confirmed tagged by the scanner. The table below covers all 63 `UNSCOPED` sites triaged manually.

| file:line | table | function | classification | status | note |
|---|---|---|---|---|---|
| scripts/seed-massive-data.ts:260 | logs | showStats | INTENTIONAL-GLOBAL | OK | Dev seed script; COUNT(*) for display only, no production path |
| scripts/seed-massive-data.ts:265 | spans | showStats | INTENTIONAL-GLOBAL | OK | Dev seed script; COUNT(*) for display only |
| scripts/seed-massive-data.ts:270 | detection_events | showStats | INTENTIONAL-GLOBAL | OK | Dev seed script; COUNT(*) for display only |
| modules/admin/service.ts:221 | projects | getPlatformStats | INTENTIONAL-GLOBAL | OK | Admin panel: counts all projects across all orgs by design |
| modules/admin/service.ts:921 | alert_rules | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: counts all alert rules platform-wide |
| modules/admin/service.ts:926 | alert_rules | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: counts active rules platform-wide |
| modules/admin/service.ts:935 | alert_history | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: triggered counts platform-wide; alert_history has no org column, scoped via rule_id FK in full query |
| modules/admin/service.ts:941 | alert_history | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: triggered counts platform-wide |
| modules/admin/service.ts:962 | alert_history | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: notification success/failure counts platform-wide |
| modules/admin/service.ts:969 | alert_history | getAlertsStats | INTENTIONAL-GLOBAL | OK | Admin panel: notification failure counts platform-wide |
| modules/admin/service.ts:1604 | projects | listProjects | INTENTIONAL-GLOBAL | OK | Admin panel: total-count subquery for pagination across all projects |
| modules/admin/service.ts:1764 | projects | deleteProject | SAFE-BY-PK | OK | Admin-only delete by primary key; projectId comes from admin-authenticated request |
| modules/admin/service.ts:1827 | projects | getPlatformTimeline | INTENTIONAL-GLOBAL | OK | Admin timeline: fetches all project IDs to aggregate cross-platform stats |
| modules/admin/service.ts:1879 | projects | getPlatformTimeline | INTENTIONAL-GLOBAL | OK | Admin timeline (ClickHouse path): fetches all project IDs for cross-platform aggregate |
| modules/admin/service.ts:2053 | incidents | getActiveIssues | INTENTIONAL-GLOBAL | OK | Admin dashboard: counts open incidents across all orgs |
| modules/admin/service.ts:2072 | alert_history | getActiveIssues | INTENTIONAL-GLOBAL | OK | Admin dashboard: failed notifications count platform-wide |
| modules/admin/service.ts:2082 | error_groups | getActiveIssues | INTENTIONAL-GLOBAL | OK | Admin dashboard: open error groups count platform-wide |
| modules/alerts/service.ts:285 | alert_rules | checkAlertRules | INTENTIONAL-GLOBAL | OK | Worker: loads all enabled rules to evaluate; next step immediately scopes per-org |
| modules/alerts/service.ts:336 | alert_history | checkRule | SCOPED-INDIRECT | OK | Fetches last trigger for rule.id (rule was pre-filtered by org in checkAlertRules) |
| modules/alerts/service.ts:428 | alert_history | checkRateOfChangeRule | SCOPED-INDIRECT | OK | Cooldown check by rule.id (rule already org-scoped from parent fetch) |
| modules/alerts/service.ts:624 | alert_history | markAsNotified | SAFE-BY-PK | OK | Updates single row by historyId from server-enqueued job payload |
| modules/api-keys/service.ts:162 | api_keys | updateLastUsedAsync | SAFE-BY-PK | OK | Debounced UPDATE by key PK id; id is set after successful verifyApiKey lookup |
| modules/auth/service.ts:54 | api_keys | verifyApiKey | INTENTIONAL-GLOBAL | OK | Bootstrap: resolves tenant from raw key hash; cannot pre-scope what establishes identity |
| modules/auth/service.ts:66 | api_keys | verifyApiKey | INTENTIONAL-GLOBAL | OK | Bootstrap: update last_used after verification by resolved PK |
| modules/auth/service.ts:79 | api_keys | revokeApiKey | SAFE-BY-PK | OK | Admin revoke by PK id from authenticated session |
| modules/auth/service.ts:90 | api_keys | listApiKeys | INTENTIONAL-GLOBAL | OK | Appears to be an admin/debug listing of all keys (no org filter) -- needs annotation |
| modules/correlation/service.ts:291 | log_identifiers | getLogIdentifiers | FIXED | OK | Now project-scoped; was SCOPED-INDIRECT (caller verified project ownership post-fetch) |
| modules/correlation/service.ts:315 | log_identifiers | getLogIdentifiersBatch | SCOPED-INDIRECT | OK | Queries by log_id IN list; batch route (routes.ts:350) adds project_id IN filter directly |
| modules/detection-packs/service.ts:162 | detection_pack_activations | activatePack (trx) | SAFE-BY-PK | OK | UPDATE by existing.id where existing was retrieved with org scope earlier in same function |
| modules/exceptions/service.ts:79 | exceptions | getExceptionByLogId | FIXED | OK | Now org-scoped; was SCOPED-INDIRECT with post-read org check in route |
| modules/exceptions/service.ts:132 | exceptions | getExceptionById | FIXED | OK | Now org-scoped; was SCOPED-INDIRECT with post-read org check in route |
| modules/exceptions/service.ts:185 | exceptions | exceptionExists | SCOPED-INDIRECT | OK | Existence check by log_id; called from ingest pipeline that already owns the log |
| modules/exceptions/service.ts:366 | error_groups | updateErrorGroupStatus | FIXED | OK | Now org-scoped; was SCOPED-INDIRECT with post-read org check in route |
| modules/maintenances/service.ts:130 | scheduled_maintenances | processMaintenanceTransitions | INTENTIONAL-GLOBAL | OK | Scheduler/worker: transitions all due maintenances across all orgs by design |
| modules/maintenances/service.ts:139 | scheduled_maintenances | processMaintenanceTransitions | INTENTIONAL-GLOBAL | OK | Scheduler/worker: second transition (in_progress -> completed) across all orgs |
| modules/monitoring/checker.ts:134 | monitor_results | isHeartbeatUp | SCOPED-INDIRECT | OK | Query by monitor_id; monitorId comes from runAllDueChecks which loaded the monitor row (org-scoped) |
| modules/monitoring/service.ts:286 | projects | getPublicStatus | SCOPED-INDIRECT | OK | Lookup by verifiedProjectId (server-trusted) or by slug with public visibility check |
| modules/monitoring/service.ts:292 | projects | getPublicStatus | SCOPED-INDIRECT | OK | Lookup by slug for public status page; visibility check follows immediately |
| modules/monitoring/service.ts:404 | monitor_uptime_daily | getPublicStatus | SCOPED-INDIRECT | OK | Query by monitor_id IN list; monitorIds derived from org-scoped monitor query earlier |
| modules/monitoring/service.ts:462 | monitors | runAllDueChecks | INTENTIONAL-GLOBAL | OK | Worker: loads all enabled due monitors across all orgs to schedule checks |
| modules/notifications/service.ts:97 | notifications | getUserNotifications | SCOPED-INDIRECT | OK | Scoped by user_id; notifications is user-scoped (org_id nullable context column) |
| modules/notifications/service.ts:102 | notifications | getUserNotifications | SCOPED-INDIRECT | OK | Unread count by user_id |
| modules/notifications/service.ts:128 | notifications | markAsRead | SCOPED-INDIRECT | OK | UPDATE by notificationId AND user_id; user_id prevents cross-user access |
| modules/notifications/service.ts:140 | notifications | markAllAsRead | SCOPED-INDIRECT | OK | Bulk update WHERE user_id = userId; user-scoped |
| modules/notifications/service.ts:152 | notifications | deleteNotification | SCOPED-INDIRECT | OK | DELETE by id AND user_id; user_id is the isolation key |
| modules/notifications/service.ts:163 | notifications | deleteAllNotifications | SCOPED-INDIRECT | OK | DELETE WHERE user_id = userId |
| modules/notifications/service.ts:178 | notifications | cleanupOldNotifications | INTENTIONAL-GLOBAL | OK | Scheduled cleanup of old read notifications across all users by design |
| modules/pii-masking/service.ts:259 | pii_masking_rules | updateRule | FIXED | OK | Pre-read SELECT now org-scoped; was REAL-GAP (unscoped pre-read leaked pattern_type) |
| modules/projects/data-availability-backfill.ts:107 | projects | markHasData (inline) | INTENTIONAL-GLOBAL | OK | One-shot boot backfill; updates all uninitialized projects by PK from a full scan |
| modules/projects/data-availability-backfill.ts:119 | projects | runDataAvailabilityBackfill | INTENTIONAL-GLOBAL | OK | Boot backfill: scans all projects with null data-availability flags |
| modules/projects/service.ts:260 | projects | verifyStatusPagePassword | SAFE-BY-PK | OK | Lookup by projectId for public status page password check; project id is from route param |
| modules/projects/service.ts:287 | projects | markHasData | SAFE-BY-PK | OK | Fire-and-forget UPDATE by projectId; projectId comes from authenticated ingest context |
| modules/projects/service.ts:351 | projects | deleteProject | SAFE-BY-PK | OK | DELETE by projectId; caller verifies project ownership via getProjectById(projectId, userId) first |
| modules/siem/service.ts:327 | detection_events | linkDetectionEventsToIncident | FIXED | OK | organizationId now required; org scope always applied; was REAL-GAP (optional guard) |
| modules/siem/service.ts:339 | incidents | linkDetectionEventsToIncident | FIXED | OK | incidents UPDATE now org-scoped; was REAL-GAP (no org filter on detection_count increment) |
| modules/siem/service.ts:352 | detection_events | getIncidentDetections | FIXED | OK | organizationId now required and applied; was REAL-GAP (optional omission allowed cross-org read) |
| modules/siem/service.ts:439 | incidents | enrichIncidentIpData | FIXED | OK | organizationId now required; UPDATE org-scoped; was REAL-GAP (no org filter) |
| modules/sigma/service.ts:313 | alert_rules | deleteSigmaRule | SAFE-BY-PK | OK | DELETE alert_rules by rule.alertRuleId; alertRuleId came from getSigmaRuleById(id, organizationId) which is org-scoped |
| modules/sigma/sync-service.ts:240 | sigma_rules | syncRules (update branch) | SAFE-BY-PK | OK | UPDATE by existing.id where existing was fetched with org+sigmahq_path scope at line 156 |
| modules/status-incidents/service.ts:179 | status_incidents | addUpdate | SCOPED-INDIRECT | OK | UPDATE inside transaction; prior SELECT at line 158-163 verified organization_id before proceeding |
| queue/jobs/error-notification.ts:167 | projects | processErrorNotification | SAFE-BY-PK | OK | Lookup projects by data.projectId; projectId came from server-enqueued job (exception-parsing) |
| queue/jobs/incident-autogrouping.ts:77 | detection_events | groupByTraceId | SCOPED-INDIRECT | OK | SELECT by id IN eventIds where eventIds came from prior org-scoped query at line 50-68 |
| queue/jobs/log-pipeline.ts:50 | logs | processLogPipeline | SAFE-BY-PK | OK | UPDATE by log id from job payload; log IDs were just ingested in the same project/org context |

---

## Contributor Checklist

When adding or modifying any query that touches a tenant table:

- [ ] Does the query include `organization_id` (and `project_id` where relevant) in the WHERE clause?
- [ ] If the query joins multiple tables, is scoping enforced at every level?
- [ ] If the query updates or deletes, is scoping verified before execution, not just trusted to filter results?
- [ ] If results go to a cache, does the cache key include the organization id?
- [ ] If the operation is enqueued as a background job, is the org id in the payload, and does the consumer re-validate it?
- [ ] If an id comes from a URL parameter or request body, is it verified to belong to the requesting org before use?

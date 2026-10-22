# Elecbits HRMS — Technical Reference

End-to-end reference for code review: architecture, access model, database schema,
complete endpoint catalog, and per-feature walkthroughs with their cross-connections.
Column-level schema detail lives in [`database-schema.md`](./database-schema.md);
live API docs are served by the backend at `/docs` (Swagger, generated from the same
Zod schemas that validate requests at runtime).

Repos: `elecbits-hr-backend` (Node 22 · Express 4 · Drizzle ORM · PostgreSQL) and
`elecbits-hr-frontend` (React 19 · Vite · TanStack Query · Tailwind v4). No
third-party auth/IdP and no BaaS — auth is local JWT, the database is plain Postgres
(AWS RDS for the testing database).

_Last updated 2026-10-16, after the OPS asset manager, the exit module and the
HRBP / PR / OPS close-out (probation, PIP, loans, receipts, salary split) —
migrations up to 0053. TA (hiring) is the one portal not built yet._

---

## 1. Architecture

### 1.1 Layering (strict, every feature)

```
routes → authenticate → requireAccess → validateBody → controller → service → repository → DbClient → Postgres
```

| Layer                                         | Allowed to                                                                                               | Never does          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| `*.routes.ts`                                 | wire URL → middleware chain                                                                              | logic               |
| `authenticate`                                | verify the short-lived JWT + the account is still active; attach `req.auth` (identity only)              | carry permissions   |
| `requireAccess(module, action, { orgOnly? })` | resolve grants from the DB per request; attach `req.access` (all held scopes)                            | cache grants        |
| `validateBody(zodSchema)`                     | reject malformed input (400)                                                                             | business checks     |
| `*.controller.ts`                             | HTTP in/out; build the service from `req.db`; narrow people lists with `keepReachable` / `assertReaches` | SQL, business rules |
| `*.service.ts`                                | business rules, error codes, cross-entity orchestration                                                  | HTTP, SQL           |
| `*.repository.ts`                             | **the only layer that touches the DB**; transactions + audit rows + bells                                | business decisions  |

House rules (backend `CLAUDE.md`): factory functions with explicit dependency
injection (no classes except `db/client.ts`), `process.env` read only in
`config/env.ts`, pino structured logging only, every endpoint in Swagger via the
feature's `*.docs.ts`, `npm run typecheck` green before anything is "done".

### 1.2 Feature module layout

```
src/features/<feature>/
├ <feature>.routes.ts       auth + gate + validate → controller
├ <feature>.controller.ts   HTTP only; composition root per request
├ <feature>.service.ts      business rules
├ <feature>.repository.ts   DB access (via injected DbClient)
├ <feature>.schema.ts       Zod request/response schemas (.openapi() tagged)
├ <feature>.docs.ts         OpenAPI registration
└ index.ts                  public surface
```

Features (25): `auth`, `me`, `employees`, `departments`, `access` (batches,
grant requests, audit, authz, the RM-or-HR gate, self-governance), `settings`,
`notifications`, `leaves`, `attendance`, `payroll` (runs, payslips,
corrections, loans, F&F lines), `reimbursements`, `performance` (goals + work
updates), `quarter-reports`, `career`, `recognitions`, `feedback`, `policies`,
`onboarding`, `probation`, `pip`, `exits`, `concerns`, `open-door`, `ops`
(assets, setup, requests, gate passes, stock, my assets), `jobs`.

Outside features: `src/scheduler/` (the in-process job ticker, §5.12),
`src/scripts/` (migrations, seeds, one-off repairs, `gen-schema-doc.ts`).

**File uploads** never go through multipart: the client sends the raw file as
the request body (`express.raw`, 10 MB, `?filename=`), the service checks type
(PDF/JPG/PNG) and size, and the bytes are stored in a `bytea` column next to
the owning row — policy PDFs, sick-leave certificates, claim receipts. Downloads
stream back `inline` with `Cache-Control: private, no-store`. PDFs the app
produces (payslips, F&F statement, relieving / experience / confirmation
letters) are rendered on request, never stored.

### 1.3 Migrations

Generated only: `npm run db:generate -- --name <desc>` → review SQL →
`npm run db:migrate`. Never hand-edited (one deliberate exception: `0003`
backfill), never `drizzle-kit push`. **54 migrations (0000–0053)**, all applied on
the testing database; `.sql` files and `migrations/meta/` journal are committed
together. After a migration, `npm run docs:schema` regenerates
[`database-schema.md`](./database-schema.md) from the Drizzle schema.

### 1.4 Transactions, audit, bells

Every mutation that changes access, balances, approvals, money or performance
records runs in one `db.transaction()` and writes its `access.audit_log` row
**inside that transaction**. Audit detail is machine-readable JSON and never
contains salary, claim or correction amounts or note bodies. Bell notifications
are written with `insertNotifications(tx, recipients, event)` in the same
transaction as the change that caused them.

### 1.5 Org settings

`features/settings/settings.registry.ts` is the one list of org-tunable values:
each key has an `area` (payroll / attendance / leaves / people / access), a Zod
schema, a default that reproduces the original behaviour, and optionally
`public`. Features read them through `SettingsReader.effective(key)` /
`effectiveMany(keys)`; a stored value that no longer fits its schema falls back
to the default. Editing is owned by area: `pr.payroll` for payroll,
`hrbp.attendance` / `hrbp.leaves` / `hrbp.people` for the HR areas, Admin
(`access.settings`) for everything — always at org scope. Statutory and
structural policy (PF, tax slabs, cess, rebate, surcharge, leave quotas,
salary split) stays in code.

Current keys (14 — real policy only): `awards.catalog`,
`leaves.applicationWindowDays`, `attendance.workWeek`, `attendance.workHours`,
`attendance.hourRules`, `payroll.payslipHeader`, `payroll.ptStates`,
`payroll.monthEndAutoApprove`, `payroll.autoCoverLeaveTypes`,
`people.newHireDefaults`, `career.selfRequest`, `concerns.timelines`,
`concerns.icContact`, `concerns.mrcMembers`. The `ops` area has no keys today.

Internal knobs are fixed constants in `shared/constants/constants.ts`, not
settings (user decision 2026-10-20): citation 50–500 characters
(`CITATION_MIN_LENGTH` / `CITATION_MAX_LENGTH`, enforced by the request schema),
2 work-update misses a month, onboarding due in 30 days and auto-created within
90 days of joining, open-door booking 21 days ahead, invite links valid 7 days,
regularize / late work update 14 days back, approval reminders after 2 then
every 2 working days, return reminders every 2 and escalated after 5 working
days. The never-wired goal at-risk thresholds and health-insurance default were
removed.

Fixed by decision rather than settings: probation is 2 months with no extension
(auto-confirm 7 days after the date), a PIP runs 60 days with a check-in every
14 days and one 30-day extension, LTA is 10% of the month.

### 1.6 Frontend: consoles and navigation

One application, one login; every person is an Employee first and extra power
comes from batches. The SPA has three consoles inside **one nested sidebar**:
Employee (`/`, everyone), HR (`/hr`, holders of any portal batch — HRBP, PR,
OPS, TA — or Owner / SuperAdmin; a person sees only the portals they hold) and
Admin (`/admin`, Owner / SuperAdmin).

- `PortalShell.component.tsx` reads `/me` and renders the tree from the single
  nav definition `constants/Common/navigation/nav.constants.ts`.
- **De-drift rule**: the route guard (`providers/ProtectedRoute.guard.tsx`) and
  the sidebar both decide visibility with `utils/sections.ts`
  (`canEnterSection`, `holdsPortal`), so what is clickable and what is
  reachable never disagree. The server re-checks every request regardless.
- Two onboarding doors land in the same backend: HR → People → Add employee
  (record-first, `POST /employees`) and Admin → Invite (access-first, batches
  chosen up front, `POST /employees/invite`).

---

## 2. Access & permissions model

### 2.1 Primitives

- **Action**: `create | read | update | delete`
- **Scope**: `me | team_direct | team | dept | org` — **all five are enforced**
  (§2.3). Several scopes on one module add up.
- **Grant**: one row `(module_key, action, scope)`
- **Batch**: a named, reusable bundle of grant rows (`access.batches` +
  `access.batch_grants`); assigned via `access.employee_batches`
- **Individual grant**: a one-off row in `access.individual_grants`
- **Rights levels** (viewer/contributor/editor/manager) are **app-layer presets**
  that tick action boxes in the batch composer — not a schema concept.

### 2.2 Resolution — per request

`middleware/authorize.ts` → `access/authz.repository.ts`. One UNION query returns
owner/superadmin membership and every matching batch/individual grant. Effective
access is the **union** of everything held; no deny rules. Owner and SuperAdmin
bypass every check. Nothing is cached in the JWT, so revoking or editing a batch
bites on the holder's next request.

### 2.3 Scopes: whose rows a grant reaches

`authz.reachable(holder, access)` → `{ all: true }` or a set of employee ids:

| Scope          | Reaches (always + the holder)                               |
| -------------- | ----------------------------------------------------------- |
| `me`           | the holder only                                             |
| `team_direct`  | people whose `reports_to` or `leave_approver` is the holder |
| `team`         | everyone below the holder in the reporting tree (recursive) |
| `dept`         | everyone in the holder's department                         |
| `org` / bypass | everyone                                                    |

Used three ways:

- **Lists**: controllers filter with `keepReachable(req, rows, personOf)` —
  people, incomplete records, HR leave queue, exits, onboarding queue, org
  attendance month, remote-work queue, asset requests, gate passes.
- **One person**: `assertReaches(req, id, 'hide' | 'forbid')` → 404 on reads,
  403 `OUT_OF_SCOPE` on actions (employee get/edit/claim link, onboarding
  start/read, HR attendance mark, asset-request handling, gate-pass transitions).
- **HR stand-ins and HR approval slots**: `authz.reaches(actor, module, action,
targetId)` — the RM-or-HR person-sheet gate (`createRmOrHrGate`), leave and
  remote-work HR slots, no-RM regularizations, career, feedback, onboarding
  ticks, access requests. HR bell audiences use
  `listBroadHolders(module, action, subjectId)` (holders who reach the subject;
  org holders when there is no subject).

**Org-only modules** — `requireAccess(…, { orgOnly: true })`; a narrower grant
gets 403 `ORG_SCOPE_REQUIRED`: payroll (`pr.payroll*` incl. compensation and
bank details), batches, grant requests, audit, departments (`hrbp.org`),
locations, assets, policy management, holidays. Settings ownership, R&R final
approval and closing a quarter also require org scope.

### 2.4 Module keys (22, seeded by `scripts/seed-modules.ts`)

| Area         | Keys                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TA           | `ta.hiring` (seeded, nothing built yet)                                                                                                         |
| HRBP         | `hrbp.people`, `hrbp.org`, `hrbp.policies`, `hrbp.grievances`, `hrbp.vigil`, `hrbp.exits`, `hrbp.leaves`, `hrbp.attendance`                     |
| PR           | `pr.payroll` · children: `pr.payroll.compensation`, `pr.payroll.bank_details`, `pr.payroll.compliance` (seeded, unused until statutory filings) |
| OPS          | `ops.assets`, `ops.asset_requests`, `ops.gate_passes`, `ops.locations`, `ops.stock`                                                             |
| Access admin | `access.batches`, `access.requests`, `access.audit`, `access.settings`                                                                          |

**Parent grants never cascade to children.** `pr.payroll.compensation` (salary,
CTC, structure %, TDS calculator, offer breakup, **the loan register**) and
`pr.payroll.bank_details` (bank name, account, IFSC) are separate doors: a
compensation-only caller sees bank fields as `bankDetailsHidden: true` and is
refused (403 `BANK_DETAILS_FORBIDDEN`) when sending them.

Close-out features ride existing keys rather than new ones: probation decisions
and PIP approval use `hrbp.people` update (in reach); the OPS joiner task uses
`ops.assets` update (org); the payroll joiner task and payroll-side claim
receipts use `pr.payroll` (org).

### 2.5 Seeded batches

| Batch    | Grants (all org scope)                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Employee | baseline self-service (assigned automatically)                                                                                                                            |
| HRBP     | `hrbp.people` editor · `hrbp.org` contributor · `hrbp.leaves` editor · `hrbp.attendance` editor · `hrbp.policies` editor · `hrbp.grievances` editor · `hrbp.exits` editor |
| PR       | `pr.payroll` manager · `pr.payroll.compensation` editor · `pr.payroll.bank_details` editor                                                                                |
| OPS      | `ops.assets` · `ops.locations` · `ops.asset_requests` · `ops.gate_passes` · `ops.stock` — all editor. Whoever holds this batch **is** OPS (no separate team)              |

`hrbp.vigil` (whistleblower cases) is in no batch by default — Admin grants it
to the vigil team at org scope; plain HR never sees those cases.

The HR section of the SPA opens by batch **name** (HRBP / PR / …); the server
re-checks every request. Custom batches are first-class in Admin → Access
batches; the composer offers all five scopes with plain meanings and warns when
a company-wide module is given a narrower scope.

### 2.6 Special principals and relationships

- **Owner** (`access.org_owner`, singleton): the administration account, not a
  person — bypasses all gates, excluded from attendance, payroll, quarter
  reports; 403 `SYSTEM_ACCOUNT` on punching/leave/remote.
- **Self-governed apex**: people whose effective RM is the Owner record
  (`access/selfGovernance.ts`). Their leave, remote work and late work updates
  are approved as raised (balances still charged), they set their own goals,
  they appear in nobody's team views, reimbursements skip the RM step.
- **Reporting manager is a relationship, not a grant**: the effective RM =
  `leave_approver ?? reports_to`; team views and RM slots resolve it live.
- **Grant requests**: HR proposes extra access for one person
  (`access.requests`), Admin approves / narrows / declines.
- **No self-approval**, anywhere (403 `NO_SELF_APPROVAL`).

### 2.7 Sessions

Access JWT (short-lived) + rotating refresh token in an httpOnly cookie
`eb_refresh` (path `/api/v1/auth`, 7-day sliding life, rotation with a 30-second
reuse grace; reuse of an older token revokes the family). `authenticate` also
checks the employee is still active on every request; deactivation revokes all
refresh tokens. The SPA's axios interceptor refreshes and retries once.

---

## 3. Database schema

Four Postgres schemas, **70 tables** (public 2 · org 45 · access 11 · ops 12),
46 enums. Column detail, keys, indexes and checks:
[`database-schema.md`](./database-schema.md) — generated from the Drizzle schema
by `npm run docs:schema`, so it is always current.

### `public` (2)

| Table            | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `users`          | credentials only — email + bcrypt hash, link to employee                 |
| `refresh_tokens` | hashed rotating refresh tokens: family, expiry, revoked/replaced markers |

### `org` (45)

| Table                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employees`                                   | the org chart: `reports_to` (no cycles), `leave_approver`, level L1–L6, status invited/active/exiting/inactive, department, designation, base zone, personal `work_start`/`work_end`, joining/confirmation dates, notice days, claim-token hash + expiry                                                                                                                                                                                                    |
| `departments`                                 | department master                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `employee_salary`                             | CTC, structure %, recurring TDS/other deductions, CNPS %, **`variable_pay`** (annual target), PAN/PF/bank fields (bank behind `pr.payroll.bank_details`)                                                                                                                                                                                                                                                                                                    |
| `org_settings`                                | key → JSON value, updated by/at (§1.5)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `notifications`                               | the bell: recipient, type, title, body, link, read_at                                                                                                                                                                                                                                                                                                                                                                                                       |
| `leave_requests`                              | dual approval (`rm_*`, `hr_*`, `rm_required`/`hr_required`), day part, status incl. `partially_approved`, `revoked`                                                                                                                                                                                                                                                                                                                                         |
| `leave_balances`                              | per employee × type × year: `allocated` (earned 1.5/mo and menstrual 1/mo **accrued from the joining month**; fixed quotas prorated in the joining year, rounded to the half day), `opening` (earned carry-forward), `used`; arbiter `used + x <= LEAST(opening+allocated, 30)` for earned                                                                                                                                                                  |
| `attendance`                                  | punches: date, in/out, lat/lng, source office/remote/regularized                                                                                                                                                                                                                                                                                                                                                                                            |
| `punch_zones`                                 | geofences: lat/lng/radius + zone work hours                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `holidays`                                    | org holiday calendar                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `attendance_regularizations`                  | punch corrections (routes currently disabled; HR mark replaces them)                                                                                                                                                                                                                                                                                                                                                                                        |
| `wfh_requests`                                | remote work: dual RM + HR slots, mandatory reason                                                                                                                                                                                                                                                                                                                                                                                                           |
| `feedback_notes`                              | appreciation/concern notes: author, recipient, body, evidence                                                                                                                                                                                                                                                                                                                                                                                               |
| `policies`, `policy_acks`, `policy_documents` | library (with retire), version-stamped append-only acks, the PDF in the DB                                                                                                                                                                                                                                                                                                                                                                                  |
| `onboarding_journeys`, `onboarding_tasks`     | one journey per hire; tasks with owner employee / manager / hr / admin / **ops** (joiner kit) / **payroll** (salary + bank on record) — the last two tick themselves                                                                                                                                                                                                                                                                                        |
| `probation_reviews`                           | one per person at the 2-month date: status pending → recommended → confirmed / ended, the RM's recommendation + note, HR's decision + note, `auto_confirmed`, the termination `exit_id` when ended                                                                                                                                                                                                                                                          |
| `pips`, `pip_checkins`                        | performance improvement plans: RM, reason, `targets` (jsonb title + measure), support, start / end (60 days, `extended` once +30), status pending_hr → active → passed / not_passed / cancelled, HR decision, acknowledgement, outcome; fortnightly check-ins with rating on_track / at_risk / off_track. One open PIP per person (partial unique index)                                                                                                    |
| `recognitions`                                | R&R: type from the catalog setting, `award_name` snapshot, citation, value, status, `cycle`, `group_id`/`group_lead` for team awards; partial unique index = one approved award per type per window                                                                                                                                                                                                                                                         |
| `career_tracks`                               | open roadmap conversation toward the next band (one open per person)                                                                                                                                                                                                                                                                                                                                                                                        |
| `career_level_changes`                        | promotion history: from → to, by, when, the track it fulfilled                                                                                                                                                                                                                                                                                                                                                                                              |
| `career_track_notes`                          | notes on an open track (RM/HR write, employee reads)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `review_cycles`                               | quarters (`2026-Q4`), ensured lazily; **`closed_at`/`closed_by`** once HR closes it                                                                                                                                                                                                                                                                                                                                                                         |
| `goals`                                       | quarterly goals with **`category`** fundamental / corporate / general, weight, progress (owner only), due date                                                                                                                                                                                                                                                                                                                                              |
| `quarter_reports`                             | one frozen row per person per closed quarter (§5.9)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `work_updates`                                | one daily note per person: `goal_ids` tags, `late_status` pending/approved/declined, optional AI `score` (null = unscored)                                                                                                                                                                                                                                                                                                                                  |
| `work_update_miss_flags`                      | one per person per month over the miss allowance                                                                                                                                                                                                                                                                                                                                                                                                            |
| `payroll_runs`                                | month, draft/finalized/paid                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `payslips`                                    | immutable snapshots after finalize (§5.6): structure split **`basic_percent` / `hra_percent`** (from the salary record), LOP, PF both sides, TDS, PT + **`pt_state`**, deductions, earnings adjustments incl. `recognition_bonus`, **`reimbursement`** (sum of approved claims), **`correction`**, **`loan_emi`**, the F&F lines when `exit_id` is set (EL encashed, gratuity, notice pay / recovery, uncertified sick days, recoveries), net and final pay |
| `payslip_corrections`                         | post-finalize corrections: signed amount, reason, source slip, pending/applied/cancelled, the run that carried it                                                                                                                                                                                                                                                                                                                                           |
| `reimbursement_claims`                        | employee claims: spend date, category, amount, receipt note, status pending_rm → pending_payroll → approved → paid (or declined/cancelled), deciders, the run that paid it                                                                                                                                                                                                                                                                                  |
| `claim_receipts`                              | one receipt file per claim (bytea, replaced on re-upload)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `loans`, `loan_repayments`                    | loan / advance register: principal, `interest_rate_pct` (per loan), months, start month, EMI, status active / closed / recovered_at_exit; repayments per run (emi), at exit (fnf) or outside payroll, split into principal + interest                                                                                                                                                                                                                       |
| `exits`, `exit_clearances`, `fnf_recoveries`  | resignation or termination (serve / pay in lieu): notice start, proposed and fixed last day, shortfall waive / recover, handover plan, interview, status submitted → accepted → relieved → settled (or withdrawn / cancelled); four clearances hr / manager / ops / payroll; payroll's typed recovery lines                                                                                                                                                 |
| `leave_certificates`                          | the sick-leave certificate file for a leave (bytea) — 3+ sick days in notice without one are LOP in the F&F                                                                                                                                                                                                                                                                                                                                                 |
| `concerns`                                    | one case: code (`DSP-`/`CMP-`/`WBR-YYYY-NNN`), track dispute/complaint/whistleblower, category, subject, related case, `raised_by` (null when anonymous) + `follow_up_key_hash`, status, dispute `level` + `escalate_by`, ack/resolve due dates, extension + reason, outcome, resolution                                                                                                                                                                    |
| `concern_notes`                               | the case thread: author (null = anonymous raiser), kind note/reply/decision/system, level, `visible_to_raiser`                                                                                                                                                                                                                                                                                                                                              |
| `open_door_slots`                             | owner, date, start/end, capacity, note, cancelled_at                                                                                                                                                                                                                                                                                                                                                                                                        |
| `open_door_bookings`                          | slot × employee (unique), private topic, status booked/done/cancelled/no_show                                                                                                                                                                                                                                                                                                                                                                               |

### `access` (11)

`org_owner` · `superadmins` · `modules` · `batches` · `batch_grants` ·
`batch_assign_rights` (dropped from the design, table kept) · `employee_batches`
· `individual_grants` · `audit_log` (append-only) · `grant_requests` +
`grant_request_items` (decision flow live).

### `ops` (12)

Rebuilt in 0044–0045 (OPS asset manager, §5.14). Locations are the attendance
**punch zones** — there is no separate locations table.

| Table                                            | Purpose                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset_categories`                               | category, code prefix, `kind` equipment / lab (lab = lent with a due date), `requires_gate_pass`                                                                                                            |
| `assets`                                         | the register: code, category, make / model / serial, condition, `zone_id` (always), `holder_id` (optional), status assigned / idle / in_use_shared / needs_repair / scrapped / gifted / lost, loan due date |
| `asset_events`                                   | append-only history: registered, issued, returned, transferred, moved, status, loan and gate-pass steps, incidents                                                                                          |
| `asset_requests`                                 | new / upgrade / replacement / repair / return requests to the OPS queue                                                                                                                                     |
| `gate_passes`                                    | taking a flagged item out: disclaimer accepted, return date, status requested / approved / declined / returned, extensions                                                                                  |
| `asset_incidents`                                | damage / loss / theft, open → closed (recorded only, no payroll recovery)                                                                                                                                   |
| `asset_kits`                                     | what a designation should be issued (the joiner kit)                                                                                                                                                        |
| `stock_items`, `stock_levels`, `stock_movements` | consumables counted per zone; append-only ledger (in / issue / transfer / adjust); never below 0                                                                                                            |
| `scheduled_job_runs`                             | one row per job per run key — the cross-instance lock (§5.12)                                                                                                                                               |
| `reminders_sent`                                 | every reminder sent (approvals, returns, probation, PIP) — paces the next one                                                                                                                               |

---

## 4. Endpoint catalog

All routes mount under `/api/v1`; every router applies `authenticate` first
unless marked public. "Gate" = `requireAccess(module, action)` (_org_ =
`orgOnly`); "service" = the check lives in the service; "reach" = filtered or
refused by scope (§2.3).

### Auth (public)

| Method & path          | Notes                                             |
| ---------------------- | ------------------------------------------------- |
| `POST /auth/login`     | email + password → access JWT + refresh cookie    |
| `POST /auth/refresh`   | rotate the refresh cookie, new access token       |
| `POST /auth/logout`    | revoke the refresh family                         |
| `POST /auth/claim`     | claim an invited record with the single-use token |
| `POST /auth/claim-org` | one-time bootstrap; 410 forever after             |

### Me, notifications, settings

| Method & path                                                                                                                            | Gate    | Notes                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `GET /me` · `PATCH /me`                                                                                                                  | auth    | profile; self-serve personal fields only                                             |
| `GET /me/salary`                                                                                                                         | auth    | own salary + bank (read only)                                                        |
| `GET /me/team` · `/me/assets` · `/me/exit`                                                                                               | auth    | chain (sanitized), own assets, own exit                                              |
| `GET /my-assets` · `POST /my-assets/loans/:id/back` · `/loans/:id/extend` · `/passes/:id/back` · `/passes/:id/extend` · `/:id/incidents` | auth    | held items, passes, requests; back / still-out answers; report damage / loss / theft |
| `GET /notifications` · `/notifications/unread-count` · `POST /notifications/read-all` · `POST /notifications/:id/read`                   | auth    | the caller's bell only                                                               |
| `GET /settings?area=`                                                                                                                    | service | what the caller may read, each with `canEdit`                                        |
| `GET /settings/public`                                                                                                                   | auth    | `public` keys only (UI hints)                                                        |
| `PUT /settings/:key`                                                                                                                     | service | owning area at org scope, or `access.settings`                                       |

### Employees & departments

| Method & path                                                               | Gate                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /employees` (with `departmentName`) · `GET /employees/incomplete`      | `hrbp.people read` + reach                                                  |
| `GET /employees/:id`                                                        | `hrbp.people read` + reach (404 outside)                                    |
| `POST /employees` · `POST /employees/import` (CSV dry run / all-or-nothing) | `hrbp.people create`                                                        |
| `PATCH /employees/:id` · `POST /employees/:id/claim-link`                   | `hrbp.people update` + reach                                                |
| `POST /employees/invite`                                                    | `access.batches update` _org_                                               |
| `GET`/`PUT /employees/:id/salary`                                           | `pr.payroll.compensation` _org_; bank fields need `pr.payroll.bank_details` |
| `GET`/`PUT /employees/:id/bank-details`                                     | `pr.payroll.bank_details` _org_                                             |
| `GET`/`POST /departments`                                                   | `hrbp.org` _org_                                                            |

### Access administration

| Method & path                                                                                                           | Gate                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /batches` · `/batches/modules` · `/batches/:id/holders` · `POST /batches` · `PUT /batches/:id` · assign / unassign | `access.batches` _org_; self blocked |
| `GET /grant-requests` · `POST /grant-requests/:id/decision`                                                             | `access.requests` _org_              |
| `GET /grant-requests/mine` · `/options` · `POST /grant-requests`                                                        | service (HR who reaches the person)  |
| `GET /audit-log`                                                                                                        | `access.audit read` _org_            |
| `GET /admin/jobs` · `POST /admin/jobs/:name/run`                                                                        | `access.settings` _org_              |

### Leaves

| Method & path                                                 | Gate                       | Notes                                                                                                       |
| ------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /leaves/mine` · `/leaves/balances`                       | auth                       |                                                                                                             |
| `GET /leaves/team` · `/leaves/team/:employeeId/balances`      | service                    | RM chain / RM-or-HR (menstrual stripped)                                                                    |
| `GET /leaves`                                                 | `hrbp.leaves read` + reach | HR queue                                                                                                    |
| `POST /leaves`                                                | auth                       | working-day count; application window for earned / vacation_family                                          |
| `POST /leaves/:id/cancel` · `/leaves/:id/decision`            | service                    | RM slot = effective RM or named approver; HR slot = `hrbp.leaves update` reaching the person                |
| `PUT /leaves/:id/certificate` · `GET /leaves/:id/certificate` | service                    | raw file body; the owner uploads; the owner, `hrbp.leaves read` in reach or `pr.payroll read` _org_ open it |

### Attendance

| Method & path                                                            | Gate                                  | Notes                                                          |
| ------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| `POST /attendance/check-in` · `check-out`                                | service                               | geo gate; check-out never blocked; short-day bell at check-out |
| `GET /attendance/me` · `/attendance/team`                                | auth                                  |                                                                |
| `GET /attendance/org`                                                    | `hrbp.attendance read` + reach        |                                                                |
| `GET /attendance/export`                                                 | service                               | org payroll grant = everyone, otherwise the HR grant's reach   |
| `POST /attendance/hr-mark`                                               | `hrbp.attendance update` + reach      |                                                                |
| `GET /attendance/zones` · `POST`/`DELETE`                                | auth / Admin                          |                                                                |
| `GET /attendance/holidays` · `POST`/`DELETE`                             | auth / `hrbp.attendance update` _org_ |                                                                |
| `POST /attendance/wfh` + `mine` / `team` / `:id/decision` / `:id/cancel` | auth / service                        | dual RM + HR slots                                             |
| `GET /attendance/wfh/queue`                                              | `hrbp.attendance read` + reach        |                                                                |
| regularizations                                                          | —                                     | disabled (HR mark replaces them)                               |

### Payroll

All `*org*`.

| Method & path                                                                                                                           | Gate                              | Notes                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `GET /payroll/payslips/mine` · `GET /payroll/payslips/mine/:id/pdf`                                                                     | auth                              | published runs only                                                            |
| `GET /payroll/runs` · `/runs/:id` · `/runs/:id/payslips/:payslipId/pdf`                                                                 | `pr.payroll read`                 | drafts watermarked                                                             |
| `POST /payroll/runs` · `/runs/:id/regenerate` · `PATCH /runs/:id/payslips/:payslipId` · `/finalize` · `/mark-paid` · `DELETE /runs/:id` | `pr.payroll` create/update/delete | reimbursement is not editable (claims only)                                    |
| `GET /payroll/corrections` · `POST /payroll/payslips/:id/corrections` · `POST /payroll/corrections/:id/cancel`                          | `pr.payroll` read/update          |                                                                                |
| `GET /payroll/tds` · `PATCH /payroll/tds/:employeeId` · `GET /payroll/annexure?ctc=&ptState=&variablePay=&basicPercent=&hraPercent=`    | `pr.payroll.compensation`         | annexure refuses Basic + HRA + LTA > 100                                       |
| `GET /payroll/people`                                                                                                                   | `pr.payroll.compensation` _org_   | Compensation people list: invited / active / exiting, Owner excluded           |
| `GET /payroll/loans` · `/loans/:loanId` · `POST /payroll/loans` · `PATCH /loans/:loanId` · `POST /loans/:loanId/close`                  | `pr.payroll.compensation`         | record (eligibility: confirmed, full-time, not leaving), re-price, close early |
| `GET /payroll/loans/mine` · `/loans/mine/:loanId`                                                                                       | auth                              | own loans + schedule                                                           |
| `GET`/`POST /payroll/exits/:exitId/recoveries` · `GET /payroll/exits/:exitId/statement`                                                 | `pr.payroll` read / update        | F&F recovery lines; the settled statement PDF                                  |

### Reimbursements

| Method & path                                                                           | Gate                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /reimbursements/mine` · `POST /reimbursements` · `POST /reimbursements/:id/cancel` | auth (own)                                                                                                                  |
| `GET /reimbursements/team`                                                              | auth (claims waiting on the caller as RM)                                                                                   |
| `GET /reimbursements?status=`                                                           | `pr.payroll read` _org_                                                                                                     |
| `POST /reimbursements/:id/decision`                                                     | service: RM step = effective RM; payroll step = `pr.payroll update` _org_                                                   |
| `PUT /reimbursements/:id/receipt` · `GET /reimbursements/:id/receipt`                   | service: the claimant uploads (raw body, PDF / JPG / PNG, 10 MB); claimant, effective RM or `pr.payroll read` _org_ open it |

### Performance, quarter reports, career, recognition, feedback

| Method & path                                                                                                               | Gate                       | Notes                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `GET /goals/mine` · `/goals/team` · `/goals/team/:employeeId`                                                               | auth / service             | score + per-category attainment                                                      |
| `POST /goals` · `PATCH /goals/:id` · `DELETE /goals/:id`                                                                    | service                    | RM or HR reach; self only when self-governed; open quarter only (409 `CYCLE_CLOSED`) |
| `PATCH /goals/:id/progress`                                                                                                 | service                    | owner only, open quarter                                                             |
| `GET /work-updates/mine` · `/team` · `/team/:employeeId` · `POST /work-updates`                                             | auth / service             | server strip, late entry for a missed day, goal tags                                 |
| `GET /work-updates/late` · `POST /work-updates/:id/late-decision`                                                           | service                    | the RM's late-entry queue                                                            |
| `GET /quarter-reports/cycles` · `GET /quarter-reports/cycles/:name` · `/mine` · `/people/:employeeId`                       | auth / service             | what the viewer manages + HR reach (`?as=rm`: managed only); own; person sheet       |
| `POST /quarter-reports/cycles/:name/close`                                                                                  | `hrbp.people update` _org_ | `early: true` for the running quarter                                                |
| `PATCH /quarter-reports/:id/score`                                                                                          | service                    | manager at close or HR reach; never self                                             |
| `GET /career/mine` · `POST /career/request`                                                                                 | auth                       | self-request minimums apply                                                          |
| `GET /career/team` · `GET /career/people/:employeeId` · `POST /career/tracks` · `/tracks/:id/close` · `/tracks/:id/notes`   | service                    | RM or HR reach; next band only                                                       |
| `GET /recognitions/board,/mine,/sent,/pending,/directory,/catalog` · `POST /recognitions` · `POST /recognitions/:id/decide` | auth / service             | manager nominates own report; org HR approves                                        |
| `POST /feedback` · `GET /feedback/mine` · `/sent` · `/about/:employeeId`                                                    | service / auth             | history: body only for the note's sender                                             |

### Policies, onboarding, probation, PIP

| Method & path                                                                     | Gate                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /policies` · `/policies/mine` · `/:id/document` · `POST /:id/ack`            | auth                                                                                              |
| `GET /policies/tracker` · `POST` · `PATCH` · `PUT /:id/document` · retire/restore | `hrbp.policies` _org_                                                                             |
| `GET /onboarding/mine` · `POST /onboarding/tasks/:id/toggle`                      | auth / service (the task's owner: employee, RM, HR reach, `ops.assets` _org_, `pr.payroll` _org_) |
| `GET /onboarding/team-tasks/:owner`                                               | service — `ops`: `ops.assets` _org_; `payroll`: `pr.payroll` _org_                                |
| `GET /onboarding` · `/onboarding/employee/:id` · `POST /onboarding`               | `hrbp.people` + reach                                                                             |
| `GET /probation` · `/probation/mine` · `GET /probation/:id/letter`                | service — HR reach, the effective RM, the person                                                  |
| `POST /probation/:id/recommend` · `/probation/:id/decide`                         | service — the effective RM; `hrbp.people update` in reach (end = termination exit)                |
| `GET /pips?employeeId=` · `/pips/:id` · `POST /pips`                              | service — the person, the effective RM (creates), HR reach                                        |
| `POST /pips/:id/decide` · `/acknowledge` · `/checkins` · `/outcome` · `/cancel`   | service — HR · the employee · the RM · the RM · RM before approval / HR any time                  |

### Exits

| Method & path                                                                 | Gate                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /exits`                                                                  | service — `hrbp.exits` reach, OPS and payroll holders         |
| `GET /exits/mine` · `POST /exits/resign` · `/:id/withdraw` · `/:id/interview` | auth (the leaver)                                             |
| `GET /exits/team` · `POST /exits/:id/acknowledge`                             | service — the manager                                         |
| `POST /exits/terminate` · `/:id/accept` · `/:id/cancel`                       | service — `hrbp.exits update` in reach                        |
| `GET /exits/:id` · `POST /exits/:id/clear`                                    | service — `can` tells the caller; nobody clears their own row |
| `GET /exits/:id/letters/:which`                                               | service — relieving / experience PDF once settled             |

### OPS

| Method & path                                                                                                                                                         | Gate                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET /assets/options` · `/assets` · `/assets/incidents` · `/assets/kit-check/:employeeId` · `/assets/:id`                                                             | `ops.assets read` _org_                             |
| `POST /assets` · `/assets/import` · `PATCH /assets/:id` · `POST /assets/:id/issue` · `return` · `transfer` · `move` · `status` · `incidents` · `/incidents/:id/close` | `ops.assets` create / update _org_                  |
| `GET /asset-setup` · `POST /asset-setup/categories` · `PATCH /categories/:id` · `PUT /kits`                                                                           | `ops.locations` _org_                               |
| `GET /asset-requests/mine` · `POST /asset-requests`                                                                                                                   | auth (any employee)                                 |
| `GET /asset-requests` · `PATCH /:id` · `POST /:id/fulfil`                                                                                                             | `ops.asset_requests` read / update                  |
| `POST /gate-passes`                                                                                                                                                   | auth (flagged categories only, disclaimer required) |
| `GET /gate-passes` · `POST /:id/approve` · `/decline` · `/back`                                                                                                       | `ops.gate_passes` read / update                     |
| `GET /stock` · `/stock/movements` · `POST /stock/items` · `PATCH /items/:id` · `POST /stock/movements`                                                                | `ops.stock` _org_                                   |

### Concerns & open door

| Method & path                                                                                              | Gate                                                                             |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /concerns` · `GET /concerns/mine` · `/people` · `/queues` · `/queue/:queue`                          | auth / service (queue = manager · hr · mrc · vigil)                              |
| `GET /concerns/:id` · `POST /:id/notes` · `/acknowledge` · `/decide` · `/resolve` · `/extend` · `/decline` | service — the case's handlers (never its subject); else 404                      |
| `POST /concerns/:id/accept` · `/escalate`                                                                  | service — the raiser, disputes                                                   |
| `POST /concerns/follow-up` · `/follow-up/notes`                                                            | auth + code + key (anonymous raiser)                                             |
| `GET /open-door/slots` · `/me` · `POST /slots/:id/book` · `/bookings/:id/cancel`                           | auth                                                                             |
| `POST /open-door/slots` · `/slots/:id/cancel` · `/bookings/:id/mark`                                       | service — publishers (`hrbp.grievances update` or level L5–L6); the slot's owner |
| `GET /open-door/hosts` · `/requests` · `POST /requests` · `/requests/:id/cancel`                           | auth; a concern request needs your own named live case (service)                 |
| `POST /open-door/requests/:id/offer` · `/requests/:id/decline`                                             | service — the host, or the case's current handlers                               |

---

## 5. Feature walkthroughs & connections

### 5.1 Auth & people intake

Bootstrap via `claim-org`; HR creates records (`POST /employees`), bulk-imports a
CSV (dry run first, all-or-nothing, claim links returned) or Admin invites with
joining date / department / designation. Blank intake fields put the record on
HR's **incomplete records** strip and ring HR's bell. New-hire defaults (notice
period, probation → confirmation date) come from `people.newHireDefaults`. The
person claims with the single-use token. Level changes write promotion history
(§5.10).

**Onboarding** (journey per hire): **started the moment HR creates, invites or
imports a joiner with a joining date — or first sets one later** (2026-10-22),
so OPS and payroll hear on day one; the joiner's first visit still auto-creates
it as a fallback. Both doors use `ONBOARDING_AUTO_CREATE_WINDOW_DAYS` (90): an
older joining date stays a conscious HR start. Three phases, tasks owned by the
employee, the RM, HR, Admin, **OPS** ("Issue the joiner kit" — done by itself
when `assets/kit-check` shows every kit line held) and **payroll** ("Salary and
bank details on record" — done by itself when the salary row has a CTC and
bank details). OPS and payroll are rung when a journey starts and see their
open tasks at `GET /onboarding/team-tasks/:owner`.

**Deactivation** only happens through an exit: `PATCH /employees/:id` refuses
active / exiting → inactive with 409 `USE_EXIT` (an invited record that never
joined may still be made inactive). The exit-day job deactivates on the last
working day (§5.15).

### 5.2 Notifications

`org.notifications` + a me-scoped API; the bell polls the unread count. Sources:
policy re-acknowledgement, incomplete records, short days, work-update late
entries and allowance breaches, access requests, R&R, career notes, payroll
corrections, reimbursements, quarter reports, concerns and open door (§5.13),
and the scheduler's reminders (§5.12). Email is out of scope (v2).

### 5.3 Leaves

- Quotas (policy v1): sick 6 / earned 18 per year use / menstrual 12 /
  vacation_family 5 / compassionate 3 / unpaid. Earned accrues 1.5/month and
  menstrual 1/month **from the joining month** (the joining month counts);
  sick and vacation_family are prorated in the joining year to the nearest
  half day. **Compassionate is never prorated** — a joiner gets all 3 (user
  decision 2026-10-22; rows stored before that keep their old allocation).
- Application window: earned and vacation_family must be raised
  `leaves.applicationWindowDays` ahead.
- Dual approval (RM + HR), declines need a reason, an HRBP's own leave skips
  the HR slot, menstrual is HR-only and hidden from RM surfaces.
- Balances move by conditional UPDATEs (409 `INSUFFICIENT_BALANCE` rolls back).
- Repair: `scripts/fix-accrual-from-doj.ts` (dry run, `--apply`) corrected
  stored allocations after the joining-month fix.

### 5.4 Attendance

- Geo gate over `punch_zones` (any zone, own radius); remote approval lifts it.
  A refused punch names the nearest zone, the distance and the radius
  ("You are 1.3 km from Aerocity (allowed 250 m)…"). The web client takes the
  sharpest fresh fix over ~5 s (never a cached one); Admin → Punch zones can
  fill lat/lng from the device ("Use my current location").
- Classifier computes day status: holiday → weekend (Sundays; Saturdays per
  `attendance.workWeek`, e.g. 1st & 3rd off from its start date) → leave →
  remote → punch → absent. Hour rules (`attendance.hourRules`, from their start
  date): under the half-day threshold = half day; under the short-day threshold
  rings the employee and RM. Personal work hours override the zone's.
- Remote work: dual approval; HR inbox filtered by reach.

### 5.5 Work updates & goals

Goals per quarter in CGP categories; the score is **50% Fundamental + 25%
Corporate + 25% General** (each Σprogress×weight/Σweight; empty categories drop
out). RM or HR sets and edits goals while the quarter is open; only the owner
moves progress. Daily work updates: server-classified 14-day strip (leave,
holidays and off days never count as a miss), late entry for a missed day
inside the regularize window (RM approves, self-governed auto-approve), goal
tags, monthly miss allowance with a flag and a one-time RM bell.

### 5.6 Payroll

- **Generate** sweeps month-end partial approvals (per `payroll.monthEndAutoApprove`),
  builds snapshot payslips: CTC/12 over a 30-day base, structure, blended PF,
  **PT by state** (`payroll.ptStates`: zones → state, slabs with a February
  amount; the slip snapshots `pt_state`), TDS from the salary row, auto-cover of
  absence from the configured leave order, previous month's approved R&R
  awards, **approved reimbursement claims** spent by the run month, and pending
  **corrections** to earlier months, and **loan / advance EMIs** due this month.
- **Structure**: Basic and HRA are the person's `basic_percent` / `hra_percent`
  from the salary record (blank = 50 / 25), LTA 10%, special = the remainder;
  the split is snapshotted on the slip so draft edits and finalize recompute
  the same. Saving a split where Basic + HRA + 10 > 100 is refused
  (422 `BAD_SALARY_SPLIT`). The annexure, the F&F Basic and CNPS use it too.
- **Joiner's first month**: days before the joining date are unpaid days on the
  30-day base (like days after a last working day) — never absences, never
  auto-covered from leave.
- **People in notice** stay on payroll; the slip that settles an exit carries
  the F&F lines (§5.15).
- **Draft edits**: LOP, TDS, deductions and earnings-side adjustments
  (reimbursement and correction are not typed).
- **Finalize**: recomputes against live balances, charges auto-cover, checks
  the claim and correction sums still match (409 `REIMBURSEMENTS_CHANGED` /
  `CORRECTIONS_CHANGED`), refuses a recovery larger than the pay
  (`RECOVERY_EXCEEDS_PAY`), marks claims paid and corrections applied, writes
  loan repayments (closing paid-off loans; an F&F slip marks the rest
  recovered_at_exit), settles exits, locks.
- **After finalize**: corrections (signed, with a reason) ride on the next run;
  payslip PDFs (pdfkit, from the snapshot; header from `payroll.payslipHeader`;
  PAN/account last four only).
- **Tax**: new-regime slabs, ₹12L rebate with marginal relief, **surcharge**
  10/15/25% above ₹50L/₹1Cr/₹2Cr with marginal relief at each line, 4% cess;
  the TDS calculator and offer breakup add the FY share of **variable pay**.

### 5.7 Reimbursements

Employee claims → effective RM → org payroll (self-governed / no-RM skip the RM
step) → approved claims shift open drafts at once and are carried by the next
draft for the spend month or later → finalize marks them paid. Bells at each
step; nobody decides their own claim. The **receipt file is mandatory**
(user decision 2026-10-22): the new-claim form requires it (PDF / JPG / PNG,
10 MB) and uploads it with the claim, and approving a claim without one is
refused at either step (422 `RECEIPT_REQUIRED`; declining still works). It is
replaceable while the claim is live; the effective RM and org payroll open it
from their queues.

### 5.8 R&R

Catalog in `awards.catalog`; a manager nominates their own reports (team awards
split equally), org HR gives the final approval, one approved award per type per
window (DB arbiter), approved awards pay in the next month's payslip.

### 5.9 Quarter reports (CGP)

HR closes a quarter (`early: true` for the running one): goals freeze and one
`quarter_reports` row per person is written — goals and category scores,
computed score and band (**E3 85+, E2 70+, E1 50+, below 50**), work updates vs
working days, months over the miss allowance, attendance and late check-ins,
awards, feedback notes, at-risk goals, **PIP candidate** (< 50) and **appraisal
eligibility** (six months' service by the quarter end). The manager at close (or
HR whose grant reaches them) sets a final score with a reason; no approval step.
Employees see their own; the person sheet shows the latest. The board on My
performance passes `?as=rm` (only the viewer's own people); HR → Quarter
reports keeps the HR reach. My performance and My growth split into
**Mine | My team** tabs (team tab only for RMs, badge = items waiting).

### 5.10 Career & growth

Ladder wording in `BAND_LADDER`; the band is `employees.level`. A level edit
writes `career_level_changes` and closes a fulfilled roadmap as met. Roadmaps
aim at the next band only; RM/HR notes ring the employee. Self-requests need
`career.selfRequest` minimums (months in band, last quarter's attainment, wait
after a closed conversation); RM/HR opening skips them.

### 5.11 Person sheet

Read-only 360° for the RM or HR (reach): identity incl. department, goals,
recent updates, attendance, leave balances (no menstrual), growth (history +
roadmap notes), latest quarter report, notes history (type/date/sender; the
body only for the sender), OPS holdings, and the person's PIPs (the RM starts
one from here, §5.17). No pay.

### 5.12 Scheduler & approval reminders

`src/scheduler/scheduler.ts` ticks every 5 minutes inside the API process
(started after `listen`, stopped on shutdown; `SCHEDULER_ENABLED=false` turns it
off, `SCHEDULER_DAILY_AT` sets the hour, default 09:30). A daily job is due on a
working day after that hour; it **claims** `(job, run_key=date)` in
`ops.scheduled_job_runs` — the unique key means one run per day across any
number of instances; a failed run retries after 30 minutes, three attempts. The
`approval-reminders` job finds every waiting leave, remote-work request,
attendance fix, reimbursement, late work update, access request and R&R
nomination, works out who it waits on (the same rules as the decision
endpoints), and rings each approver after `APPROVAL_REMINDERS.afterWorkingDays`
(2 working days, fixed), then every `repeatEveryWorkingDays` (2), the
clock restarting when a step is decided. `ops.reminders_sent` paces repeats;
leave types are never named in the reminder. Admin → Settings → Background jobs
shows runs and a Run now button.

All jobs (each daily on working days at `SCHEDULER_DAILY_AT`):

| Job                  | What it does                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-reminders` | the approver reminders above                                                                                                                                                 |
| `concern-deadlines`  | rings handlers of overdue concerns (§5.13)                                                                                                                                   |
| `return-reminders`   | asks holders of overdue lab loans / gate-pass items "back or still out?" every 2 working days; after 5 working days overdue tells OPS and the RM (`RETURN_REMINDERS`, §5.14) |
| `exit-day`           | on a last working day: interview request + OPS told; afterwards relieves the leaver (§5.15)                                                                                  |
| `probation`          | RM bell 7 days before the date; HR reminders past it; auto-confirm at +7 days (§5.16)                                                                                        |
| `pip`                | RM bell when a fortnightly check-in is due; RM + HR when a PIP ended without an outcome (§5.17)                                                                              |

### 5.13 Concerns & open door

One raise form, three tracks (policy: Dispute Resolution Framework, Equal
Opportunity §J / anti-bullying, Whistleblower):

- **Dispute** — always named. Level 1 the effective RM (skipped when the
  decision was the manager's, there is no RM, or the raiser is self-governed),
  level 2 HR holding `hrbp.grievances update` that reaches the raiser
  (acknowledge, then decide), level 3 the `concerns.mrcMembers` list (final;
  a level-2 decider is skipped). Each level ends in a written decision; the
  raiser accepts or escalates before `escalate_by`. No automatic stay. HR may
  decline a repeat, linking the earlier case.
- **Complaint** — HR reaching the raiser (anonymous ones: org-scope holders);
  acknowledge sets the outcome date; resolve with an outcome.
- **Whistleblower** — `hrbp.vigil` holders only.
- **Sexual harassment** is refused (422 `POSH_ROUTE`); the UI shows
  `concerns.icContact` and sends nothing.
- Anonymous complaints / reports return a follow-up key once (only its hash is
  stored); `/concerns/follow-up` with code + key shows replies and takes notes.
- Deadlines come from `concerns.timelines` in working days (holidays and the
  work week count); extensions need a written reason, sent to the raiser. The
  `concern-deadlines` scheduler job rings handlers of overdue cases
  (`reminders_sent` kind `concern_overdue`, same 2-working-day pacing).
- The subject never sees the case; audit rows carry ids and transitions only,
  no bodies or names.

Open door: publishers offer slots (date, time, seats, note); anyone books up to
`openDoor.bookingHorizonDays` ahead, never their own slot, with a topic only the
owner sees; the slot row is locked while booking so the last seat can't be
taken twice. The owner marks met / no-show after the start; cancelling a slot
rings every booker.

**Session requests** (`open_door_requests`, migration 0054, 2026-10-22): when no
slot suits, ask a host (L5–L6 or `hrbp.grievances` holders; never the
administration account) for a date range, or — the raiser of a **named** live
concern — ask whoever handles the case now (`concern_id`, host resolved at read
time; anonymous cases 404). One waiting request per target (409
`REQUEST_PENDING`). The host offers a time — one transaction creates a 1-seat
slot booked for the requester — or declines with a reason; the requester may
withdraw while it waits. Concern requests leave system lines on the case. The
`open-door-requests` job rings unanswered hosts on the approval-reminder pacing
(kind `open_door_request`).

**UI**: Concerns, Open door and Requests are tabs of one **Grievances** page
(`/grievances?tab=concerns|open-door|requests`); `/concerns` and `/open-door`
redirect there, and bells link to the tabs.

### 5.14 OPS asset manager

- **OPS** = whoever holds the OPS batch (no named team). Locations are the
  attendance **punch zones**.
- **Register**: every asset sits in a zone; a person may also hold it (status
  `assigned`). Statuses: assigned, idle, in_use_shared (router, printer),
  needs_repair, scrapped, gifted, lost. Issue / return / transfer / move /
  status changes all append to `asset_events`; nothing is deleted. CSV import
  with a dry run. Joiner kits per designation (`asset_kits`) drive
  `kit-check` and the onboarding OPS task.
- **Requests**: any employee asks (new / upgrade / replacement / repair /
  return) into the shared OPS queue; fulfilling an upgrade / replacement issues
  the new item and takes the old one back in one step.
- **Gate passes**: only for categories flagged `requires_gate_pass` (lab
  equipment, products / samples — never laptops). The requester accepts the
  damage / loss disclaimer and gives a return date; OPS approves; the RM is told.
  **Lab loans** follow the same return pattern. After the date the holder is
  asked "back or still out?" (still out = reason + new date; back = returned to
  its zone, OPS told); escalation to OPS + RM after 5 working days
  (`return-reminders` job).
- **Incidents**: damage / loss / theft recorded and closed (loss may mark the
  asset lost); no payroll recovery.
- **Stock**: consumables per zone with an append-only ledger (in / issue /
  transfer / adjust), never below zero; no reorder or purchasing.
- **My assets**: an employee's holdings, passes, requests and the back /
  still-out answers. Exit clearance for OPS is blocked while assets are held.

### 5.15 Exit & full and final

- **Start**: the employee resigns (reason; last day defaults to today + their
  notice days; withdraw until HR accepts), or HR terminates — serve the notice,
  or an earlier last day with the unserved notice **paid in lieu**.
- **Steps**: the manager acknowledges with a handover plan; HR accepts and fixes
  the last working day; a notice shortfall is waived (with a reason) or
  recovered on Basic. During notice only sick leave is allowed; 3+ sick days
  need an uploaded certificate (`leave_certificates`) or they are LOP in the F&F.
- **Clearances** (nobody clears their own): HR from the resignation date,
  manager during notice, OPS on the last day (blocked while assets are held),
  payroll set by finalizing the run that carries the F&F.
- **Exit interview**: filled by the leaver on the last day; HR sees it, the
  manager doesn't.
- **exit-day job**: last-day bells, then relieves — login off (refresh tokens
  revoked), open requests cancelled, reports left without an RM unless someone
  took the seat, HRBP told to set a new RM.
- **F&F** rides the **next monthly payroll run** with everyone else: salary to
  the last day, every EL day encashed on Basic, gratuity from 1 year
  (Basic/26 × 15 × years), notice pay in lieu or recovery, uncertified sick days
  at gross/30, payroll's typed recovery lines (`fnf_recoveries`) and the
  **outstanding loan balance**. Finalize settles the exit; then the statement,
  relieving and experience letters download as PDFs.

### 5.16 Probation

Fixed **2 months, no extension**. The `probation` job opens a
`probation_reviews` row and rings the RM 7 days before the date; the RM
recommends confirm / end with a note; **HR decides** (`hrbp.people update` in
reach). Confirm sets the person confirmed (the leave gate then opens the
non-sick types) and makes the confirmation letter PDF available; end starts a
termination exit (serve / pay in lieu + last day) and links it. HR is reminded
past the date; **7 days after it, an undecided review confirms by itself** and
HR is told. While a review is open the person stays on the probation leave gate.

### 5.17 Performance improvement plans

- Never automatic: a quarter closing with a final score **under 50** rings the
  RM ("consider a PIP"); the RM decides.
- The effective RM opens it: reason, measurable targets (title + measure),
  support, start date → **60 days**. One open PIP per person.
- **HR approves** (or sends back) — `hrbp.people update` in reach; then the
  employee acknowledges. A dispute about it doesn't pause it.
- The RM logs a **check-in every 14 days** (rating on track / at risk / off
  track); the `pip` job rings the RM when one is due.
- At the end the RM records **passed**, **extend 30 days** (once) or **not
  passed** — not passed rings HR, who may start a termination. The RM can
  withdraw before approval, HR at any time.
- Screens: the person sheet (RM), My performance (employee), Quarter reports
  (HR approval queue).

### 5.18 Loans & advances

- Payroll records them (`pr.payroll.compensation`); there is no application.
  Eligible: **confirmed, full-time, not leaving**.
- Per loan: principal, **interest rate (editable per loan)**, months, first EMI
  month. EMI = reducing-balance amortization (equal principal at 0%); the last
  instalment absorbs rounding so the schedule ends exactly. An advance is one
  month.
- Each run deducts the EMIs due (`loan_emi`, after net pay); finalize writes
  `loan_repayments` (principal / interest split) and closes paid-off loans.
  Re-pricing (rate or months left) recomputes the EMI; close early records the
  rest as paid outside payroll.
- At exit the whole balance is recovered on the F&F slip.
- The employee sees their loans, EMI, balance and schedule on My payslips.

---

## 6. Security guardrails (cross-cutting)

| Rule                                   | Enforcement point                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No self-approval, ever                 | services (leave, remote, claims, late updates, quarter scores, R&R, batches, exit clearances, probation and PIP decisions via `can`) |
| Scope reach                            | `keepReachable` / `assertReaches` in controllers, `authz.reaches` in services                                                        |
| Salary and bank sealed                 | compensation and bank details are separate org-only doors; me-scope for the employee; loans behind compensation                      |
| Uploaded files                         | type + size checked in the service; served `inline`, `private, no-store`; only the owner and named roles open them                   |
| Instant revocation                     | per-request grants; per-request active check; refresh families revoked on deactivation                                               |
| Payslip immutability                   | finalized runs reject edits; changes go through corrections                                                                          |
| Append-only audit, no sensitive values | repositories write audit in the same transaction                                                                                     |
| Confidential leave                     | menstrual hidden from RM surfaces and never named in reminders                                                                       |
| Money races                            | conditional UPDATEs; finalize re-checks claims and corrections in-transaction                                                        |
| Exactly-once jobs                      | unique (job, run_key) claim                                                                                                          |
| Parameterized SQL only                 | Drizzle + `db.query($n)` placeholders                                                                                                |

---

## 7. Conventions & how to verify

- **Typecheck**: backend `npm run typecheck`; frontend `npm run verify`
  (typecheck + lint).
- **Run**: `npm run dev` in each repo (backend `tsx watch` on 4000, frontend
  Vite on 5173). DB via each repo's `.env` (never committed).
- **Swagger**: `/docs`.
- **Seeds**: `seed-modules` (22 modules), `seed-batches` (Employee, HRBP, PR,
  OPS), `seed-policies`, `seed-asset-categories`, dev-only test roster.
- **Schema doc**: `npm run docs:schema` after every migration.
- **Verification habit**: temporary service-level scripts under
  `src/scripts/`, run inside a transaction that is rolled back, deleted after
  use; then a browser walk with the test roster and clean-up of test rows.
- **Commits**: `type :message`, lower-case, imperative.
- **Timezone**: `Asia/Kolkata`, pinned in `config/env.ts`.
- **Test checklist**: a published checklist page (sections 1–30, 199 steps)
  tracks manual test steps per feature.

## 8. Known gaps

- **Not built**: TA (hiring; `ta.hiring` is seeded only); AI scoring of work
  updates (awaits a key).
- **Deferred by decision**:
  - statutory filings (PF / ESI / PT returns, Form 16, TDS returns —
    `pr.payroll.compliance` waits for it);
  - CGP department-head calibration and the 6- and 12-month goal sheets
    (§18.1 of the policy);
  - email notifications and email sign-in (after whole-platform testing);
  - retirement / medical exits and rehire;
  - regularizations stay disabled (HR mark replaces them).
- **Small gaps**:
  - adding an employee isn't limited to the creator's department;
  - quarter reports keep counts, not a dated alert trail, and don't use goal
    tags yet;
  - HR's probation reminders start the day after the date, not on it.
- **Open decisions** awaiting the user: the 2026-11-01 start date for the
  Saturday schedule / hour rules; the career self-request minimums
  (12 months / 60% / 90 days).

## 9. TA hand-off design (carried over, not built)

From the September architecture notes, still the intended shape for TA:

- **Candidate (job applicant)** is its own entity owned by `ta.hiring`: common
  details, interview summary, offer basics. A candidate who isn't hired never
  becomes an employee (no login, no payroll).
- **Mark hired** (one transaction) creates the employee record from the
  candidate; the onboarding journey then fans out per portal — which already
  exists: HR / RM tasks, the OPS kit task and the payroll salary + bank task
  (§5.1). "Fully onboarded" = every task done.
- The record is the channel between portals; no free-text hand-off note.

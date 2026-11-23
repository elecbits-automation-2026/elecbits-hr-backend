# elecbits-hr-backend

Backend for the Elecbits HRMS: people and org structure, batch-based access control
(`(module, action, scope)` grants), leaves, attendance, performance, payroll, OPS asset
management, exits and full & final, probation, PIPs — per the design document
`elecbits-hrms-design.md`.

**Docs:** [`docs/technical-reference.md`](docs/technical-reference.md) (architecture,
access model, tables, endpoint catalog, feature walkthroughs, known gaps) and
[`docs/database-schema.md`](docs/database-schema.md) (generated — `npm run docs:schema`).
Live API docs at `/docs` (Swagger).

**Stack:** Node 22 · Express 4 · TypeScript (ESM) · Drizzle ORM · PostgreSQL · Zod · pino.
**No Supabase.** Auth is local JWT (company-email only); the database is a local Postgres
for now and moves to AWS RDS Postgres once DevOps provisions the server (only `.env`
changes: `DATABASE_URL` + `PGSSL`/`PGSSL_CA`).

## Getting started

```bash
npm install
copy .env.example .env          # Windows; on macOS/Linux use cp. Then edit DATABASE_URL etc.
createdb elecbits_hr            # or create the DB in pgAdmin

npm run db:migrate                   # apply every migration (works on an empty DB in one run)
npm run db:seed-modules              # 1. the grantable module tree
npm run db:seed-batches              # 2. baseline batches (Employee, HRBP, PR, OPS)
npm run db:seed-policies             # 3. starter policy library
npm run db:seed-asset-categories     # 4. OPS asset categories

npm run dev                          # http://localhost:4000, docs at /docs
```

### Test data (never in production)

Run these **after** steps 1–4, in this order. Both refuse `NODE_ENV=production`.

```bash
npm run db:seed-test-employees       # 5. claims the org as OWNER_CLAIM_EMAIL if nobody has,
                                     #    then the 13-person roster (password test1234),
                                     #    incl. a test-only "TA (test)" batch for pooja.ta@
npm run db:seed-test-activity        # 6. Jul → yesterday: punches, leave, remote work, goals,
                                     #    Q3 closed, career, awards, claims (one-shot; --force to rerun)
```

### Tests

```bash
npm test                             # needs DATABASE_URL pointing at a THROWAWAY database
```

The suite drops and rebuilds that database's schemas, runs every migration, the
seeds above, then boots the app in-process and drives real multi-role flows over
HTTP. It refuses to run when the database name doesn't contain `test`, `e2e` or
`ci`, or when `NODE_ENV=production`. CI runs the same thing on a `postgres:16`
service (`.github/workflows/ci.yml`).

## Layout

```
src/
├── app.ts / server.ts     # createApp() builds; server.ts runs (fail-fast boot, graceful shutdown)
├── config/                # env.ts (the ONLY process.env reader), logger.ts (pino)
├── db/                    # client.ts (DbClient seam), schema/ (org, access, ops + users)
├── middleware/            # authenticate (JWT), authorize (requireAccess), validateBody, errors, logging
├── routes/                # health probes + the /api/v1 router
├── docs/                  # OpenAPI generated from the feature Zod schemas (/docs)
├── scheduler/             # in-process daily jobs (reminders, exit day, probation, PIP)
├── scripts/               # migrate, seeds, gen-schema-doc, one-off repairs
├── shared/                # zod (openapi-extended), constants, helpers, request typing
└── features/              # one folder per domain, split by layer (26 — listed in
                           # docs/technical-reference.md §1.2)
```

Each feature follows `routes → controller → service → repository → DbClient`; see
`CLAUDE.md` for the house rules. `TODO(skeleton)` marks business rules from the design
doc that are specified but not yet implemented (grant resolution, org claim transaction,
exit close checks, no-cycle walk, audit-log writes).

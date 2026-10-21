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
copy .env.example .env          # then edit DATABASE_URL etc.
createdb elecbits_hr            # or create the DB in pgAdmin

npm run db:generate -- --name init   # generate SQL migrations from src/db/schema
npm run db:migrate                   # apply them
npm run db:seed-modules              # seed the grantable module tree

npm run dev                          # http://localhost:4000, docs at /docs
```

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

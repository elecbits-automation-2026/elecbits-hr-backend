# CLAUDE.md

Guidance for Claude (and any AI assistant) working in this repository. These are the
house rules — the same conventions as the XOR enterprise backend, applied to the HRMS.
When in doubt, **match the surrounding code**.

## 1. Golden rules

1. **Match the existing code.** Naming, comment density, file layout, error handling.
2. **Functions, not classes.** Factory functions with explicit dependency injection —
   no `class`/`new`/`this` outside `src/db/client.ts` (the one deliberate exception).
   Derive types with `ReturnType<typeof createX>`, never a hand-written interface.
3. **Respect the layers.** Routes/controllers → middleware → services → repositories →
   `DbClient`. Never skip a layer (no SQL in a controller).
4. **The database is reached only through `DbClient`.** Do not import `drizzle-orm` or
   `pg` anywhere except `src/db/client.ts`, `src/db/schema/`, the repository layer, and
   `src/scripts/`.
5. **Read `process.env` only in `src/config/env.ts`.** Everything else imports `env`.
6. **No `console.*`.** Use the pino logger; `req.log` inside request flow. Structured
   (`log.info({ id }, 'msg')`), secret-free, level chosen deliberately.
7. **It must typecheck.** `npm run typecheck` passes before anything is "done".
8. **Never commit secrets.** Placeholders only in `.env.example`.
9. **NO SUPABASE.** No Supabase client, auth, RLS helpers, or storage — anywhere.
   Auth is local JWT; the DB is plain Postgres (local now, AWS RDS later).
10. **Document every endpoint in Swagger** via the feature's `<name>.docs.ts` — request
    and response schemas are the same Zod used at runtime; wire the register function
    into `src/docs/openapi.ts` once per feature.

## 2. Feature module layout

```
src/features/<feature>/
├── <feature>.routes.ts       # Router: authenticate + requireAccess + validateBody + controller
├── <feature>.controller.ts   # HTTP only; composition root builds the service from req.db
├── <feature>.service.ts      # business rules (the design-doc sections); no HTTP, no SQL
├── <feature>.repository.ts   # the ONLY place that touches the DB (via injected DbClient)
├── <feature>.schema.ts       # Zod request + response schemas (.openapi() tagged)
├── <feature>.types.ts        # row + z.infer<> DTO types (larger features)
├── <feature>.dto.ts          # pure row -> DTO mappers (larger features)
├── <feature>.docs.ts         # registerPath(...) entries for /docs
└── index.ts                  # public surface (router + docs register + public types)
```

Multi-resource domains (`access/`, `ops/`) hold several filesets in one folder, one
`index.ts`. `TODO(skeleton)` comments mark specified-but-unimplemented rules from the
design doc — implement them where they sit; don't relocate the logic.

## 3. Database rules

- Schema lives in `src/db/schema/` (Postgres schemas `org`, `access`, `ops` + `users`).
- Migrations: `npm run db:generate -- --name <desc>` → review SQL → `npm run db:migrate`.
  Never hand-edit generated SQL, never `drizzle-kit push`. Commit the `.sql` and
  `migrations/meta/` journal together. Then `npm run docs:schema` and commit the
  regenerated `docs/database-schema.md` with them.
- Parameterize every query. Mutations that matter are transactional and write their
  `access.audit_log` row in the same `transaction()` (design doc §10).
- Grants are checked server-side per request — never cached into a JWT (§9/§10:
  revocation must be immediate).

## 4. Design-doc invariants (enforce at the data/service layer, not the UI)

- Company email only; one Owner (DB singleton); no self-approval; no reporting cycles;
  deactivate never delete; append-only audit log; batch edits apply live and are logged.
- Level suggests defaults, never grants access. RM is a relationship, not a level.
- Rights levels (Viewer/Contributor/Editor/Manager) are action-sets written into
  `batch_grants`, not a schema concept. Parent-module grants do NOT cascade to children.

## 5. Commits

`type :message` (note the space), lower-case, imperative — `feat :add exit auto-clear`.
Allowed types: feat, fix, docs, chore, refactor, test, build, ci.

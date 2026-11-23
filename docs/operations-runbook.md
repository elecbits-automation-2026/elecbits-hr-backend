# Operations runbook — Elecbits HRMS backend

How the Production API is kept safe, how to tell when it breaks, and how to get
it back. Written 23 Nov 2026; keep it next to the code it describes and update
it when the deploy or the database changes.

| Piece           | Where                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| API             | Docker container on EC2, deployed by `.github/workflows/main.yml` on every push to `main`                                       |
| Database        | AWS RDS PostgreSQL (`ap-south-1`)                                                                                               |
| Uploaded files  | In the database today (`STORAGE_DRIVER=db`); Google Shared Drive once `STORAGE_DRIVER=drive` is switched on (see "Files" below) |
| Background jobs | In-process scheduler, one run per job per day, recorded in `ops.scheduled_job_runs` (Admin → Jobs)                              |

---

## 1. Health probes

| Path                | Meaning                                                   | Use it for                                            |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `GET /health`       | The process is up. Touches nothing else.                  | Load balancer / container liveness. Keep as is.       |
| `GET /ready`        | The database answers. 503 when it doesn't.                | The deploy waits on this before switching containers. |
| `GET /health/ready` | Same as `/ready`, plus `dbLatencyMs` and `uptimeSeconds`. | External uptime monitors (below).                     |

A slow `dbLatencyMs` (hundreds of ms on an idle system) is an early warning of
RDS CPU or connection trouble.

## 2. Uptime check (GitHub Actions, no extra service)

`.github/workflows/uptime.yml` probes `PROD_HEALTH_URL` every 15 minutes, three
tries 20 s apart. A failed run emails whoever watches the repo's Actions.

One-time setup:

1. Repo → Settings → Secrets and variables → Actions → **Variables** →
   `PROD_HEALTH_URL` = `https://<api host>/health/ready`.
2. Each person who should be paged: GitHub → Settings → Notifications →
   Actions → **"Send notifications for failed workflows only"** (email on).
3. Run it once by hand (Actions → Uptime check → Run workflow) to confirm.

Until step 1 is done the workflow passes without checking anything.

GitHub's schedule can run a few minutes late under load. For alerts within a
minute, add a Route 53 health check on the same URL → CloudWatch alarm → SNS
email/SMS (about $1/month) — see `D:\HRMS-Monitoring-Plan.md` layer 1.

## 3. Backups (RDS)

Check these on the RDS console → the instance → **Maintenance & backups**, and
again after anyone changes the instance:

- [ ] **Automated backups: enabled**, retention **at least 7 days** (14 is
      better for payroll month-end mistakes noticed late).
- [ ] **Point-in-time recovery** is available (it is, whenever automated
      backups are on) — "Latest restorable time" should be within 5 minutes.
- [ ] **Deletion protection: enabled** (Modify → Deletion protection).
- [ ] A **manual snapshot** before risky work: a migration that rewrites data,
      a bulk import, the `files:to-drive` move. Name it
      `hrms-before-<what>-<yyyy-mm-dd>`.
- [ ] Production and testing use **different** RDS instances. (As of 23 Nov
      2026 this is unconfirmed — the deploy reported the testing migration
      count. Confirm in Secrets Manager and split them first.)

Files in the database are inside these backups. Once files move to Drive,
Drive's own version history and the Shared Drive's admin recovery cover them;
the database keeps only their ids.

## 4. Monthly restore drill (30 minutes)

A backup that has never been restored is a hope, not a backup. Once a month,
and after any change to migrations:

1. **Restore**: RDS → the instance → Actions → _Restore to point in time_ →
   latest restorable time → new identifier `hrms-restore-drill-<yyyymm>`,
   smallest instance class, **no public access**, same VPC/security group.
2. **Point a throwaway checkout at it** (from a machine inside the VPC or via
   the bastion), with a `.env` that has `DATABASE_URL` for the restored
   instance and `PGSSL=true`.
3. **Migrations still apply**: `npm run db:migrate` must say
   `No migrations to apply` (or apply only migrations newer than the backup).
4. **Spot-check data**, read-only:
   ```sql
   select count(*) from org.employees where status = 'active';
   select month, status from org.payroll_runs order by month desc limit 3;
   select max(created_at) from access.audit_log;
   ```
   The newest audit row should be within minutes of the restore point.
5. **Fresh-database check** (proves a rebuild from scratch works — the
   23 Nov 2026 fix made `db:migrate` succeed on an empty database in one run):
   on a local Postgres, `createdb hrms_drill_test && DATABASE_URL=... npm test`.
   CI does the same on every pull request.
6. **Delete** the restored instance (Actions → Delete, no final snapshot) and
   note the date and result in the table below.

| Month | Restored to | Migrate | Data check | By  |
| ----- | ----------- | ------- | ---------- | --- |
|       |             |         |            |     |

## 5. Logs

- The container logs JSON (pino) to stdout; every request line carries a
  `requestId`, which is also returned to the browser in error bodies — ask the
  person reporting a problem for it.
- On the EC2 host: `docker logs --since 1h <container> | grep '"level":50'`
  (50 = error, 40 = warn). The container name is in the deploy workflow
  (`CONTAINER_NAME`).
- Logs on the host are lost when the container is replaced. To keep them, run
  the container with the `awslogs` log driver (CloudWatch Logs) — monitoring
  plan layer 2.
- Secrets, tokens and passwords are redacted by the logger; salary and bank
  values are never logged.

## 6. When an alert fires

1. **GitHub Actions** → did a deploy just fail or half-finish?
2. `curl https://<api host>/health/ready` → `db: false` means the database;
   connection refused means the container.
3. **Container**: `docker ps` on EC2; `docker logs --tail 200 <container>`.
4. **RDS console**: status, CPU, free storage, connections.
5. **Roll back**: re-run the deploy for the previous image tag (images are
   tagged by commit). Migrations only move forward; a bad migration needs a
   new fixing migration, or a point-in-time restore taken before the deploy.
6. Write down what happened and what would have caught it sooner.

## 7. Files (Google Drive storage)

- `STORAGE_DRIVER=db` (default): bytes live in the database rows.
- `STORAGE_DRIVER=drive` + `GOOGLE_SERVICE_ACCOUNT_KEY` + `DRIVE_SHARED_DRIVE_ID`:
  new uploads go to the Shared Drive; rows keep only `drive_file_id`. If the
  key or drive id is missing the app logs a warning and stays on `db`.
- Moving existing files: take a manual snapshot (section 3), then
  `npm run files:to-drive -- --dry-run` (counts only), then without
  `--dry-run`. It is resumable: each row is uploaded, checked (size + MD5 from
  Drive) and only then has its bytes cleared.

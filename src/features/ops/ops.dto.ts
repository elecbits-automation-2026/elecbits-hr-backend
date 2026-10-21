import type { AssetDto, AssetEventDto, AssetIncidentDto } from './assets.schema.js';
import type {
  EventViewRow,
  IncidentViewRow,
  PassSummaryRow,
} from './assets.repository.js';
import type { AssetViewRow, CategoryRow } from './ops.repository.js';

/** Pure row -> DTO mappers shared by the OPS filesets. */

const ref = (id: string | null, name: string | null) =>
  id ? { id, name: name ?? '' } : null;

export const toCategory = (c: CategoryRow) => ({
  id: c.id,
  name: c.name,
  codePrefix: c.codePrefix,
  kind: c.kind,
  requiresGatePass: c.requiresGatePass,
});

/** `today` is the local ISO date: anything due before it is overdue. */
export const toAsset = (r: AssetViewRow, today: string): AssetDto => ({
  id: r.id,
  assetCode: r.asset_code,
  name: r.name,
  category: {
    id: r.cat_id,
    name: r.cat_name,
    codePrefix: r.cat_prefix,
    kind: r.cat_kind,
    requiresGatePass: r.cat_gate,
  },
  status: r.status,
  zone: { id: r.zone_id, name: r.zone_name },
  holder: ref(r.holder_id, r.holder_name),
  loanDueOn: r.loan_due_on,
  loanOverdue: r.status === 'assigned' && !!r.loan_due_on && r.loan_due_on < today,
  make: r.make,
  model: r.model,
  serialNo: r.serial_no,
  purchasedOn: r.purchased_on,
  purchaseCost: r.purchase_cost === null ? null : Number(r.purchase_cost),
  vendor: r.vendor,
  warrantyUntil: r.warranty_until,
  condition: r.condition,
  notes: r.notes,
  giftedTo: ref(r.gifted_to, r.gifted_name),
  disposedOn: r.disposed_on,
  disposeReason: r.dispose_reason,
  openPass:
    r.pass_id && r.pass_status && r.pass_holder_id && r.pass_return_on
      ? {
          id: r.pass_id,
          status: r.pass_status,
          holder: { id: r.pass_holder_id, name: r.pass_holder_name ?? '' },
          returnOn: r.pass_return_on,
          overdue: r.pass_status === 'approved' && r.pass_return_on < today,
        }
      : null,
  createdAt: r.created_at.toISOString(),
});

export const toEvent = (e: EventViewRow): AssetEventDto => ({
  id: e.id,
  kind: e.kind,
  employee: ref(e.employee_id, e.employee_name),
  zone: ref(e.zone_id, e.zone_name),
  status: e.status as AssetEventDto['status'],
  condition: e.condition as AssetEventDto['condition'],
  dueOn: e.due_on,
  prevDueOn: e.prev_due_on,
  note: e.note,
  by: ref(e.by_id, e.by_name),
  at: e.at.toISOString(),
});

export const toIncident = (i: IncidentViewRow): AssetIncidentDto => ({
  id: i.id,
  asset: { id: i.asset_id, assetCode: i.asset_code, name: i.asset_name },
  employee: ref(i.employee_id, i.employee_name),
  kind: i.kind,
  description: i.description,
  reportedBy: { id: i.reported_by, name: i.reporter_name },
  status: i.status,
  outcome: i.outcome,
  closedBy: ref(i.closed_by, i.closer_name),
  closedAt: i.closed_at?.toISOString() ?? null,
  createdAt: i.created_at.toISOString(),
});

export const toPassSummary = (p: PassSummaryRow) => ({
  id: p.id,
  holder: { id: p.holder_id, name: p.holder_name },
  purpose: p.purpose,
  destination: p.destination,
  status: p.status,
  returnOn: p.return_on,
  createdAt: p.created_at.toISOString(),
});

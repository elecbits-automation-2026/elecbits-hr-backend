import type { AssetChange, AssetRow } from './ops.repository.js';

/**
 * Pure builders for the two custody moves several OPS flows share (the
 * register's issue / return, and fulfilling a request) — so the history row,
 * audit row and bells are the same whichever screen did it.
 */

const MY_ASSETS = '/my-assets';
const label = (a: { name: string; assetCode: string }) => `${a.name} (${a.assetCode})`;

/** Hand an idle / shared asset to a person (with a due date when it is lent). */
export const issueChange = (
  a: AssetRow,
  person: { id: string },
  zoneId: string,
  dueOn: string | null,
  note: string | null,
): AssetChange => ({
  assetId: a.id,
  expect: { status: a.status, holderId: null },
  patch: { status: 'assigned', holderId: person.id, zoneId, loanDueOn: dueOn },
  event: {
    kind: 'issued',
    employeeId: person.id,
    zoneId,
    status: 'assigned',
    dueOn,
    note,
  },
  audit: { action: 'ops.asset_issued', detail: { employeeId: person.id, zoneId } },
  bells: [
    {
      to: [person.id],
      event: {
        type: 'ops.asset_issued',
        title: `OPS issued you ${label(a)}${dueOn ? ` — due back ${dueOn}` : ''}`,
        link: MY_ASSETS,
      },
    },
  ],
});

/** Take a held asset back: holder cleared, condition recorded, where it goes next. */
export const returnChange = (
  a: AssetRow & { holderId: string },
  condition: AssetRow['condition'],
  toStatus: 'idle' | 'in_use_shared' | 'needs_repair',
  note: string | null,
): AssetChange => ({
  assetId: a.id,
  expect: { status: 'assigned', holderId: a.holderId },
  patch: { status: toStatus, holderId: null, loanDueOn: null, condition },
  event: {
    kind: 'returned',
    employeeId: a.holderId,
    zoneId: a.zoneId,
    status: toStatus,
    condition,
    note,
  },
  audit: { action: 'ops.asset_returned', detail: { employeeId: a.holderId, condition } },
  bells: [
    {
      to: [a.holderId],
      event: {
        type: 'ops.asset_returned',
        title: `OPS took back ${label(a)}`,
        link: MY_ASSETS,
      },
    },
  ],
});

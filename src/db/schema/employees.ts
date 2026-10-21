import {
  boolean,
  date,
  index,
  integer,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { departments, orgSchema } from './departments.js';
import { employeeStatusEnum, levelEnum } from './enums.js';

/**
 * The employee record (§2.1). Every person in the company — including HR staff —
 * is first and foremost an Employee; portal capability comes from batches, not
 * from this table.
 *
 *  - `reportsTo` is a RELATIONSHIP, not a level (§2.2): a self-reference from
 *    which direct reports, the whole team subtree, and the org chart derive.
 *    NULL only for the root of the tree (the Owner).
 *  - No reporting cycles — a hard constraint (§10). The check is procedural
 *    (service + a DB trigger to be added in SQL migration), since Drizzle
 *    cannot express a recursive constraint declaratively.
 *  - Level suggests defaults, never grants access (§2.3). A manager's level
 *    being below a report's is a WARNING in the service layer, not a block.
 *  - Deactivate, never delete (§10): `status` flips to `inactive` on exit.
 */
export const employees = orgSchema.table(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    phone: text('phone'),
    // The human-readable employee ID HR hands out (e.g. "EB-0042").
    employeeCode: text('employee_code').notNull().unique(),
    // Company email — required for sign-in; no outsiders (§2.1, §5.4).
    email: text('email').notNull().unique(),
    departmentId: uuid('department_id').references(() => departments.id),
    level: levelEnum('level').notNull(),
    reportsTo: uuid('reports_to').references((): AnyPgColumn => employees.id),
    status: employeeStatusEnum('status').notNull().default('invited'),

    // --- Overview (self-serve after claiming; `name` stays the full name) ---
    salutation: text('salutation'),
    firstName: text('first_name'),
    middleName: text('middle_name'),
    lastName: text('last_name'),
    // Free text, not an enum: the value list is a presentation concern.
    gender: text('gender'),
    dateOfBirth: date('date_of_birth'),

    // --- Company details (org-controlled, HRBP edits via /employees) --------
    designation: text('designation'),
    // intern | permanent | contract — validated at the API boundary.
    employmentType: text('employment_type'),

    // --- Joining (org-controlled) -------------------------------------------
    dateOfJoining: date('date_of_joining'),
    confirmationDate: date('confirmation_date'),
    noticeDays: integer('notice_days'),
    // Personal workday (HH:mm), HR-edited — overrides the base zone's hours for
    // punctuality dots and hour rules (refinement plan, Phase 2). Both or neither.
    workStart: text('work_start'),
    workEnd: text('work_end'),
    offerDate: date('offer_date'),

    // --- Contacts & address (self-serve; company email stays `email`) -------
    personalEmail: text('personal_email'),
    // 'company' | 'personal' — which inbox the person wants mail in.
    preferredContactEmail: text('preferred_contact_email'),
    unsubscribed: boolean('unsubscribed').notNull().default(false),
    currentAddress: text('current_address'),
    permanentAddress: text('permanent_address'),

    // Where this person is based (a punch zone) — drives their work schedule
    // for punctuality and lets HR filter attendance by location. Plain uuid
    // (no FK): punch_zones lives in attendance.ts, which imports this file —
    // a declared reference would create a module cycle. Integrity is held at
    // the service layer (zone looked up on write), like other soft links.
    baseZoneId: uuid('base_zone_id'),

    // --- Claim security ------------------------------------------------------
    // A record can be claimed only with the single-use invite token issued at
    // create/invite time (or reissued by HR). Only the sha256 HASH is stored;
    // the token itself is shown once to the inviter. Cleared on claim.
    claimTokenHash: text('claim_token_hash'),
    claimTokenExpiresAt: timestamp('claim_token_expires_at', { withTimezone: true }),

    // --- Approvers (org-controlled; people, like reportsTo) -----------------
    expenseApprover: uuid('expense_approver').references((): AnyPgColumn => employees.id),
    shiftRequestApprover: uuid('shift_request_approver').references(
      (): AnyPgColumn => employees.id,
    ),
    leaveApprover: uuid('leave_approver').references((): AnyPgColumn => employees.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('employees_reports_to_idx').on(t.reportsTo),
    index('employees_department_idx').on(t.departmentId),
  ],
);

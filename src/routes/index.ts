import { Router } from 'express';
import { authRoutes } from '../features/auth/index.js';
import { meRoutes } from '../features/me/index.js';
import { employeesRoutes } from '../features/employees/index.js';
import { departmentsRoutes } from '../features/departments/index.js';
import {
  auditRoutes,
  batchesRoutes,
  grantRequestsRoutes,
} from '../features/access/index.js';
import {
  assetRequestsRoutes,
  assetSetupRoutes,
  assetsRoutes,
  gatePassesRoutes,
  myAssetsRoutes,
  stockRoutes,
} from '../features/ops/index.js';
import { exitsRoutes } from '../features/exits/index.js';
import { probationRoutes } from '../features/probation/index.js';
import { pipRoutes } from '../features/pip/index.js';
import { leavesRoutes } from '../features/leaves/index.js';
import { attendanceRoutes } from '../features/attendance/index.js';
import { payrollRoutes } from '../features/payroll/index.js';
import { reimbursementsRoutes } from '../features/reimbursements/index.js';
import { feedbackRoutes } from '../features/feedback/index.js';
import { policiesRoutes } from '../features/policies/index.js';
import { onboardingRoutes } from '../features/onboarding/index.js';
import { recognitionsRoutes } from '../features/recognitions/index.js';
import { careerRoutes } from '../features/career/index.js';
import { goalsRoutes, workUpdatesRoutes } from '../features/performance/index.js';
import { quarterReportsRoutes } from '../features/quarter-reports/index.js';
import { settingsRoutes } from '../features/settings/index.js';
import { notificationsRoutes } from '../features/notifications/index.js';
import { jobsRoutes } from '../features/jobs/index.js';
import { concernsRoutes } from '../features/concerns/index.js';
import { openDoorRoutes } from '../features/open-door/index.js';

/**
 * Versioned API router — everything mounts under /api/v1.
 *
 * There is ONE organization and one API tree (no multi-tenancy, §5.1). The
 * four HR portals (TA / HRBP / PR / OPS) are not separate front doors the way
 * the XOR demo splits customer/vendor/platform — they are overlapping
 * capability sets on the same employee (§1), so portal separation happens in
 * the ACCESS layer (`requireAccess` + module keys like `ops.assets`), not in
 * the URL. One person holding two portals uses one login and one tree.
 *
 * Deliberately outside: health probes (routes/health.ts, stable path for a
 * load balancer once deployed).
 */
export const apiV1 = Router();

// Sign-in, org claim, record claim (§5). The only unauthenticated group.
apiV1.use('/auth', authRoutes);

// The signed-in employee's own view (profile, batches, direct reports).
apiV1.use('/me', meRoutes);

// Org structure (HRBP portal, §2).
apiV1.use('/employees', employeesRoutes);
apiV1.use('/departments', departmentsRoutes);

// Access model (Owner / admin surface, §3–§6).
apiV1.use('/batches', batchesRoutes);
apiV1.use('/grant-requests', grantRequestsRoutes);
apiV1.use('/audit-log', auditRoutes);

// OPS portal: the asset manager (locations are the punch zones).
apiV1.use('/assets', assetsRoutes);
apiV1.use('/asset-setup', assetSetupRoutes);
apiV1.use('/asset-requests', assetRequestsRoutes);
apiV1.use('/gate-passes', gatePassesRoutes);
apiV1.use('/stock', stockRoutes);
apiV1.use('/my-assets', myAssetsRoutes);

// Exit / offboarding (§8).
apiV1.use('/exits', exitsRoutes);

// End-of-probation decisions (RM recommends, HR decides).
apiV1.use('/probation', probationRoutes);

// Performance improvement plans (RM opens, HR approves).
apiV1.use('/pips', pipRoutes);

// Leave requests (dual RM + HRBP approval).
apiV1.use('/leaves', leavesRoutes);

// Attendance (punches, holidays, regularizations, WFH).
apiV1.use('/attendance', attendanceRoutes);

// Payroll (PR portal): monthly runs + payslips.
apiV1.use('/payroll', payrollRoutes);

// Reimbursement claims: employee -> RM -> Payroll -> the next payslip.
apiV1.use('/reimbursements', reimbursementsRoutes);

// Feedback notes (insights phase C): drafted by the system, sent by a human.
apiV1.use('/feedback', feedbackRoutes);

// Policy library + version-bound acknowledgements (HRBP portal).
apiV1.use('/policies', policiesRoutes);

// Onboarding journeys: owner-gated checklist per hire (HRBP portal).
apiV1.use('/onboarding', onboardingRoutes);

// R&R: nominations with a written citation, RM-or-HR approval, public board.
apiV1.use('/recognitions', recognitionsRoutes);

// Career ladder & roadmap conversations (relationship-gated, like /me/team).
apiV1.use('/career', careerRoutes);

// Performance layer: weighted quarterly goals + daily work updates.
apiV1.use('/goals', goalsRoutes);
apiV1.use('/work-updates', workUpdatesRoutes);

// Quarter reports: HR closes a quarter, reports freeze, managers set final scores.
apiV1.use('/quarter-reports', quarterReportsRoutes);

// Org-tunable settings (refinement Phase 0): registry-validated overrides.
apiV1.use('/settings', settingsRoutes);
apiV1.use('/notifications', notificationsRoutes);

// Background jobs (Admin): scheduler state, recent runs, run now.
apiV1.use('/admin/jobs', jobsRoutes);

// Concerns (Batch 4): disputes, complaints, whistleblower reports.
apiV1.use('/concerns', concernsRoutes);

// Open door (Batch 4): HR and department heads publish slots, anyone books.
apiV1.use('/open-door', openDoorRoutes);

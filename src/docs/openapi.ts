import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registerAuthDocs } from '../features/auth/index.js';
import { registerMeDocs } from '../features/me/index.js';
import { registerEmployeesDocs } from '../features/employees/index.js';
import { registerDepartmentsDocs } from '../features/departments/index.js';
import { registerSeatsDocs } from '../features/seats/index.js';
import {
  registerCandidatesDocs,
  registerHireDocs,
  registerHiringDocs,
} from '../features/hiring/index.js';
import {
  registerAuditDocs,
  registerBatchesDocs,
  registerGrantRequestsDocs,
} from '../features/access/index.js';
import {
  registerAssetRequestsDocs,
  registerAssetSetupDocs,
  registerAssetsDocs,
  registerGatePassesDocs,
  registerMyAssetsDocs,
  registerStockDocs,
} from '../features/ops/index.js';
import { registerExitsDocs } from '../features/exits/index.js';
import { registerProbationDocs } from '../features/probation/index.js';
import { registerPipDocs } from '../features/pip/index.js';
import { registerLeavesDocs } from '../features/leaves/index.js';
import { registerAttendanceDocs } from '../features/attendance/index.js';
import { registerPayrollDocs } from '../features/payroll/index.js';
import { registerReimbursementsDocs } from '../features/reimbursements/index.js';
import { registerFeedbackDocs } from '../features/feedback/index.js';
import { registerPoliciesDocs } from '../features/policies/index.js';
import { registerOnboardingDocs } from '../features/onboarding/index.js';
import { registerRecognitionsDocs } from '../features/recognitions/index.js';
import { registerCareerDocs } from '../features/career/index.js';
import { registerPerformanceDocs } from '../features/performance/index.js';
import { registerQuarterReportsDocs } from '../features/quarter-reports/index.js';
import { registerSettingsDocs } from '../features/settings/index.js';
import { registerNotificationsDocs } from '../features/notifications/index.js';
import { registerJobsDocs } from '../features/jobs/index.js';
import { registerConcernsDocs } from '../features/concerns/index.js';
import { registerOpenDoorDocs } from '../features/open-door/index.js';
import { apiErrorSchema } from './helpers.js';

// The `.openapi()` extension is applied via src/shared/zod.js, which the schema
// modules imported above all depend on — so it's active before we register here.

/**
 * Builds the OpenAPI document from the Zod schemas registered by each feature.
 * The doc is fully generated — request and response schemas come from the same
 * Zod definitions used at runtime, so there is no hand-written spec to
 * maintain. Adding an endpoint means adding its `registerPath` in the
 * feature's `*.docs.ts` and, once per feature, wiring the register call here.
 */
export const buildOpenApiDocument = () => {
  const registry = new OpenAPIRegistry();

  // Shared error envelope, referenced by every feature.
  registry.register('ErrorResponse', apiErrorSchema);
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access token from POST /api/v1/auth/login',
  });

  // Each feature registers its own paths (feature-based ownership).
  registerAuthDocs(registry);
  registerMeDocs(registry);
  registerEmployeesDocs(registry);
  registerDepartmentsDocs(registry);
  registerSeatsDocs(registry);
  registerHiringDocs(registry);
  registerCandidatesDocs(registry);
  registerHireDocs(registry);
  registerBatchesDocs(registry);
  registerGrantRequestsDocs(registry);
  registerAuditDocs(registry);
  registerAssetsDocs(registry);
  registerAssetSetupDocs(registry);
  registerAssetRequestsDocs(registry);
  registerGatePassesDocs(registry);
  registerStockDocs(registry);
  registerMyAssetsDocs(registry);
  registerExitsDocs(registry);
  registerProbationDocs(registry);
  registerPipDocs(registry);
  registerLeavesDocs(registry);
  registerAttendanceDocs(registry);
  registerPayrollDocs(registry);
  registerReimbursementsDocs(registry);
  registerFeedbackDocs(registry);
  registerPoliciesDocs(registry);
  registerOnboardingDocs(registry);
  registerRecognitionsDocs(registry);
  registerCareerDocs(registry);
  registerPerformanceDocs(registry);
  registerQuarterReportsDocs(registry);
  registerSettingsDocs(registry);
  registerNotificationsDocs(registry);
  registerJobsDocs(registry);
  registerConcernsDocs(registry);
  registerOpenDoorDocs(registry);

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Elecbits HRMS API',
      version: '0.1.0',
      description:
        'Org structure, batch-based access control, OPS asset management, and exit clearance for the Elecbits HRMS.',
    },
    servers: [{ url: '/' }],
  });
};

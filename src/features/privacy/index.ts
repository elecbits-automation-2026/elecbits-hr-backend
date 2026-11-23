/** Public surface of the privacy module (DPDP, report M12). */
export { privacyMeRoutes, privacyAdminRoutes } from './privacy.routes.js';
export { registerPrivacyDocs } from './privacy.docs.js';
export { privacyServiceFor } from './privacy.controller.js';
export type { PrivacyService } from './privacy.service.js';
export type { SensitiveRead } from './privacy.repository.js';

/** Public surface of the email module. */
export { emailRoutes } from './email.routes.js';
export { registerEmailDocs } from './email.docs.js';
export { emailServiceFor } from './email.controller.js';
export { enqueueEmails, type QueuedEmail } from './email.repository.js';
export type { EmailService } from './email.service.js';

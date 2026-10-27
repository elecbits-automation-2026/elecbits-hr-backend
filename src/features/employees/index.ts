/**
 * Public surface of the employees module. Other code imports from here, not
 * from individual files inside the module.
 */
export { employeesRoutes } from './employees.routes.js';
export { registerEmployeesDocs } from './employees.docs.js';
export type { EmployeeDto } from './employees.types.js';
// Hiring's Mark hired (TA Step E) creates the record through the same intake rules.
export { createEmployeesRepository } from './employees.repository.js';
export { createEmployeesService, type EmployeesService } from './employees.service.js';
export { EMPLOYMENT_TYPES, type CreateEmployeeInput } from './employees.schema.js';

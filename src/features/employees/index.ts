/**
 * Public surface of the employees module. Other code imports from here, not
 * from individual files inside the module.
 */
export { employeesRoutes } from './employees.routes.js';
export { registerEmployeesDocs } from './employees.docs.js';
export type { EmployeeDto } from './employees.types.js';

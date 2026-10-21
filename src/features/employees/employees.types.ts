import type { z } from 'zod';
import type { employees } from '../../db/schema/index.js';
import type { employeeSchema } from './employees.schema.js';

/**
 * Domain / response types. Responses are `z.infer<>` of the documented schemas
 * — never hand-written — so a schema change fails to compile until every
 * mapper is updated.
 */
export type EmployeeRow = typeof employees.$inferSelect;
export type EmployeeDto = z.infer<typeof employeeSchema>;

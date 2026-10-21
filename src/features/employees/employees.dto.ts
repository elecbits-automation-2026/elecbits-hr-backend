import type { EmployeeDto, EmployeeRow } from './employees.types.js';

/**
 * Pure row -> response mappers (no I/O, no DI). Services delegate here so they
 * read as rules + orchestration only, and the response can't drift from the
 * documented schema.
 */
export const toEmployee = (row: EmployeeRow): EmployeeDto => ({
  id: row.id,
  name: row.name,
  firstName: row.firstName,
  middleName: row.middleName,
  lastName: row.lastName,
  phone: row.phone,
  employeeCode: row.employeeCode,
  email: row.email,
  departmentId: row.departmentId,
  level: row.level,
  reportsTo: row.reportsTo,
  status: row.status,
  baseZoneId: row.baseZoneId,
  designation: row.designation,
  employmentType: row.employmentType,
  dateOfJoining: row.dateOfJoining,
  offerDate: row.offerDate,
  confirmationDate: row.confirmationDate,
  noticeDays: row.noticeDays,
  workStart: row.workStart,
  workEnd: row.workEnd,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Attendance — web check-in/out with the office-IP flag, computed day
 * classification (Mon–Fri week, holidays, leave/WFH aware), RM-approved
 * regularizations and WFH requests. Public surface only.
 */
export { attendanceRoutes } from './attendance.routes.js';
export { registerAttendanceDocs } from './attendance.docs.js';
export type {
  AttendanceDayDto,
  EmployeeAttendanceDto,
  HolidayDto,
  MyAttendanceDto,
  RegularizationDto,
  WfhRequestDto,
} from './attendance.schema.js';

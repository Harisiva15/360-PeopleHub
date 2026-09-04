/**
 * The in-memory implementation, backed by the generated dataset in `src/data`.
 *
 * It exists to prove the contracts are honest — if a screen can run against
 * this without reaching for `src/data`, it can run against HTTP.
 */

import type { Services } from '../contracts';
import { attendanceService } from './attendance';
import { employeeService } from './employees';
import { expenseService } from './expenses';
import { leaveService } from './leave';
import { hiringService, letterService, loanService, shiftService } from './misc';
import { payrollService } from './payroll';
import { staffingService } from './staffing';
import {
  benefitsService, engagementService, exitService, helpdeskService, learningService,
  noticeboardService, performanceService,
} from './peopleops';
import { timesheetService } from './timesheet';

export const mockServices: Services = {
  employees: employeeService,
  attendance: attendanceService,
  leave: leaveService,
  timesheet: timesheetService,
  expenses: expenseService,
  payroll: payrollService,
  shifts: shiftService,
  loans: loanService,
  letters: letterService,
  hiring: hiringService,
  performance: performanceService,
  learning: learningService,
  helpdesk: helpdeskService,
  engagement: engagementService,
  benefits: benefitsService,
  noticeboard: noticeboardService,
  exits: exitService,
  staffing: staffingService,
};

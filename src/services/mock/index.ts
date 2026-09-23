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
import { compensationService } from './compensation';
import { configService } from './config';
import { assetService, documentService, exitService, onboardingService, securityService } from './records';
import { staffingService } from './staffing';
import { userService } from './users';
import { jobTitleService } from './jobtitles';
import { lifecycleService } from './lifecycle';
import { softwareService } from './software';
import { devPlanService } from './devplans';
import { eventService } from './events';
import { makeExportService } from './exports';
import { makeReportService } from './reports';
import { integrationService } from './integrations';
import { recruitmentService } from './recruitment';
import {
  benefitsService, engagementService, helpdeskService, learningService,
  noticeboardService, performanceService,
} from './peopleops';
import { timesheetService } from './timesheet';
import { approvalsService } from './approvals';
import { joinersService } from './joiners';
import { plannerService } from './planner';

export const mockServices: Services = {
  employees: employeeService,
  attendance: attendanceService,
  leave: leaveService,
  timesheet: timesheetService,
  expenses: expenseService,
  payroll: payrollService,
  compensation: compensationService,
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
  users: userService,
  jobTitles: jobTitleService,
  lifecycle: lifecycleService,
  software: softwareService,
  devPlans: devPlanService,
  events: eventService,
  /* Reads through the other services, so an export can never see more than the
     screen would. The closure is lazy because it names the object it is in. */
  exports: makeExportService(() => mockServices),
  /* Runs through the export centre, so a report cannot outrun its reader. */
  reports: makeReportService(() => mockServices),
  integrations: integrationService,
  recruitment: recruitmentService,
  documents: documentService,
  assets: assetService,
  security: securityService,
  onboarding: onboardingService,
  config: configService,
  approvals: approvalsService,
  joiners: joinersService,
  planner: plannerService,
};

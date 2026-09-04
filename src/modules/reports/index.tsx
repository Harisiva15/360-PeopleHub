import { useState } from 'react';
import type { ComponentType } from 'react';
import { Card, EmptyState } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { AppRole } from '../../types/employee';
import { RepAttendance, RepAttrition, RepHeadcount, RepLeave } from './people';
import { RepCompliance, RepPayroll, RepSpend } from './money';
import { RepHiring, RepService, RepTalent, RepUtil } from './work';

interface ReportDef {
  id: string;
  n: string;
  d: string;
  ic: string;
  roles: AppRole[];
  Body: ComponentType;
}

/**
 * The catalogue, in the order it is listed. `roles` gates each report: a
 * manager sees only the ones that stay meaningful inside their own team.
 */
const REPORTS: ReportDef[] = [
  { id: 'attendance', n: 'Attendance Summary', d: 'Presence, WFH, late marks and geo-fence exceptions', ic: '◉', roles: ['admin', 'manager'], Body: RepAttendance },
  { id: 'payroll', n: 'Payroll Cost Analysis', d: 'Gross, deductions and net across months and departments', ic: '₹', roles: ['admin'], Body: RepPayroll },
  { id: 'headcount', n: 'Headcount & Diversity', d: 'Distribution by department, grade, location and gender', ic: '☰', roles: ['admin', 'manager'], Body: RepHeadcount },
  { id: 'attrition', n: 'Attrition & Retention', d: 'Exits, reasons, tenure at exit and retention rate', ic: '↘', roles: ['admin'], Body: RepAttrition },
  { id: 'hiring', n: 'Hiring Effectiveness', d: 'Funnel conversion, source quality and time to hire', ic: '◎', roles: ['admin', 'manager'], Body: RepHiring },
  { id: 'leave', n: 'Leave Liability', d: 'Balances, utilisation and encashment liability', ic: '↗', roles: ['admin', 'manager'], Body: RepLeave },
  { id: 'utilisation', n: 'Timesheet Utilisation', d: 'Billable vs non-billable effort by project and person', ic: '▤', roles: ['admin', 'manager'], Body: RepUtil },
  { id: 'compliance', n: 'Statutory Compliance', d: 'PF, ESI, PT and TDS remittance summary', ic: '§', roles: ['admin'], Body: RepCompliance },
  { id: 'talent', n: 'Performance & Talent', d: 'Goal achievement, rating spread, 9-box and recognition', ic: '◈', roles: ['admin', 'manager'], Body: RepTalent },
  { id: 'spend', n: 'Expense & Employee Cost', d: 'Claims, loans, benefits and total cost per employee', ic: '🧾', roles: ['admin'], Body: RepSpend },
  { id: 'service', n: 'Helpdesk & Engagement', d: 'Ticket SLAs, survey scores and learning completion', ic: '◒', roles: ['admin', 'manager'], Body: RepService },
];

const availableTo = (role: AppRole) => REPORTS.filter((r) => r.roles.includes(role));

function ReportsView() {
  const app = useApp();
  const avail = availableTo(app.role);
  const [sel, setSel] = useState(avail[0]?.id);

  if (!avail.length) return <EmptyState msg="No reports are available for your role." icon="▥" />;

  /* A role switch can strip the selected report out of the catalogue. */
  const active = avail.find((r) => r.id === sel) || avail[0];
  const Body = active.Body;

  return (
    <div className="grid g-1-2" style={{ gridTemplateColumns: '250px minmax(0,1fr)' }}>
      <Card title="Report catalogue" sub={`${avail.length} available`} flush style={{ alignSelf: 'start' }}>
        {avail.map((r) => (
          <div
            key={r.id}
            className="list-row clickable"
            style={r.id === active.id ? { background: 'var(--brand-wash)' } : undefined}
            onClick={() => setSel(r.id)}
          >
            <div style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{r.ic}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{r.n}</div>
              <div className="muted" style={{ fontSize: 11 }}>{r.d}</div>
            </div>
          </div>
        ))}
      </Card>
      <div>
        <Body />
      </div>
    </div>
  );
}

registerModule({
  key: 'reports',
  title: TITLES.reports,
  Component: ReportsView,
});

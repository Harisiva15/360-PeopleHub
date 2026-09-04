import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState } from './ui';
import type { BadgeKind } from './ui';

/** Maps every status string used across the app onto a badge tone. */
const STATUS_TONE: Record<string, BadgeKind> = {
  Approved: 'good', Paid: 'good', Active: 'good', Completed: 'good', Clear: 'good',
  Accepted: 'good', Verified: 'good', Hired: 'good', Open: 'good',
  Pending: 'warn', Submitted: 'info', Draft: 'mute', 'In Progress': 'warn',
  'Pre-boarding': 'info', Negotiating: 'warn', Sent: 'info', Scheduled: 'info', 'On Hold': 'warn',
  Rejected: 'crit', Cancelled: 'mute', Missing: 'crit', Exited: 'mute', Absent: 'crit',
  Insufficiency: 'crit', 'No Show': 'crit', Closed: 'mute',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={STATUS_TONE[status] || 'mute'}>{status}</Badge>;
}

/** A row in a flush card list. `to` makes the whole row a link. */
export function ListRow({
  children,
  to,
  onClick,
  style,
}: {
  children: ReactNode;
  to?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  const cls = 'list-row' + (to || onClick ? ' clickable' : '');
  if (to) {
    return (
      <Link to={to} className={cls} style={{ color: 'inherit', ...style }}>
        {children}
      </Link>
    );
  }
  return (
    <div className={cls} onClick={onClick} style={style}>
      {children}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />;
}

export function Chip({ children, on }: { children: ReactNode; on?: boolean }) {
  return <span className={'chip' + (on ? ' on' : '')}>{children}</span>;
}

export function Divide() {
  return <div className="divide" />;
}

export { EmptyState };

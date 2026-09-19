import { Tabs } from '../../components/ui';
import { registerModule } from '../registry';
import { useTabFromUrl } from '../tabParam';
import { TITLES } from '../titles';
import { RbacTab, UsersTab } from './access';
import { CompanyTab, ConfigAuditTab, LeavePolicyTab, LocationsTab, OrgTab, PayConfigTab } from './config';

type Tab = 'rbac' | 'users' | 'sites' | 'leave' | 'pay' | 'org' | 'company' | 'audit';

const TABS: { v: Tab; label: string }[] = [
  { v: 'rbac', label: 'Access Control' },
  { v: 'users', label: 'User Roles' },
  { v: 'sites', label: 'Locations' },
  { v: 'leave', label: 'Leave Policy' },
  { v: 'pay', label: 'Salary Components' },
  { v: 'org', label: 'Org Structure' },
  { v: 'company', label: 'Company Profile' },
  { v: 'audit', label: 'Audit Log' },
];

function SettingsView() {
  /* From the URL, so the menu can link straight to a tab. It was local state,
     which silently landed every deep link on Access Control. */
  const [tab, setTab] = useTabFromUrl<Tab>('rbac', TABS.map((t) => t.v));
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'rbac' && <RbacTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'sites' && <LocationsTab />}
      {tab === 'leave' && <LeavePolicyTab />}
      {tab === 'pay' && <PayConfigTab />}
      {tab === 'org' && <OrgTab />}
      {tab === 'company' && <CompanyTab />}
      {tab === 'audit' && <ConfigAuditTab />}
    </>
  );
}

registerModule({
  key: 'settings',
  title: TITLES.settings,
  Component: SettingsView,
});

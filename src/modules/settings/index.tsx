import { useState } from 'react';
import { Tabs } from '../../components/ui';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { RbacTab, UsersTab } from './access';
import { CompanyTab, ConfigAuditTab, GeoTab, LeavePolicyTab, OrgTab, PayConfigTab } from './config';

type Tab = 'rbac' | 'users' | 'geo' | 'leave' | 'pay' | 'org' | 'company' | 'audit';

const TABS: { v: Tab; label: string }[] = [
  { v: 'rbac', label: 'Access Control' },
  { v: 'users', label: 'User Roles' },
  { v: 'geo', label: 'Geo-fences' },
  { v: 'leave', label: 'Leave Policy' },
  { v: 'pay', label: 'Salary Components' },
  { v: 'org', label: 'Org Structure' },
  { v: 'company', label: 'Company Profile' },
  { v: 'audit', label: 'Audit Log' },
];

function SettingsView() {
  const [tab, setTab] = useState<Tab>('rbac');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'rbac' && <RbacTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'geo' && <GeoTab />}
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

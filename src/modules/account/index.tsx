/**
 * My Account — your own sign-in details, and nothing about anybody else.
 *
 * **Why this is a page every role can open.** The sign-in history exists so a
 * person can notice a session they did not start. That only works if the
 * person can look; a history only an administrator can read tells the one
 * individual who would recognise the odd row precisely nothing. Every other
 * view of this data — a colleague's, the whole tenant's — lives under User
 * Management, where it is scoped and permitted.
 *
 * So the policy for this module is `own` for all three roles, administrators
 * included. An administrator reading somebody else's history is doing user
 * administration, and it belongs on that page.
 *
 * **What is not here yet.** Changing your own password and enrolling a second
 * factor both belong on this page and both go through Supabase Auth rather
 * than this application. Neither is wired up, and the page says so in place of
 * showing a control that does nothing.
 */

import { Card, KV, StatRow, Tabs, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useTabFromUrl } from '../tabParam';
import { useApp } from '../../state/AppContext';
import { useLoginHistory, useVisiblePeople } from '../users/data';
import { SignInAdvice, SignInTable } from '../users/SignIns';
import { whenOf } from '../users/shared';
import { MfaSetup } from '../../auth/MfaSetup';
import { ProfilePhoto } from './ProfilePhoto';

type Tab = 'signins' | 'security';

function AccountView() {
  const app = useApp();
  const dir = useVisiblePeople();
  const [tab, setTab] = useTabFromUrl<Tab>('signins', ['signins', 'security']);

  /* No id: the service resolves it to the caller, so there is no row to ask
     for but your own. */
  const { data: events = [], loading } = useLoginHistory();

  const me = dir.byId(app.meId);
  const signIns = events.filter((e) => e.outcome === 'success');
  const lastSignIn = signIns[0]?.at ?? null;
  /*
   * The *previous* sign-in, not the current one. "Last signed in: two minutes
   * ago" describes the session you are reading it in and tells nobody
   * anything; the one before it is the row a person can check against their
   * own memory.
   */
  const previous = signIns[1]?.at ?? null;
  const addresses = new Set(signIns.map((e) => e.ip).filter(Boolean));

  return (
    <div className="stack">
      <StatRow cols={4}>
        {/*
          * The server's identity first, the directory second. This read the
          * directory alone and showed "—" for the signed-in administrator,
          * whose name the server had already supplied from `/me`.
          */}
        <Tile icon={<Icon n="person" size="lg" />} label="Signed in as"
          value={app.identity?.name ?? me?.name ?? '—'}
          foot={app.identity?.email ?? me?.email ?? ''} />
        <Tile icon={<Icon n="lock" size="lg" />} label="Previous sign-in"
          value={previous ? whenOf(previous) : '—'}
          foot="Before the session you are in now" />
        <Tile icon={<Icon n="clock" size="lg" />} label="Sign-ins recorded"
          value={loading ? '—' : signIns.length}
          foot="Successful, in the period kept" />
        <Tile icon={<Icon n="security" size="lg" />} label="Addresses seen"
          value={loading ? '—' : addresses.size}
          foot="Distinct networks you have signed in from" />
      </StatRow>

      {/*
        * Outside the tabs, because a photo is neither a sign-in record nor a
        * security setting — the two things the tabs divide this screen into.
        *
        * ## Gated on `app.meId`, not on finding yourself in the directory
        *
        * This read `{me && …}`, where `me` is `useVisiblePeople().byId(meId)`
        * — a lookup for yourself in the list of everyone. In production that
        * list came back without the signed-in administrator, so the card did
        * not render at all and there was no way to upload a photo anywhere in
        * the product. The "Signed in as" tile went blank from the same cause,
        * which is the tell: one missing lookup, two symptoms.
        *
        * `app.meId` is the right source and was available the whole time. It
        * is the employee id the server returned from `/me`, and
        * `AppContext` has already proved it resolves to a real row — it
        * fetches that row with `employees.byIds([empId])` during sign-in and
        * refuses to continue if it is missing. So by the time this renders,
        * the id is known to be good.
        *
        * Identifying yourself should not depend on being able to list other
        * people. The name falls back through the server's own identity before
        * the directory, for the same reason.
        */}
      {app.meId && (
        <ProfilePhoto
          empId={app.meId}
          name={app.identity?.name ?? me?.name ?? 'You'}
        />
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'signins' as const, label: 'Sign-in History' },
          { v: 'security' as const, label: 'Security' },
        ]}
        onChange={setTab}
      />

      {tab === 'signins' && (
        <Card
          title="Sign-in History"
          sub={`${events.length} ${events.length === 1 ? 'event' : 'events'}, newest first`}
          flush
        >
          <div style={{ padding: 12 }}>
            <div style={{ marginBottom: 10 }}><SignInAdvice /></div>
            {loading
              ? <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>
              : (
                <SignInTable
                  rows={events}
                  emptyMsg="Nothing recorded yet — your first sign-in will appear here"
                />
              )}
          </div>
        </Card>
      )}

      {tab === 'security' && (
        <>
          <Card title="How you sign in" sub="What this account uses today">
            <KV rows={[
              ['Signed in as', me?.email ?? '—'],
              ['Last sign-in', lastSignIn ? whenOf(lastSignIn) : '—'],
              ['Signed out automatically', 'After 30 minutes without activity'],
            ]} />
          </Card>

          <Card title="Two-factor sign-in" sub="An authenticator app, in addition to your password">
            <MfaSetup />
          </Card>

          {/*
            * Said rather than shown as a disabled button. A control somebody
            * can see and not use reads as broken software; a sentence saying
            * where the thing lives reads as an answer.
            */}
          <Card title="Password" sub="Where it is changed">
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>
              Your password is held by the sign-in provider, not by 360 People Hub —
              this application never sees it, and cannot show it to you or send it
              anywhere. Sign out and use <strong>Forgot your password?</strong> on the
              sign-in page to set a new one — a link goes to your work address.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

registerModule({
  key: 'account',
  title: TITLES.account,
  Component: AccountView,
});

/** Exported for the checks, which mount it directly. */
export { AccountView };

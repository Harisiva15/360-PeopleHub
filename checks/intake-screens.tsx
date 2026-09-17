/**
 * The intake screens mount, and rank joiners correctly.
 *
 * `checks/routes.tsx` renders each module's default tab, which leaves the parts
 * reached by a click — the document-collection tab, the offer letter — never
 * rendered by anything. Those are the screens for the newest work, and a
 * component that throws on mount is not something to find out in front of a
 * user.
 *
 * **What a static render can and cannot see.** `renderToStaticMarkup` is
 * synchronous and `useQuery` is not, so anything fetched is still loading when
 * the markup is produced: the document list, the letter body, the joiner
 * counts. Asserting on those here would be asserting on the loading state while
 * appearing to check the content. So this file checks two things it can
 * actually establish — that every one of these components mounts for every role
 * that can reach it, and that what is derived from props rather than queries
 * says the right thing — and checks the ordering rule directly as a function,
 * where the interesting mistakes live.
 */

globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { CollectionView, rankIntake } from '../src/modules/onboarding/Collection';
import { DocumentCollection } from '../src/modules/documents/collection';
import { OfferLetter } from '../src/modules/hiring/OfferLetter';
import { getServices } from '../src/services';
import type { DocRequest, Onboarding } from '../src/services';
import type { AppRole } from '../src/types/employee';
import type { ReactElement } from 'react';

const render = (node: ReactElement, role: AppRole = 'admin') => renderToStaticMarkup(
  <MemoryRouter>
    <AuthProvider>
      <AppProvider initialRole={role}>
        <LayerProvider>{node}</LayerProvider>
      </AppProvider>
    </AuthProvider>
  </MemoryRouter>,
);

let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`
    + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
};

const s = getServices();

console.log('\nintake screens\n');

/* ---------- they mount ---------- */

const journeys = await s.onboarding.list();
const subject = journeys.find((j) => j.status !== 'Completed') ?? journeys[0]!;

for (const role of ['admin', 'manager'] as AppRole[]) {
  check(`the collection view mounts for ${role}`,
    render(<CollectionView />, role).includes('Who is holding us up'), true);
  check(`a joiner's document panel mounts for ${role}`,
    render(<DocumentCollection scope={{ journeyId: subject.id }} />, role)
      .includes('Document collection'), true);
}

check('the panel takes a title when one is given',
  render(<DocumentCollection scope={{ journeyId: subject.id }} title="Kavya — documents" />)
    .includes('Kavya — documents'), true);

/* ---------- the offer letter, which is driven by props ---------- */

const cands = await s.hiring.candidates();
const released = cands.find((c) => c.offer && c.offer.status !== 'Draft');
check('the fixture has a released offer', Boolean(released), true);
if (released) {
  const html = render(<OfferLetter c={released} />);
  check('a released letter is presented as released', html.includes('Released'), true);
  check('and cannot be released again', html.includes('Release to candidate'), false);
  check('it states the salary', html.includes('p.a.'), true);
}

/*
 * The fixture ships every offer already sent, so a draft is made rather than
 * hoped for. The draft state is the point of the release step and the half most
 * likely to be broken.
 */
const spare = cands.find((c) => !c.offer && c.stage !== 'rejected' && c.stage !== 'hired');
check('the fixture has a candidate who can be offered', Boolean(spare), true);
if (spare) {
  const drafted = await s.hiring.makeOffer(
    { candId: spare.id, ctc: 1800000, doj: '2026-12-01', grade: 'L3' });
  check('making an offer produces a draft', drafted.offer?.status, 'Draft');

  const html = render(<OfferLetter c={drafted} />);
  check('a draft is presented as unsent', html.includes('Not yet released'), true);
  check('it says the candidate has not seen it', html.includes('has not seen this'), true);
  check('and offers the release button', html.includes('Release to candidate'), true);

  const sent = await s.hiring.releaseOffer(spare.id);
  check('releasing marks it sent', sent.offer?.status, 'Sent');
  check('and stamps the date', Boolean(sent.offer?.sentOn), true);
  check('a released offer cannot be released twice',
    await s.hiring.releaseOffer(spare.id).then(() => 'succeeded', () => 'refused'), 'refused');
}

/* ---------- the ordering rule, checked directly ---------- */

const j = (id: string, doj: string, status = 'Pre-boarding'): Onboarding => ({
  id, candId: '', name: id, reqId: '', dept: 'ENG', designation: 'Engineer', site: 'CHN',
  doj, managerId: '', buddyId: '', ctc: 0, status: status as Onboarding['status'],
  bgv: 'Clear', tasks: [],
});

const d = (journeyId: string, kind: string, mandatory: boolean, status: string): DocRequest => ({
  id: journeyId + ':' + kind, journeyId, empId: null, kind, label: kind, mandatory, status,
  due: null, receivedOn: null, verifiedBy: null, verifiedOn: null, note: '', hasFile: false,
});

const TODAY = '2026-09-17';
const ranked = rankIntake(
  [
    j('soon-clear', '2026-09-21'),
    j('later-two-missing', '2026-11-30'),
    j('soon-two-missing', '2026-09-24'),
    j('done', '2026-09-20', 'Completed'),
  ],
  [
    d('soon-clear', 'photo_id', true, 'verified'),
    d('later-two-missing', 'photo_id', true, 'pending'),
    d('later-two-missing', 'education', true, 'rejected'),
    d('soon-two-missing', 'photo_id', true, 'pending'),
    d('soon-two-missing', 'education', true, 'pending'),
    /* An optional document missing must not push anyone up the list. */
    d('soon-clear', 'photo', false, 'pending'),
    /* Received-but-unchecked is not missing; it is a different queue. */
    d('soon-clear', 'medical', false, 'received'),
    d('done', 'photo_id', true, 'pending'),
  ],
  TODAY,
);

check('a completed journey is not in intake at all',
  ranked.some((r) => r.j.id === 'done'), false);
check('most missing comes first', ranked.map((r) => r.j.id),
  ['soon-two-missing', 'later-two-missing', 'soon-clear']);
check('a rejected document still counts as missing',
  ranked.find((r) => r.j.id === 'later-two-missing')?.missing, 2);
check('an optional document missing does not count',
  ranked.find((r) => r.j.id === 'soon-clear')?.missing, 0);
check('received-but-unchecked is counted separately',
  ranked.find((r) => r.j.id === 'soon-clear')?.toCheck, 1);
check('days to joining are counted from today',
  ranked.find((r) => r.j.id === 'soon-two-missing')?.daysToJoin, 7);

/* Equal gaps: the sooner joining date wins. */
const tie = rankIntake(
  [j('far', '2026-12-01'), j('near', '2026-09-20')],
  [d('far', 'photo_id', true, 'pending'), d('near', 'photo_id', true, 'pending')],
  TODAY,
);
check('among equals the soonest joiner comes first', tie.map((r) => r.j.id), ['near', 'far']);

console.log(failed
  ? `\n${failed} check(s) FAILED`
  : '\nthe intake screens mount, and rank joiners correctly');
process.exit(failed ? 1 : 0);

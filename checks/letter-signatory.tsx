/**
 * A letter is not issued unsigned, and the branding cards are company_admin's.
 *
 * Two rules, both decided rather than incidental:
 *
 *   1. No signatory, no letter — refused before anything is drawn, so there
 *      is no Print button to press. A letter that printed its own apology
 *      would still be a document somebody could hand over.
 *   2. The logo and the signatory are written by company_admin alone, while
 *      **everybody reads** the logo, because it is in the header of every
 *      page. That asymmetry was a correction to an earlier draft that refused
 *      a non-company_admin on both.
 *
 * The server holds both rules too — `check:branding` proves them against the
 * database. This file is about what the interface does with them, which is a
 * separate question: a screen can offer a button the server will refuse, and
 * that is the defect `checks/permissions-matrix.ts` exists for.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';
import { mayIssueLetter, NO_SIGNATORY_MESSAGE } from '../src/modules/documents/issue';
import { CompanyLogoCard, SignatoryCard } from '../src/modules/settings/Branding';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import type { AppRole } from '../src/types/employee';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

/* ===========================================================================
 * 1. The rule, as a function
 * ======================================================================== */

console.log(`${NL}a letter needs a named signer${NL}`);

ok('1. no signatory refuses', mayIssueLetter(null).issue === false);
ok('2.  and says what to do about it',
  mayIssueLetter(null).issue === false
  && /Set a signatory in Company profile first/.test(NO_SIGNATORY_MESSAGE),
  NO_SIGNATORY_MESSAGE);

/*
 * `undefined` is the read that has not landed. It must refuse as well: a
 * letter withheld for a moment is recoverable, one issued unsigned is not.
 */
ok('3. a signatory not yet read refuses too, rather than being treated as absent',
  mayIssueLetter(undefined).issue === false);

ok('4. half a pair refuses — a name with no title is not a signature',
  mayIssueLetter({ name: 'Hari Sivakumar', title: '' }).issue === false);
ok('5.  and a title with no name',
  mayIssueLetter({ name: '', title: 'Director' }).issue === false);
ok('6.  and whitespace is not a title',
  mayIssueLetter({ name: 'Hari Sivakumar', title: '   ' }).issue === false);

const good = mayIssueLetter({ name: '  Hari Sivakumar  ', title: '  Director  ' });
ok('7. a real pair issues', good.issue === true);
ok('8.  trimmed, because the letter prints it verbatim',
  good.issue === true && good.signatory.name === 'Hari Sivakumar'
  && good.signatory.title === 'Director',
  JSON.stringify(good));

/* ===========================================================================
 * 2. The refusal is wired ahead of the modal, not inside the letter
 * ======================================================================== */

const letter = readFileSync('src/modules/documents/Letter.tsx', 'utf8');

ok('9. the opener consults the rule', /mayIssueLetter\(signatory\)/.test(letter));
ok('10.  and returns before building the letter modal',
  letter.indexOf('mayIssueLetter(signatory)') < letter.indexOf('<LetterDoc'),
  'a refusal after the letter is built is not a refusal');

/*
 * The refusal's own footer, and only it. Asserted on the slice between the
 * guard and the letter modal so the letter's own Print button — which must
 * stay — cannot satisfy this.
 */
const refusalBlock = letter.slice(
  letter.indexOf('mayIssueLetter(signatory)'), letter.indexOf('<LetterDoc'));
ok('11. the refusal offers no way to print',
  !/window\.print|Print \/ Save PDF/.test(refusalBlock),
  refusalBlock.slice(0, 200));
ok('12.  while the letter itself still does',
  /Print \/ Save PDF/.test(letter.slice(letter.indexOf('<LetterDoc'))));

/* ===========================================================================
 * 3. Who may change the branding
 * ======================================================================== */

console.log(`${NL}the logo and the signatory are company_admin's to set${NL}`);

const at = (role: AppRole, node: 'logo' | 'signatory') => renderToStaticMarkup(
  /* The stack the shell gives these cards, which `renders.tsx` also uses:
     AppProvider reads the session through useAuth, and Card draws into the
     layer. Missing either throws rather than rendering a wrong answer. */
  <MemoryRouter initialEntries={['/settings?v=company']}>
    <AuthProvider>
      <AppProvider initialRole={role}>
        <LayerProvider>
          {node === 'logo'
            ? <CompanyLogoCard entityCode="IN01" />
            : <SignatoryCard entityCode="IN01" />}
        </LayerProvider>
      </AppProvider>
    </AuthProvider>
  </MemoryRouter>,
);

const SUFFIX = ['a', 'b', 'c'];
for (const [i, role] of (['employee', 'hr_admin', 'finance_admin'] as AppRole[]).entries()) {
  const logo = at(role, 'logo');
  ok(`13${SUFFIX[i]}. ${role.padEnd(14)} is offered no way to change the logo`,
    !/>Upload<|>Replace<|>Remove</.test(logo), logo.slice(0, 160));
  const sig = at(role, 'signatory');
  ok(`14${SUFFIX[i]}. ${role.padEnd(14)} is offered no way to change the signatory`,
    !/>Edit</.test(sig), sig.slice(0, 160));
}

const adminLogo = at('company_admin', 'logo');
ok('15. company_admin is', />Upload<|>Replace</.test(adminLogo), adminLogo.slice(0, 200));
ok('16.  and may set the signatory', />Edit</.test(at('company_admin', 'signatory')));

/*
 * Reading is the other half, and the one an earlier draft got wrong. The card
 * renders for every role — it is on a screen only company_admin opens, but
 * the logo itself is drawn in the header for everybody, and the component
 * must not refuse to render for them.
 */
ok('17. the logo card still renders for a role that may not change it',
  at('employee', 'logo').length > 0 && /Company logo/.test(at('employee', 'logo')));

/*
 * The empty state says what the absence costs. "Not set" on its own reads as
 * optional, and this one stops every letter.
 */
ok('18. no signatory is reported as blocking, not as optional',
  /will not print/.test(at('company_admin', 'signatory')),
  at('company_admin', 'signatory').slice(0, 300));

/* ===========================================================================
 * 4. The browser's own checks are courtesy, and say so
 * ======================================================================== */

const card = readFileSync('src/modules/settings/Branding.tsx', 'utf8');
ok('19. SVG is named in the client refusal, with the reason',
  /executable markup/.test(card));
ok('20.  and the server is still the one that enforces it',
  /courtesy, not security|re-checks the bytes/.test(card),
  'the comment that stops this being mistaken for the gate');

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a letter carries a real signature, and only one role sets one${NL}`);
process.exit(0);

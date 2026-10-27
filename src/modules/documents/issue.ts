/**
 * Whether a letter may be issued at all.
 *
 * One input, two outcomes, and a message that has to be exact — so it is a
 * function rather than a branch inside a modal. `state/identity.ts` makes the
 * same argument for the same reason: driving the interesting cases through a
 * React effect needs a DOM, and driving them through a function needs
 * nothing, which leaves the assertions pinning the rule instead of the render.
 *
 * ## The rule
 *
 * `legal_entity.signatory_name` and `signatory_title` are nullable with no
 * default (migration 0061), and `branding/service.ts` returns the pair or
 * null — never half of it. Null is not a blank to render around. A letter
 * states facts on company paper and goes to a bank, a landlord or an embassy;
 * one with no named signer is unsigned, and an unsigned letter is worse than
 * no letter because it looks like a letter.
 *
 * So the refusal happens before anything is drawn, which is what keeps a
 * Print button off the screen. A letter that printed its own apology would
 * still be a document somebody could hand over.
 */

import type { Signatory } from '../../services';

/** What to do when somebody asks for a letter. */
export type IssueVerdict =
  /** Draw it, signed by this person. */
  | { issue: true; signatory: Signatory }
  /** Do not draw it. `message` is shown instead, and says what to do. */
  | { issue: false; message: string };

/**
 * The message, as one constant.
 *
 * Named rather than inlined because two places show it — the modal and its
 * check — and a message that drifts between them is a message somebody will
 * search for and fail to find.
 */
export const NO_SIGNATORY_MESSAGE =
  'Set a signatory in Company profile first. Until somebody is named, every '
  + 'letter this entity issues would go out unsigned.';

/**
 * May this entity issue a letter?
 *
 * `undefined` as well as `null`, because the read may not have landed yet and
 * "not yet known" must not be treated as "nobody is named" — the answer is
 * the same refusal either way, which is the safe direction: a letter withheld
 * for a moment is recoverable, one issued unsigned is not.
 */
export function mayIssueLetter(signatory: Signatory | null | undefined): IssueVerdict {
  if (!signatory) return { issue: false, message: NO_SIGNATORY_MESSAGE };

  /*
   * Both halves, checked here as well as in the service. The contract says
   * `signatory()` never returns half a pair, and this does not rely on that:
   * the cost of being wrong is an unsigned legal document, and the cost of
   * the second check is one comparison.
   */
  const name = signatory.name?.trim() ?? '';
  const title = signatory.title?.trim() ?? '';
  if (!name || !title) return { issue: false, message: NO_SIGNATORY_MESSAGE };

  return { issue: true, signatory: { name, title } };
}

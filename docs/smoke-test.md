# Live smoke test

Twenty-five steps against production, ordered by the menu as it now stands:
eleven groups, forty-four items. Steps 1–20 are run as yourself
(VHM004, company_admin). Steps 21–25 need a second sign-in as an ordinary
employee, because the only way to prove a menu hides something is to look at it
from the account it is hidden from.

**Writes.** Nineteen of the twenty-five steps only read. The five marked **W**
write a row; each one says how to undo it. Step 20 opens the browser's print
dialog, which writes nothing as long as you cancel it. If you would rather the
run leave no trace at all, skip the W steps — the reads still cover every page.

Start at <https://360peoplehub.com>. "Expect" is what a working build does; a
Known column entry means the step is expected to disagree and why.

| # | Menu | Click | Expect | Known |
|---|---|---|---|---|
| 1 | — | Sign in | The dashboard paints: your name, "Company admin", tiles with figures. Not a blank page, not a spinner that stays | |
| 2 | — | Read down the sidebar | Eleven groups: Dashboard, Company Setup, People, Time & Attendance, Timesheets, Projects, Leave, Payroll & Compensation, Assets, Documents, Administration. No Reports, Hiring, Performance, Learning or Software group | |
| 3 | — | Edit the address bar to `#/reports`, then `#/hiring` | Each one bounces you to the dashboard. Not a blank page, not a crash | |
| 4 | — | Edit it to `#/payroll?v=inputs` | Lands on My payslips, and no Inputs tab is drawn | |
| 5 | Company Setup | Company profile | 360VHM Technology Private Limited with CIN, GSTIN, PAN and the registered address filled in. No "undefined", no blank field | Logo upload is not built yet (phase 3) |
| 6 | Company Setup | Organisation structure, then Business units | Departments, each with a head and a headcount above zero; business units listed | |
| 7 | Company Setup | Locations | Nine sites, including CHN, BLR and NJ, each with an address | |
| 8 | Company Setup | Leave policies | Seven types. Loss of Pay reads as unpaid. Quota is the only field you can change | Nothing else on this screen is editable yet |
| 9 | People | Employee directory | Every active employee, each with a photo or their initials. No broken-image icons, no duplicates | |
| 10 | People | Organisation chart | Reporting lines draw. Everyone appears once; no one reports to themselves | |
| 11 | People | Celebrations | Birthdays and anniversaries, and a holiday panel showing **Chennai's** calendar — Pongal is there, Thanksgiving is not | |
| 12 | Time & Attendance | My attendance | This month's grid. Weekends shaded, holidays named, today marked | |
| 13 | Time & Attendance | Attendance board | Today's list: who is in, out or remote. Not an empty card | |
| 14 | Time & Attendance | Attendance corrections | The list opens and the correction form accepts a date | |
| 15 | Timesheets | My timesheet | This week's grid, with the project picker populated from real projects | |
| 16 | Timesheets | Team timesheets, then Pending approvals | Your line's weeks with hours and status; the approvals queue opens | |
| 17 | Projects | My work, then Projects | Two items in the group and no others. Projects lists what time can be booked against | |
| 18 | Leave | Holiday calendar | Holidays with an **Applies to** column naming sites — Chennai, Bengaluru, US — not "All locations" on every row | |
| 19 | Assets | Asset register, then Issue & return | Every asset with its holder and location; the issue form opens | |
| 20 | Documents | Employee documents, pick an employee, open a letter, Print / Save PDF, then **Cancel** the dialog | The preview carries the employee's name, today's date and the entity. The pay line is the test: see Known | **Defect.** All eight letter types are offered. The three that quote pay (Salary Certificate, Increment Letter, Form 16) print an empty pay line, and `LAUNCH_LETTERS` was never wired up. Open a non-pay letter — Experience, Address Proof, Appointment, NOC, Relieving |
| 21 | Administration | User management, then Login history | Accounts with their status; your sign-in from step 1 appears in the history, within the minute | |
| 22 | Administration | User roles, then Audit log | VHM004 company_admin, VHM005 hr_admin, and only the four roles. The audit log is newest-first | |
| 23 | Payroll & Compensation | My payslips | Either payslips or an empty state that says so. No crash, and no pay-run or Inputs tab anywhere in the group | |
| 24 | — | **W** Leave → My leave → apply for one day, any type, then cancel it | It appears as Pending, then as Cancelled or gone. Undo: the cancel is the undo; if it will not cancel, tell me and I will remove the row | |
| 25 | — | Sign out, sign in as an ordinary employee | Fewer groups: no Company Setup, no Administration. Inside the groups, no Attendance board, no Team timesheets, no Leave approvals, no Employee compensation. Then edit the address bar to `#/settings` and `#/users` — each bounces to the dashboard rather than showing a page or an error | |

## What this does not cover

Deliberate omissions, so the gaps are known rather than discovered:

- **Punching in.** Step 12 reads the month but does not punch, because a stray
  punch on a real working day is a payroll input.
- **Approving anything.** Steps 16 and 21 open the queues; deciding a real
  request is someone's actual leave or timesheet.
- **Creating an employee or a user.** Both leave rows that need a migration or
  a manual delete to undo.
- **Anything hidden.** Steps 3, 4, 17, 23 and 25 prove the hiding holds; none
  of them tests what is behind it, which is the point of hiding it.

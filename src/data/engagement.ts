/* Shares the RNG stream with performance — this import fixes the draw order. */
import './performance';

import { addDays, TODAY, ymd } from '../lib/dates';
import { ORG } from './org';

export interface SurveyQuestion {
  q: string;
  /** Mean response on a 1-5 scale. */
  score: number;
}

export interface Survey {
  id: string;
  name: string;
  type: 'Pulse' | 'eNPS' | 'Onboarding';
  status: 'Live' | 'Closed';
  sentOn: string;
  closesOn: string;
  sent: number;
  responded: number;
  anonymous: boolean;
  questions?: SurveyQuestion[];
  /* eNPS surveys carry a promoter/passive/detractor split instead of questions */
  promoters?: number;
  passives?: number;
  detractors?: number;
}

export const SURVEYS: Survey[] = [
  {
    id: 'SV1',
    name: 'Quarterly Engagement Pulse — Q2 FY27',
    type: 'Pulse',
    status: 'Live',
    sentOn: ymd(addDays(TODAY, -6)),
    closesOn: ymd(addDays(TODAY, 8)),
    sent: 130,
    responded: 96,
    anonymous: true,
    questions: [
      { q: 'I have the tools and information I need to do my job well', score: 4.1 },
      { q: 'My manager gives me useful feedback regularly', score: 4.3 },
      { q: 'I see a clear path to grow my career here', score: 3.4 },
      { q: 'My workload is sustainable', score: 3.6 },
      { q: 'I feel comfortable raising a concern', score: 4.2 },
      { q: `I am proud to work at ${ORG.name}`, score: 4.4 },
    ],
  },
  {
    id: 'SV2',
    name: 'eNPS — August 2026',
    type: 'eNPS',
    status: 'Live',
    sentOn: ymd(addDays(TODAY, -6)),
    closesOn: ymd(addDays(TODAY, 8)),
    sent: 130,
    responded: 101,
    anonymous: true,
    promoters: 54,
    passives: 33,
    detractors: 14,
  },
  {
    id: 'SV3',
    name: 'New Joiner Experience — 30 days',
    type: 'Onboarding',
    status: 'Live',
    sentOn: ymd(addDays(TODAY, -14)),
    closesOn: ymd(addDays(TODAY, 16)),
    sent: 11,
    responded: 8,
    anonymous: false,
    questions: [
      { q: 'My onboarding was well organised', score: 4.5 },
      { q: 'I had the equipment I needed on day one', score: 4.0 },
      { q: 'My buddy helped me settle in', score: 4.6 },
    ],
  },
  {
    id: 'SV4',
    name: 'Quarterly Engagement Pulse — Q1 FY27',
    type: 'Pulse',
    status: 'Closed',
    sentOn: ymd(addDays(TODAY, -98)),
    closesOn: ymd(addDays(TODAY, -84)),
    sent: 126,
    responded: 104,
    anonymous: true,
    questions: [{ q: 'Overall engagement', score: 3.9 }],
  },
];

export const ENPS_HISTORY = [
  { k: 'Nov 25', v: 21 },
  { k: 'Feb 26', v: 27 },
  { k: 'May 26', v: 31 },
  { k: 'Aug 26', v: 40 },
];

/** eNPS = %promoters − %detractors, on a −100 to +100 scale. */
export const enpsOf = (s: Survey): number =>
  Math.round(
    ((s.promoters ?? 0) - (s.detractors ?? 0)) /
      Math.max(1, (s.promoters ?? 0) + (s.passives ?? 0) + (s.detractors ?? 0)) *
      100,
  );

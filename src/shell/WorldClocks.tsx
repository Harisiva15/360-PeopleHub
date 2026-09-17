/**
 * The offices' local times, in the header.
 *
 * This company runs regional shifts — IN, US, UK and AE since 0015 — and the
 * question "is it a reasonable hour to call Dallas" is asked here every day.
 *
 * **IANA zone names, never fixed offsets.** New York is UTC−5 for part of the
 * year and UTC−4 for the rest, London is UTC+0 and UTC+1, and the two do not
 * change on the same weekend. An offset hard-coded once is a clock that is
 * quietly an hour wrong for several weeks a year, twice a year — and nobody
 * reports it, they just stop trusting the widget. `Intl.DateTimeFormat` knows
 * the rules and the browser keeps them current.
 *
 * India and the Gulf observe no daylight saving at all, which is exactly why
 * those two would go unnoticed while the other two drifted.
 */

import { useEffect, useState } from 'react';

interface Zone {
  /** What people here call it, not the zone's own name. */
  label: string;
  tz: string;
}

/**
 * The four the company actually works across, ordered west to east so the row
 * reads like a day moving forward.
 */
const ZONES: Zone[] = [
  { label: 'New York', tz: 'America/New_York' },
  { label: 'London', tz: 'Europe/London' },
  { label: 'Dubai', tz: 'Asia/Dubai' },
  { label: 'India', tz: 'Asia/Kolkata' },
];

/** 24-hour, because a header is not the place to work out am from pm. */
const timeIn = (tz: string, at: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);

/**
 * The weekday there, shown only when it differs from the reader's own.
 *
 * Most of the time every office is on the same date and repeating it four
 * times is noise. When Chennai has already rolled over and New York has not,
 * that is the one moment the day matters — so it appears exactly then.
 */
const dayIn = (tz: string, at: Date): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(at);

/** Outside roughly a working day, the office is shown as resting. */
const isAwake = (tz: string, at: Date): boolean => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(at));
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(at);
  if (day === 'Sat' || day === 'Sun') return false;
  return hour >= 9 && hour < 19;
};

export function WorldClocks() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    /*
     * Ticked to the top of each minute rather than every second. The display
     * has minute precision, so a per-second timer would re-render the whole
     * header sixty times for every change anyone could see.
     */
    let timer: number;
    const schedule = () => {
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, msToNextMinute + 50);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const here = dayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, now);

  return (
    <div className="clocks no-print" role="group" aria-label="Office times">
      {ZONES.map((z) => {
        const day = dayIn(z.tz, now);
        return (
          <div key={z.tz} className={'clock-cell' + (isAwake(z.tz, now) ? ' awake' : '')}>
            <div className="cl-city">
              {z.label}
              {day !== here && <span className="cl-day"> {day}</span>}
            </div>
            <div className="cl-time">{timeIn(z.tz, now)}</div>
          </div>
        );
      })}
    </div>
  );
}

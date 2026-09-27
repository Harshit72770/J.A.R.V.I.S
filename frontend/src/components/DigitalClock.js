import React, { useEffect, useRef, useState } from 'react';
import './DigitalClock.css';

/**
 * DigitalClock — futuristic top-left HUD clock.
 *
 * Shows the exact system time (hours, minutes, seconds + AM/PM) and the full
 * date with weekday. The tick is aligned to the wall clock (a timeout that
 * wakes on the next whole second instead of a drifting setInterval), so the
 * displayed seconds always match the machine. Only this component re-renders.
 */

// "10:24:05 am" → hours/minutes/seconds + suffix, without assuming a locale.
const readTime = (date) => {
  const raw = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const cut = raw.lastIndexOf(' ');
  const clock = cut > 0 ? raw.slice(0, cut) : raw;
  const [hh = '--', mm = '--', ss = '--'] = clock.split(':');
  return {
    hh,
    mm,
    ss,
    meridiem: cut > 0 ? raw.slice(cut + 1) : '',
  };
};

// "Sunday, 27 September 2026" → weekday coloured separately from the date.
const readDate = (date) => {
  const raw = date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const cut = raw.indexOf(',');
  return cut > 0
    ? { weekday: raw.slice(0, cut), rest: raw.slice(cut + 1).trim() }
    : { weekday: '', rest: raw };
};

const readZone = (date) =>
  date
    .toLocaleTimeString('en-GB', { timeZoneName: 'shortOffset' })
    .split(' ')
    .pop();

const DigitalClock = () => {
  const [now, setNow] = useState(() => new Date());
  const timerRef = useRef(null);

  useEffect(() => {
    const schedule = () => {
      // Wake up on the next whole second (+8ms slack) so the colon blink and
      // the seconds digit stay in step with the real clock, forever.
      const delay = 1000 - (Date.now() % 1000) + 8;
      timerRef.current = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timerRef.current);
  }, []);

  const { hh, mm, ss, meridiem } = readTime(now);
  const { weekday, rest } = readDate(now);
  const zone = readZone(now);

  return (
    <div
      className="digital-clock"
      role="timer"
      aria-live="off"
      aria-label={`Current time ${hh}:${mm}:${ss}, ${rest}`}
    >
      <div className="clock-panel">
        <span className="clock-scan" aria-hidden="true" />

        <div className="clock-head">
          <span className="clock-pulse" aria-hidden="true" />
          <span className="clock-title">SYSTEM TIME</span>
          <span className="clock-zone">{zone}</span>
        </div>

        <div className="clock-face">
          <span className="clock-digit">{hh}</span>
          <span className="clock-colon">:</span>
          <span className="clock-digit">{mm}</span>
          <span className="clock-colon">:</span>
          <span className="clock-digit clock-digit--sec">{ss}</span>
          {meridiem ? (
            <span className="clock-meridiem">{meridiem}</span>
          ) : null}
        </div>

        <div className="clock-date">
          {weekday ? <span className="clock-weekday">{weekday}</span> : null}
          <span className="clock-rest">{rest}</span>
        </div>
      </div>
    </div>
  );
};

export default DigitalClock;

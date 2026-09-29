/**
 * Reproduction tests for the "Jarvis stops responding after 2-3 commands" bug.
 *
 * The real CommandTerminal runs against a scripted Chrome. The fake
 * SpeechRecognition replays event sequences Chrome genuinely produces during a
 * session:
 *
 *  1. transient `network` errors on restart (flaky Wi-Fi), and
 *  2. a spurious InvalidStateError on start() followed by total silence
 *     (the classic "recognition has already started" phantom).
 *
 * In both cases the mic MUST recover on its own — the assistant has to keep
 * responding indefinitely until the user deliberately turns the mic off.
 * Instant-fact commands ("what time is it") dispatch locally, so these tests
 * exercise the full recognition → dispatch → log → TTS pipeline without any
 * model round-trip.
 */
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import CommandTerminal from './CommandTerminal';

jest.setTimeout(60000);
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── Scripted Chrome ────────────────────────────────────────────────────────
const script = {
  // Every start() succeeds, then ~10ms later Chrome fires a transient
  // network error followed by onend — a Wi-Fi blip mid-session.
  flap: false,
  // The next start() throws InvalidStateError and that instance never
  // emits any event again (phantom "already running" state).
  phantomNextStart: false,
};

class FakeUtterance {
  constructor(text) {
    this.text = String(text);
    this.lang = '';
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  }
}

const TTS_DELAY = 150; // how long a spoken confirmation "lasts"

class FakeRecognition {
  static instances = [];

  constructor() {
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.lang = '';
    this.running = false;
    this.timers = [];
    FakeRecognition.instances.push(this);
  }

  later(fn, ms) {
    const t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  }

  start() {
    if (this.running) {
      const err = new Error('recognition has already started');
      err.name = 'InvalidStateError';
      throw err;
    }
    if (script.phantomNextStart) {
      script.phantomNextStart = false;
      const err = new Error('phantom start');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.running = true;
    this.later(() => {
      if (!this.running) return;
      if (this.onstart) this.onstart();
      if (script.flap) {
        this.later(() => {
          if (!this.running) return;
          this.running = false;
          if (this.onerror) this.onerror({ error: 'network' });
          if (this.onend) this.onend();
        }, 10);
      }
    }, 5);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.later(() => {
      if (this.onend) this.onend();
    }, 5);
  }

  abort() {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  final(text) {
    if (!this.running || !this.onresult) return false;
    this.onresult({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: text } }],
    });
    return true;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const instances = () => FakeRecognition.instances;
const liveRec = () =>
  [...FakeRecognition.instances].reverse().find((r) => r.onresult);
const recognitionRunning = () =>
  [...FakeRecognition.instances].some((r) => r.running);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome ends a continuous session after a stretch of silence (routine).
const chromeAutoEnd = () => {
  const rec = [...FakeRecognition.instances].reverse().find((r) => r.running);
  if (!rec) return false;
  act(() => {
    rec.running = false;
    if (rec.onend) rec.onend();
  });
  return true;
};

// Deliver a finalized voice command through the live recognition instance.
const speakFinal = (text) => {
  const rec = liveRec();
  if (!rec || !rec.running) return false;
  act(() => {
    rec.final(text);
  });
  return true;
};

// delivered=false means the recognizer was dead: the command never even
// reached the pipeline, so no log can appear either.
const speakAndExpect = async (text) => {
  const delivered = speakFinal(text);
  await waitFor(
    () => {
      expect(delivered).toBe(true);
      expect(document.body.textContent).toContain(text);
    },
    { timeout: 5000 }
  );
};

const Harness = (props) => (
  <CommandTerminal
    blobConfig={{ color: '#00f0ff' }}
    isListening
    onToggleListening={jest.fn()}
    onLanguageChange={jest.fn()}
    onGroqModelChange={jest.fn()}
    noiseGateActive={false}
    {...props}
  />
);

// ─── Environment ────────────────────────────────────────────────────────────
beforeAll(() => {
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechSynthesisUtterance = FakeUtterance;
  window.speechSynthesis = {
    speaking: false,
    pending: [],
    speak(utterance) {
      const t = setTimeout(() => {
        if (utterance.onend) utterance.onend();
      }, TTS_DELAY);
      this.pending.push(t);
    },
    cancel() {
      this.pending.forEach(clearTimeout);
      this.pending = [];
    },
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    pause() {},
    resume() {},
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

beforeEach(() => {
  FakeRecognition.instances.length = 0;
  script.flap = false;
  script.phantomNextStart = false;
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        status: 'online',
        volume: 40,
        muted: false,
        brightness: 60,
      }),
    })
  );
});

// ─── Tests ──────────────────────────────────────────────────────────────────
test('healthy session dispatches consecutive commands', async () => {
  render(<Harness />);
  await waitFor(() => expect(recognitionRunning()).toBe(true));

  await speakAndExpect('what time is it');
  await sleep(700);
  await speakAndExpect('what is the date');
  await sleep(700);
  await speakAndExpect('what is the time');
});

test('keeps responding after a transient network flap between commands', async () => {
  render(<Harness />);
  await waitFor(() => expect(recognitionRunning()).toBe(true));

  await speakAndExpect('what time is it');
  await sleep(700);
  await speakAndExpect('what is the date');
  await sleep(700);

  // Chrome routinely ends the session after silence; from now on every
  // restart succeeds and then dies with a network error — a Wi-Fi blip
  // lasting a few seconds (exactly what happens around Groq traffic).
  script.flap = true;
  expect(chromeAutoEnd()).toBe(true);
  await sleep(4500); // unpatched code hits its permanent give-up at ~3.7s

  // Network is back.
  script.flap = false;
  await sleep(1500); // fixed code restarts within one backoff step (≤ 2s)

  await speakAndExpect('what is the date today');
});

test('recovers when Chrome throws InvalidStateError and then goes silent', async () => {
  render(<Harness />);
  await waitFor(() => expect(recognitionRunning()).toBe(true));

  await speakAndExpect('what time is it');
  await sleep(700);

  // The restart races Chrome's internal stop: start() throws
  // InvalidStateError and the instance never emits anything again.
  script.phantomNextStart = true;
  expect(chromeAutoEnd()).toBe(true);
  await sleep(4200); // unpatched code: wedged forever; fixed: 3s watchdog

  await speakAndExpect('what is the date');
});

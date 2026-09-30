import React, { useState, useEffect, useRef, useCallback } from 'react';
import './CommandTerminal.css';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../constants/languages';
import {
  GROQ_MODELS,
  streamGroqChat,
  buildJarvisSystemPrompt,
  VISION_MODEL,
} from '../services/groqService';
import {
  matchLocalCommand,
  runLocalCommand,
  describeAction,
  describeMediaResult,
  describeBrowserResult,
  checkBridge,
  GOOGLE_CAPTCHA_MESSAGE,
} from '../services/commandActions';
import {
  isScreenVisionLive,
  stopScreenVision,
  grabScreenFrame,
} from '../services/screenVision';
import { refreshMediaState } from '../services/mediaControl';
import { searchWeb } from '../services/webSearch';
import { recordSearchContext, getBrowserContext } from '../services/browserControl';

// ─── Speech helpers ──────────────────────────────────────────────────────────
// Cap on kept log entries so long sessions never bloat the DOM.
const LOG_LIMIT = 200;

// How long we wait for SpeechRecognition's `onstart` before assuming Chrome
// silently failed to open the microphone (that failure used to be invisible).
const START_WATCHDOG_MS = 3000;

// Backoff between restart attempts. This is a backoff ladder ONLY — hitting
// its top rung must never stop us from retrying (see rec.onend).
const RESTART_DELAYS = [100, 400, 1000, 2000];

// Liveness net: how often we check for a silently dead recognizer, and how
// long it may stay completely event-free while the mic hardware still hears
// voice activity (Chrome's known "running but silent" wedge).
const LIVENESS_CHECK_MS = 5000;
const EVENT_STARVATION_MS = 10000;

// User-facing messages per Web Speech API error code. null = routine, restart
// silently. Nothing is swallowed any more: an invisible failure is what made
// the mic look "dead".
const RECOGNITION_ERRORS = {
  'not-allowed':
    'Microphone blocked — click the 🔒 icon in the address bar, allow the mic, then toggle the mic off/on.',
  'service-not-allowed':
    'Speech service refused to start — allow microphone access for this site and retry.',
  'audio-capture':
    'No microphone reachable — close other apps using the mic (or check Windows sound settings), then toggle the mic off/on.',
  network: 'Speech recognition needs an internet connection — check your network.',
  'language-not-supported':
    'The selected recognition language is not supported by this browser — pick another language.',
  aborted: null,
  'no-speech': null,
};

// Index of the last character of the first complete sentence in `text`,
// or -1 when the sentence has not finished streaming yet.
const SENTENCE_ENDERS = '.!?।\n';
const findSentenceEnd = (text) => {
  for (let i = 0; i < text.length - 1; i++) {
    if (SENTENCE_ENDERS.indexOf(text[i]) === -1) continue;
    const prev = text[i - 1];
    if (prev && /\s/.test(prev)) continue;
    const next = text[i + 1];
    if (/\s/.test(next)) return i;
    if (/["'”’)\]]/.test(next) && i + 2 < text.length && /\s/.test(text[i + 2])) {
      return i + 1;
    }
  }
  return -1;
};

const tokenizeSpeech = (text) =>
  text
    .toLowerCase()
    .replace(/[.,!?;:'"“”()[\]{}\-_*#`|>«»।]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Heuristic: did the mic just capture JARVIS's own voice out of the speakers?
const looksLikeEcho = (captured, spoken) => {
  if (!captured || !spoken) return false;
  const spokenWords = new Set(tokenizeSpeech(spoken));
  if (!spokenWords.size) return false;
  const capturedWords = tokenizeSpeech(captured);
  if (!capturedWords.length) return true;
  let hits = 0;
  for (let i = 0; i < capturedWords.length; i++) {
    if (spokenWords.has(capturedWords[i])) hits += 1;
  }
  return hits / capturedWords.length >= 0.5;
};

const CommandTerminal = ({
  blobConfig = { color: '#00f0ff' },
  isListening,
  onToggleListening,
  selectedLanguage = DEFAULT_LANGUAGE,
  onLanguageChange,
  groqModel = 'qwen/qwen3.8-27b',
  onGroqModelChange,
  // Driven by App/VoicePlasma (single shared mic) — see VoicePlasma's
  // onVoiceActivity callback. This component no longer opens its own mic.
  noiseGateActive = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [voiceFeedbackEnabled, setVoiceFeedbackEnabled] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [commandLogs, setCommandLogs] = useState([
    {
      id: 1,
      text: 'J.A.R.V.I.S (Jarvis) — personal AI assistant created by Harshit Gupta. Neural Core initialized. Groq LPU + Noise-Gate VAD online.',
      sender: 'SYSTEM',
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    },
  ]);
  const [recognitionActive, setRecognitionActive] = useState(false);
  const [speechError, setSpeechError] = useState(null);
  // Desktop bridge (bridge/server.js) — on when apps/files can be opened.
  const [bridgeOnline, setBridgeOnline] = useState(false);

  const recognitionRef = useRef(null);
  const isStartedRef = useRef(false);
  const shouldListenRef = useRef(isListening);
  const noiseGateActiveRef = useRef(noiseGateActive);
  const restartTimerRef = useRef(null);
  const autoCloseTimerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const currentTranscriptRef = useRef('');
  const terminalBodyRef = useRef(null);
  const selectedLangRef = useRef(selectedLanguage);
  const groqModelRef = useRef(groqModel);
  const commandLogsRef = useRef(commandLogs);
  const isGeneratingRef = useRef(isGenerating);
  const voiceFeedbackEnabledRef = useRef(voiceFeedbackEnabled);
  // Stable ref that always holds the latest handleProcessUserPrompt logic
  const handleProcessUserPromptRef = useRef(null);

  // ── Speech engine plumbing ──────────────────────────────────────────────
  const startRecognitionRef = useRef(null); // set by the recognition effect
  const stopRecognitionRef = useRef(null);
  const abortRecognitionRef = useRef(null);
  const uidRef = useRef(1000); // unique log ids (Date.now can collide)
  const abortControllerRef = useRef(null); // in-flight Groq request
  const requestIdRef = useRef(0); // barge-in: which request is authoritative
  const ttsSessionRef = useRef(null); // streaming TTS session
  const isSpeakingRef = useRef(false); // JARVIS talking out loud right now
  const spokenTextRef = useRef(''); // what we actually spoke this exchange
  const suppressedRef = useRef([]); // captures made while JARVIS was speaking
  const voicesCacheRef = useRef([]); // TTS voices (async on first load)
  const pendingStreamRef = useRef(null); // batched streaming log update
  const streamFlushTimerRef = useRef(null);
  const transcriptTimerRef = useRef(null); // throttled live transcript
  const lastDispatchedRef = useRef({ text: '', at: 0 }); // voice dedupe
  const closeWhenSilentRef = useRef(null); // close console after speech ends

  // Keep refs in sync with latest state/props
  useEffect(() => { shouldListenRef.current = isListening; }, [isListening]);
  useEffect(() => { noiseGateActiveRef.current = noiseGateActive; }, [noiseGateActive]);
  useEffect(() => { selectedLangRef.current = selectedLanguage; }, [selectedLanguage]);
  useEffect(() => { groqModelRef.current = groqModel; }, [groqModel]);
  useEffect(() => { commandLogsRef.current = commandLogs; }, [commandLogs]);
  useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);
  useEffect(() => { voiceFeedbackEnabledRef.current = voiceFeedbackEnabled; }, [voiceFeedbackEnabled]);

  // Auto-scroll terminal logs to bottom when new chunks arrive
  useEffect(() => {
    if (terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [commandLogs, currentTranscript, isGenerating]);

  // Cache TTS voices — getVoices() returns [] until voiceschanged fires, which
  // is why voice matching silently failed on first use.
  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined;
    const syncVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (list && list.length) voicesCacheRef.current = list;
    };
    syncVoices();
    if (window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', syncVoices);
    }
    return () => {
      if (window.speechSynthesis.removeEventListener) {
        window.speechSynthesis.removeEventListener('voiceschanged', syncVoices);
      }
    };
  }, []);

  // Desktop bridge health — the footer badge shows whether apps/files can be
  // opened yet. Web links fall back to a plain new tab when it is offline.
  useEffect(() => {
    let alive = true;
    const poll = async (force) => {
      const online = await checkBridge(force);
      if (alive) setBridgeOnline(online);
    };
    poll(true);
    const timer = setInterval(() => poll(false), 20000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Muting voice output must also stop speech already in progress
  useEffect(() => {
    if (voiceFeedbackEnabled) return;
    if (ttsSessionRef.current) {
      ttsSessionRef.current.cancel();
      ttsSessionRef.current = null;
    }
    setSpeakingState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceFeedbackEnabled]);

  // Live transcript, throttled — interim results arrive many times per second
  // and used to re-render the whole terminal with each one.
  const queueTranscript = (text) => {
    currentTranscriptRef.current = text;
    if (transcriptTimerRef.current) return;
    transcriptTimerRef.current = setTimeout(() => {
      transcriptTimerRef.current = null;
      setCurrentTranscript(currentTranscriptRef.current);
    }, 80);
  };

  // Groq streams faster than React can sensibly re-render — flush at ~15Hz
  const scheduleLogFlush = (logId, text) => {
    pendingStreamRef.current = { logId, text };
    if (streamFlushTimerRef.current) return;
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null;
      const pending = pendingStreamRef.current;
      pendingStreamRef.current = null;
      if (!pending) return;
      setCommandLogs((prev) =>
        prev.map((log) =>
          log.id === pending.logId && log.isStreaming
            ? { ...log, text: pending.text }
            : log
        )
      );
    }, 60);
  };

  // Tracks whether JARVIS is talking out loud. When the reply finishes, any
  // speech captured meanwhile is reviewed: speaker echo is discarded, real
  // user speech is dispatched (so you can talk over a reply).
  const setSpeakingState = useCallback((speaking) => {
    if (isSpeakingRef.current === speaking) return;
    isSpeakingRef.current = speaking;
    if (speaking) return;

    if (currentTranscriptRef.current) {
      currentTranscriptRef.current = '';
      setCurrentTranscript('');
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    const captured = suppressedRef.current;
    suppressedRef.current = [];
    if (captured.length && handleProcessUserPromptRef.current) {
      const text = captured.join(' ').trim();
      if (text && !looksLikeEcho(text, spokenTextRef.current)) {
        handleProcessUserPromptRef.current(text, {
          dedupe: true,
          dedupeWindowMs: 20000,
        });
      }
    }

    // Stream + speech are now complete → start the 5s auto-close countdown
    const pendingClose = closeWhenSilentRef.current;
    closeWhenSilentRef.current = null;
    if (pendingClose) pendingClose();
  }, []);

  // ── STREAMING TTS SESSION ──────────────────────────────────────────────
  // Speaks the reply sentence-by-sentence while tokens are still arriving,
  // instead of waiting for the whole response to finish.
  const createTtsSession = useCallback(
    (langCode) => {
      let spokenCount = 0;
      let latest = '';
      let pendingUtterances = 0;
      let pendingChars = 0;
      let cancelled = false;
      let safetyTimer = null;

      const disarmSafety = () => {
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
      };

      const emit = (rawText) => {
        if (cancelled) return;
        const clean = rawText
          .replace(/\[.*?\]/g, '')
          .replace(/[*_#`]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!clean) return;
        if (!voiceFeedbackEnabledRef.current || !('speechSynthesis' in window)) {
          return;
        }
        try {
          const utterance = new SpeechSynthesisUtterance(clean);
          utterance.lang = langCode || 'en-US';
          utterance.rate = 1.05;
          utterance.pitch = 0.95;

          const voices = voicesCacheRef.current;
          if (voices.length) {
            const prefix = (langCode || 'en').split('-')[0].toLowerCase();
            const matchedVoice = voices.find(
              (v) =>
                v.lang.toLowerCase() === (langCode || '').toLowerCase() ||
                v.lang.toLowerCase().startsWith(prefix)
            );
            if (matchedVoice) utterance.voice = matchedVoice;
          }

          pendingUtterances += 1;
          pendingChars += clean.length;
          const settle = () => {
            pendingUtterances = Math.max(0, pendingUtterances - 1);
            pendingChars = Math.max(0, pendingChars - clean.length);
            if (!pendingUtterances && !cancelled) {
              disarmSafety();
              setSpeakingState(false);
            }
          };
          utterance.onend = settle;
          utterance.onerror = settle;

          spokenTextRef.current = `${spokenTextRef.current} ${clean}`.trim();
          setSpeakingState(true);

          // Safety net for engines that never fire onend (Chrome does this)
          disarmSafety();
          safetyTimer = setTimeout(() => {
            safetyTimer = null;
            pendingUtterances = 0;
            pendingChars = 0;
            if (!cancelled) setSpeakingState(false);
          }, pendingChars * 70 + 1500);

          window.speechSynthesis.speak(utterance);
        } catch (e) {
          console.warn('Speech synthesis error:', e);
        }
      };

      const session = {
        push(full) {
          if (cancelled) return;
          latest = full;
          let guard = 0;
          while (guard++ < 8) {
            const unsent = latest.slice(spokenCount);
            if (unsent.length < 2) break;
            const end = findSentenceEnd(unsent);
            if (end < 0) break;
            const piece = unsent.slice(0, end + 1);
            spokenCount += piece.length;
            emit(piece);
          }
        },
        finish() {
          if (cancelled) return;
          const rest = latest.slice(spokenCount);
          spokenCount = latest.length;
          if (rest) emit(rest);
        },
        cancel() {
          if (cancelled) return;
          cancelled = true;
          disarmSafety();
          suppressedRef.current = [];
          pendingUtterances = 0;
          pendingChars = 0;
          // Only the session that currently owns the voice may tear it down:
          // a stale session losing a barge-in race must never cut off the
          // newer reply that is speaking now.
          if (ttsSessionRef.current === session) {
            try {
              window.speechSynthesis.cancel();
            } catch (e) {
              /* noop */
            }
            setSpeakingState(false);
          }
        },
      };
      return session;
    },
    [setSpeakingState]
  );

  // Auto-close — always scheduled from the END of the spoken answer (or from
  // the end of streaming when voice is muted), so the console never slides up
  // while JARVIS is still talking.
  const scheduleAutoClose = useCallback(() => {
    if (isPinned) return;
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
    }
    autoCloseTimerRef.current = setTimeout(() => {
      if (!isPinned) {
        setIsOpen(false);
      }
    }, 5000);
  }, [isPinned]);

  // ── SCREEN VISION ("read the screen" / "explain this screen") ──────────
  // Runs only while the bottom-left SCREEN VISION switch is ON — the browser
  // grants screen access from that click, never from a voice command. One
  // frame is encoded per request and sent through the local bridge to the
  // multimodal model; the answer then streams through the same sentence-TTS
  // and 5-seconds-after-speech auto-close pipeline as a normal reply.
  const handleVisionAction = async (action, spokenText, langCode) => {
    const stamp = () =>
      new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    const hasDevanagari = /[\u0900-\u097F]/.test(spokenText);
    const isHindi =
      hasDevanagari || (langCode || '').toLowerCase().startsWith('hi');
    const langObj = SUPPORTED_LANGUAGES.find((l) => l.code === langCode);
    const badge = hasDevanagari
      ? '\uD83C\uDDEE\uD83C\uDDF3 HI'
      : langObj
      ? `${langObj.flag} ${langObj.code.split('-')[0].toUpperCase()}`
      : 'VOICE';

    // ── Fixed copy for every path that must NOT touch the model ─────────
    const copy = {
      off: isHindi
        ? 'स्क्रीन विज़न बंद है, सर। अब मैं आपकी स्क्रीन नहीं देख सकता।'
        : 'Screen vision is off, Sir — I can no longer see your screen.',
      needSwitch: isHindi
        ? 'स्क्रीन विज़न बंद है। नीचे बाएँ कोने का SCREEN VISION स्विच चालू कीजिए, फिर दोबारा कहिए, सर।'
        : 'Screen vision is off. Please turn on the SCREEN VISION switch at the bottom-left corner, then ask me again, Sir.',
      grantByHand: isHindi
        ? 'स्क्रीन देखने की अनुमति सिर्फ आप दे सकते हैं — नीचे बाएँ कोने का SCREEN VISION स्विच चालू कीजिए, सर।'
        : 'Only you can allow me to see your screen — please turn on the SCREEN VISION switch at the bottom-left corner, Sir.',
      alreadyOn: isHindi
        ? 'स्क्रीन विज़न पहले से चालू है, सर।'
        : 'Screen vision is already on, Sir.',
      statusOn: isHindi
        ? 'स्क्रीन विज़न चालू है, सर — मैं आपकी स्क्रीन देख सकता हूँ।'
        : 'Screen vision is on, Sir — I can see your screen.',
      statusOff: isHindi
        ? 'स्क्रीन विज़न बंद है, सर।'
        : 'Screen vision is off, Sir.',
      captureFailed: isHindi
        ? 'स्क्रीन कैप्चर नहीं हो पाया, सर। दोबारा कोशिश कीजिए।'
        : 'I could not capture the screen, Sir. Please try again.',
    };

    const live = isScreenVisionLive();
    let localMsg = null;

    if (action.mode === 'off') {
      stopScreenVision();
      localMsg = copy.off;
    } else if (action.mode === 'on') {
      localMsg = live ? copy.alreadyOn : copy.grantByHand;
    } else if (action.mode === 'status') {
      localMsg = live ? copy.statusOn : copy.statusOff;
    } else if (!live) {
      localMsg = copy.needSwitch;
    }

    // ── Fixed reply: log it, speak it, close 5s after the speech ────────
    const replyLocally = (text) => {
      const userLogId = uidRef.current++;
      const replyLogId = uidRef.current++;
      setCommandLogs((prev) =>
        [
          ...prev,
          {
            id: userLogId,
            text: spokenText,
            sender: 'VOICE_USER',
            langBadge: badge,
            timestamp: stamp(),
          },
          {
            id: replyLogId,
            text,
            sender: 'JARVIS',
            timestamp: stamp(),
          },
        ].slice(-LOG_LIMIT)
      );
      setIsOpen(true);
      setIsGenerating(false);

      if (voiceFeedbackEnabledRef.current && 'speechSynthesis' in window) {
        spokenTextRef.current = '';
        const tts = createTtsSession(langCode);
        ttsSessionRef.current = tts;
        tts.push(text);
        tts.finish();
        if (isSpeakingRef.current) {
          closeWhenSilentRef.current = scheduleAutoClose;
        } else {
          closeWhenSilentRef.current = null;
          scheduleAutoClose();
        }
      } else {
        closeWhenSilentRef.current = null;
        scheduleAutoClose();
      }
    };

    if (localMsg) {
      replyLocally(localMsg);
      return;
    }

    // ── Live: encode one frame, then stream the model's answer ──────────
    let frame;
    try {
      frame = grabScreenFrame();
    } catch (e) {
      replyLocally(copy.captureFailed);
      return;
    }

    const myId = requestIdRef.current;
    const isRead = action.mode === 'read';
    const userLogId = uidRef.current++;
    const jarvisLogId = uidRef.current++;

    const messages = [
      {
        role: 'system',
        content: isRead
          ? 'You are an exact screen reader. Transcribe ALL text visible in the given screenshot exactly as written, in natural reading order. Never add commentary, greetings or "Sir" — output the text only. If there is no readable text, output exactly: No readable text on screen.'
          : buildJarvisSystemPrompt(langCode),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: isRead
              ? 'Read all the text on this screen now.'
              : 'This is a live screenshot of my computer screen. Look at it and explain what is on it — describe any images, diagrams, photos or apps you see and what they show. Keep it short and natural.',
          },
          { type: 'image_url', image_url: { url: frame } },
        ],
      },
    ];

    const controller = new AbortController();
    abortControllerRef.current = controller;
    spokenTextRef.current = '';
    const tts = createTtsSession(langCode);
    ttsSessionRef.current = tts;

    setCommandLogs((prev) =>
      [
        ...prev,
        {
          id: userLogId,
          text: spokenText,
          sender: 'VOICE_USER',
          langBadge: badge,
          timestamp: stamp(),
        },
        {
          id: jarvisLogId,
          text: isRead
            ? '👁 SCREEN VISION // reading the text on your screen…'
            : '👁 SCREEN VISION // looking at your screen…',
          sender: 'JARVIS',
          isStreaming: true,
          modelBadge: 'VISION',
          timestamp: stamp(),
        },
      ].slice(-LOG_LIMIT)
    );
    setIsOpen(true);
    setIsGenerating(false);

    let accumulatedText = '';
    let finalText = null;

    try {
      await streamGroqChat(
        messages,
        (token, full) => {
          if (myId !== requestIdRef.current) return; // superseded by barge-in
          accumulatedText = full;
          tts.push(full); // speak sentences as they complete
          scheduleLogFlush(jarvisLogId, full); // batched UI update
        },
        {
          model: VISION_MODEL,
          temperature: isRead ? 0.1 : 0.5,
          maxTokens: isRead ? 700 : 400,
          signal: controller.signal,
        }
      );
      finalText = accumulatedText;
    } catch (err) {
      const superseded = myId !== requestIdRef.current || err.name === 'AbortError';
      if (!superseded) {
        console.error('Screen vision error:', err);
        const errorFeedback = `⚠ SCREEN VISION FAILED // ${
          err.message || 'could not analyze the screen'
        }`;
        setCommandLogs((prev) =>
          prev.map((log) =>
            log.id === jarvisLogId
              ? { ...log, text: errorFeedback, isStreaming: false, isError: true }
              : log
          )
        );
      }
    } finally {
      const superseded = myId !== requestIdRef.current;
      if (superseded) {
        tts.cancel();
        if (ttsSessionRef.current === tts) ttsSessionRef.current = null;
      } else {
        tts.finish(); // speak whatever is left of the answer
        if (finalText !== null) {
          setCommandLogs((prev) =>
            prev.map((log) =>
              log.id === jarvisLogId
                ? { ...log, text: finalText, isStreaming: false }
                : log
            )
          );
        }
        setIsGenerating(false);
        if (isSpeakingRef.current) {
          closeWhenSilentRef.current = scheduleAutoClose;
        } else {
          closeWhenSilentRef.current = null;
          scheduleAutoClose();
        }
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  // ── LOCAL ACTIONS (desktop / web) ────────────────────────────────────
  // "open youtube / search X / play X / open notepad / open my resume file"
  // are executed directly — no model round-trip, so they answer instantly.
  // The console then closes 5s AFTER the spoken confirmation, exactly like a
  // full reply.
  const handleLocalAction = async (action, spokenText, langCode) => {
    // Screen vision answers with a full model reply (and owns its frame +
    // logging pipeline), so it never goes through the one-line confirmation.
    if (action.type === 'vision') {
      await handleVisionAction(action, spokenText, langCode);
      return;
    }

    const stamp = () =>
      new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    const langObj = SUPPORTED_LANGUAGES.find((l) => l.code === langCode);
    const hasDevanagari = /[\u0900-\u097F]/.test(spokenText);
    const isHindi = hasDevanagari || (langCode || '').toLowerCase().startsWith('hi');
    const described = describeAction(action, isHindi, langCode);

    const userLogId = uidRef.current++;
    const actionLogId = uidRef.current++;

    setCommandLogs((prev) =>
      [
        ...prev,
        {
          id: userLogId,
          text: spokenText,
          sender: 'VOICE_USER',
          langBadge: hasDevanagari
            ? '\uD83C\uDDEE\uD83C\uDDF3 HI'
            : langObj
            ? `${langObj.flag} ${langObj.code.split('-')[0].toUpperCase()}`
            : 'VOICE',
          timestamp: stamp(),
        },
        {
          id: actionLogId,
          text: described.pending,
          sender: 'SYSTEM',
          timestamp: stamp(),
        },
      ].slice(-LOG_LIMIT)
    );
    setIsOpen(true);
    // An action interrupts a streaming reply: that reply's `finally` runs in
    // the superseded branch and never clears this flag, so clear it here or
    // the console would stay stuck on "STREAMING...".
    setIsGenerating(false);

    const result = await runLocalCommand(action);
    // Media replies carry the real hardware percentages — speak those
    // ("Volume set to 50%, Sir."), not the static pending copy.
    const mediaCopy =
      action.type === 'media'
        ? describeMediaResult(action, result, isHindi)
        : null;
    // Browser replies describe what actually happened ("Went back, Sir." /
    // "Opened the official website, Sir.").
    const browserCopy =
      action.type === 'browser'
        ? describeBrowserResult(action, result, isHindi)
        : null;
    const outcome = result.ok
      ? browserCopy
        ? browserCopy.done
        : mediaCopy
        ? mediaCopy.done
        : `${described.done}${
            result.opened ? ` → ${result.opened}` : ''
          }`
      : browserCopy
      ? browserCopy.done
      : mediaCopy
      ? mediaCopy.done
      : `⚠ ACTION FAILED // ${result.error}`;
    setCommandLogs((prev) =>
      prev.map((log) =>
        log.id === actionLogId
          ? { ...log, text: outcome, isError: !result.ok }
          : log
      )
    );

    // Short voice confirmation, then close 5s after it finishes.
    if (voiceFeedbackEnabledRef.current && 'speechSynthesis' in window) {
      spokenTextRef.current = '';
      const tts = createTtsSession(langCode);
      ttsSessionRef.current = tts;
      tts.push(
        browserCopy
          ? browserCopy.speak
          : mediaCopy
          ? mediaCopy.speak
          : result.ok
          ? described.speak
          : result.captcha
          ? GOOGLE_CAPTCHA_MESSAGE // exact sentence — detected, never retried
          : described.failSpeak
      );
      tts.finish();
      if (isSpeakingRef.current) {
        closeWhenSilentRef.current = scheduleAutoClose;
      } else {
        closeWhenSilentRef.current = null;
        scheduleAutoClose();
      }
    } else {
      closeWhenSilentRef.current = null;
      scheduleAutoClose();
    }
  };

  // ─── PROCESS PROMPT (stable via mutable ref) ─────────────────────────────
  // Written into the ref on every render so it always sees fresh state/props,
  // while the recognition handlers keep calling the stable wrapper below.
  handleProcessUserPromptRef.current = async (inputText, opts = {}) => {
    const cleanPrompt = inputText.trim();
    if (!cleanPrompt) return;

    // Dedupe: the silence-commit and Chrome's own `final` result routinely
    // carry the exact same utterance — dispatching it twice looked like a bug.
    if (opts.dedupe) {
      const norm = cleanPrompt.toLowerCase().replace(/\s+/g, ' ').trim();
      const now = Date.now();
      const windowMs = opts.dedupeWindowMs || 6000;
      if (
        lastDispatchedRef.current.text === norm &&
        now - lastDispatchedRef.current.at < windowMs
      ) {
        currentTranscriptRef.current = '';
        setCurrentTranscript('');
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        return;
      }
      lastDispatchedRef.current = { text: norm, at: now };
    }

    // Keep the SYSTEM CONTROLS percentages honest — refresh in the background
    // (also picks up volume changed outside JARVIS, e.g. laptop Fn keys).
    // Fire-and-forget: never blocks or fails the prompt itself.
    refreshMediaState();

    // Authoritative request id: callbacks from an older request are ignored.
    const id = ++requestIdRef.current;

    // BARGE-IN: a new command cancels the in-flight reply instead of being
    // silently dropped (this was the main "voice not responding" bug).
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch (e) {
        /* noop */
      }
      abortControllerRef.current = null;
    }
    if (ttsSessionRef.current) {
      ttsSessionRef.current.cancel();
      ttsSessionRef.current = null;
    }
    // A new command also cancels any pending auto-close (including the stray
    // one that the cancel above may have armed for the previous exchange)
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
    closeWhenSilentRef.current = null;

    setIsOpen(true);
    setCurrentTranscript('');
    currentTranscriptRef.current = '';
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    const currentLang = selectedLangRef.current;
    const langObj = SUPPORTED_LANGUAGES.find((l) => l.code === currentLang);
    const hasDevanagari = /[\u0900-\u097F]/.test(cleanPrompt);

    // Local action (open / search / play ...) — handled instantly, no model.
    // The active site enables contextual follow-ups (YouTube → "search for X"
    // searches inside YouTube; browser state stays separate from search state).
    const localAction = matchLocalCommand(cleanPrompt, {
      activeSite: getBrowserContext().active_site,
    });

    // ── WEB RESEARCH: search the web FIRST, then answer from the results ──
    // When current information is required the reply must come from the
    // retrieved results — never from the model's training memory. A failed
    // search is SPOKEN as a failure (and the mic keeps listening).
    let research = null;
    if (localAction && localAction.type === 'research') {
      research = await searchWeb(localAction.query);
      if (id !== requestIdRef.current) return; // superseded by barge-in
      if (!research.ok) {
        await handleLocalAction(
          { type: 'researchFail', error: research.error },
          cleanPrompt,
          currentLang
        );
        return;
      }
      // Short-term search context so "play/open the first result" works
      // afterwards (web-search context — never mixed with browser state).
      recordSearchContext(
        localAction.query,
        research.results,
        research.provider
      );
    } else if (localAction) {
      await handleLocalAction(localAction, cleanPrompt, currentLang);
      return;
    }

    const userLogId = uidRef.current++;
    const userLog = {
      id: userLogId,
      text: cleanPrompt,
      sender: 'VOICE_USER',
      langBadge: hasDevanagari
        ? '\uD83C\uDDEE\uD83C\uDDF3 HI'
        : langObj
        ? `${langObj.flag} ${langObj.code.split('-')[0].toUpperCase()}`
        : 'VOICE',
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };

    const jarvisLogId = uidRef.current++;
    const activeModel = groqModelRef.current;
    const isGuard = activeModel.includes('prompt-guard');

    // Research answers show their sources above the reply (log-only — the
    // URLs are never read aloud).
    const sourcesLog = research
      ? {
          id: uidRef.current++,
          text:
            `🔎 WEB SEARCH // "${research.query}" via ${research.provider} — ` +
            research.results
              .slice(0, 6)
              .map((rr, i) => `[${i + 1}] ${rr.title} — ${rr.url}`)
              .join('  ·  '),
          sender: 'SYSTEM',
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        }
      : null;

    const initialJarvisLog = {
      id: jarvisLogId,
      text: '',
      sender: 'JARVIS',
      isStreaming: true,
      modelBadge: isGuard ? 'GUARD 22M' : 'GROQ LPU',
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };

    // Build history from ref (always fresh, avoids stale-closure issue)
    const historyContext = commandLogsRef.current
      .filter((l) => l.sender === 'VOICE_USER' || l.sender === 'JARVIS')
      .slice(-6)
      .map((l) => ({
        role: l.sender === 'VOICE_USER' ? 'user' : 'assistant',
        content: l.text,
      }));

    // Research mode: the model must answer from the retrieved results only.
    const researchDirective = research
      ? '\n\nWEB RESEARCH MODE — live web-search results for the user\'s latest question follow this message (system role, numbered [1], [2], …). Rules:\n- Answer ONLY from those results; never from training memory.\n- Begin with "According to the latest information I found…" (or the equivalent in the user\'s language).\n- Cite sources inline as [1], [2] where useful.\n- If the results do not contain the answer, clearly say the search did not find it — do not guess.\n- Keep it short and conversational; the reply is spoken aloud.'
      : '';

    const messages = [
      {
        role: 'system',
        content: buildJarvisSystemPrompt(currentLang) + researchDirective,
      },
      ...historyContext,
      ...(research
        ? [
            {
              role: 'system',
              content:
                `SEARCH RESULTS for "${research.query}" (provider: ${research.provider}):\n` +
                research.results
                  .map(
                    (rr, i) =>
                      `[${i + 1}] ${rr.title}\n    URL: ${rr.url}${
                        rr.snippet ? `\n    ${rr.snippet}` : ''
                      }`
                  )
                  .join('\n'),
            },
          ]
        : []),
      { role: 'user', content: cleanPrompt },
    ];

    // New streaming request + a fresh sentence-by-sentence voice session
    const controller = new AbortController();
    abortControllerRef.current = controller;
    spokenTextRef.current = '';
    const tts = createTtsSession(currentLang);
    ttsSessionRef.current = tts;

    setCommandLogs((prev) =>
      [
        ...prev,
        userLog,
        ...(sourcesLog ? [sourcesLog] : []),
        initialJarvisLog,
      ].slice(-LOG_LIMIT)
    );
    setIsGenerating(true);

    let accumulatedText = '';
    let finalText = null;

    try {
      await streamGroqChat(
        messages,
        (token, full) => {
          if (id !== requestIdRef.current) return; // superseded by barge-in
          accumulatedText = full;
          tts.push(full); // speak sentences as they complete
          scheduleLogFlush(jarvisLogId, full); // batched UI update
        },
        {
          model: activeModel,
          temperature: isGuard ? 0.0 : 0.65,
          signal: controller.signal,
        }
      );
      finalText = accumulatedText;
    } catch (err) {
      const superseded =
        id !== requestIdRef.current || err.name === 'AbortError';
      if (!superseded) {
        console.error('Groq error:', err);
        const errorFeedback = `Neural Link Error: ${err.message || 'Failed to connect to Groq LPU'}.`;
        setCommandLogs((prev) =>
          prev.map((log) =>
            log.id === jarvisLogId
              ? { ...log, text: errorFeedback, isStreaming: false, isError: true }
              : log
          )
        );
      }
    } finally {
      const superseded = id !== requestIdRef.current;
      if (superseded) {
        // A newer command took over — silence this reply's voice immediately
        tts.cancel();
        if (ttsSessionRef.current === tts) ttsSessionRef.current = null;
      } else {
        tts.finish(); // speak whatever is left of the answer
        if (finalText !== null) {
          setCommandLogs((prev) =>
            prev.map((log) =>
              log.id === jarvisLogId
                ? { ...log, text: finalText, isStreaming: false }
                : log
            )
          );
        }
        setIsGenerating(false);
        if (isSpeakingRef.current) {
          // Still talking: the console closes 5s AFTER the speech finishes
          closeWhenSilentRef.current = scheduleAutoClose;
        } else {
          // Voice muted, or reply already spoken: close 5s after the answer
          closeWhenSilentRef.current = null;
          scheduleAutoClose();
        }
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  // Stable wrapper — never changes identity, so recognition handlers can safely call it
  const handleProcessUserPrompt = useCallback(
    (text, opts) => handleProcessUserPromptRef.current(text, opts),
    [] // intentionally empty — proxy through mutable ref
  );

  // Safe starter — delegates to the effect-owned start routine, which also
  // arms the start watchdog and can recreate a wedged recognition instance.
  const safeStartRecognition = useCallback(() => {
    if (startRecognitionRef.current) {
      startRecognitionRef.current();
    }
  }, []);

  // Safe stopper (user turned the mic off)
  const safeStopRecognition = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (stopRecognitionRef.current) {
      stopRecognitionRef.current();
    } else if (recognitionRef.current && isStartedRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        /* noop */
      }
      isStartedRef.current = false;
    }
    setRecognitionActive(false);
  }, []);

  // Safe aborter (used when switching language)
  const safeAbortRecognition = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (abortRecognitionRef.current) {
      abortRecognitionRef.current();
    } else if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {
        /* noop */
      }
      isStartedRef.current = false;
    }
    setRecognitionActive(false);
  }, []);

  // ── Speech recognition engine ──────────────────────────────────────────────
  // Created lazily and RECREATED on failure: Chrome permanently wedges an
  // instance after an audio-capture/service error, and that failure used to
  // happen silently — the mic looked dead with no message anywhere.
  useEffect(() => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setSpeechError(
        'Web Speech API is not supported in this browser. Please use Chrome or Edge.'
      );
      return undefined;
    }

    let disposed = false;
    let recognition = null;
    let watchdog = null;
    let pendingStart = false;
    // Failures since the last successful start/result. This is a BACKOFF
    // LEVEL, never a death sentence: it resets on onstart/onresult and the
    // restart delay clamps at the top of RESTART_DELAYS, so recovery is
    // always automatic (the old "4 strikes and the mic is dead until you
    // toggle it" ratchet was the "stops responding after 2-3 commands" bug).
    let attempts = 0;
    // Timestamp of the last event of ANY kind from the recognizer — used to
    // detect Chrome's silent-death state (running, but never speaking again).
    let lastRecEventAt = Date.now();

    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const scheduleAttempt = (delay) => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        attemptStart();
      }, delay);
    };

    // Chrome sometimes neither fires onstart nor onerror (mic held by another
    // app, or start() raced an internal stop and threw InvalidStateError while
    // the instance never actually runs). Without this watchdog the component
    // sat on isStartedRef=true forever and never recovered — the mic simply
    // died with no message. Any real event (onstart) disarms it.
    const armStartWatchdog = () => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        watchdog = null;
        if (disposed || !pendingStart) return;
        console.warn('SpeechRecognition never started — recreating instance');
        attempts += 1;
        dropInstance();
        attemptStart();
      }, START_WATCHDOG_MS);
    };

    const dropInstance = () => {
      if (recognition) {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch (e) {
          /* never started */
        }
      }
      recognition = null;
      recognitionRef.current = null;
      pendingStart = false;
      isStartedRef.current = false;
    };

    const buildRecognition = () => {
      const rec = new SpeechRecognitionCtor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = selectedLangRef.current;

      rec.onstart = () => {
        if (disposed) return;
        lastRecEventAt = Date.now();
        clearWatchdog();
        pendingStart = false;
        isStartedRef.current = true;
        // A successful start proves the sensor recovered — forgive every
        // earlier failure so one bad stretch can never ratchet to death.
        attempts = 0;
        setRecognitionActive(true);
        setSpeechError(null);
      };

      rec.onerror = (event) => {
        if (disposed) return;
        lastRecEventAt = Date.now();
        const message = RECOGNITION_ERRORS[event.error];
        if (message) {
          console.warn('Speech recognition error:', event.error);
          attempts += 1;
          setSpeechError(message);
        }
        // 'no-speech' / 'aborted' are routine — onend restarts us
      };

      rec.onend = () => {
        if (disposed) return;
        lastRecEventAt = Date.now();
        clearWatchdog();
        pendingStart = false;
        isStartedRef.current = false;
        setRecognitionActive(false);
        if (!shouldListenRef.current) return;
        // NEVER give up permanently. RESTART_DELAYS is only a backoff ladder
        // and the index clamps at its top, so we keep retrying forever at
        // 2s intervals until Chrome comes back. The previous
        // `attempts >= RESTART_DELAYS.length` branch stopped restarting until
        // a manual mic toggle/reload: a ~3-second burst of transient errors
        // (network blip, mic contention) after command 2 or 3 therefore killed
        // the microphone for the entire session — the reported bug.
        const delay = RESTART_DELAYS[Math.min(attempts, RESTART_DELAYS.length - 1)];
        scheduleAttempt(delay);
      };

      rec.onresult = (event) => {
        // ANY recognition traffic proves the pipeline is alive — reset the
        // failure backoff BEFORE the echo-suppression early-return below.
        // (The reset used to sit under `if (isSpeakingRef)`, so results
        // arriving while JARVIS was talking could not forgive earlier
        // errors and failures stacked up across commands.)
        attempts = 0;
        lastRecEventAt = Date.now();

        let interim = '';
        let finalized = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const seg = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalized += seg;
          } else {
            interim += seg;
          }
        }

        // JARVIS is talking — the mic is mostly hearing the speakers. Buffer
        // the capture for review when the reply ends instead of treating
        // echo as a command (that used to fire phantom commands).
        if (isSpeakingRef.current) {
          if (currentTranscriptRef.current) {
            currentTranscriptRef.current = '';
            setCurrentTranscript('');
          }
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              const text = event.results[i][0].transcript.trim();
              if (text) suppressedRef.current.push(text);
            }
          }
          return;
        }

        setIsOpen(true);
        if (autoCloseTimerRef.current) {
          clearTimeout(autoCloseTimerRef.current);
          autoCloseTimerRef.current = null;
        }

        const activeSpeechText = finalized || interim;
        if (activeSpeechText) {
          queueTranscript(activeSpeechText);
        }

        // Immediate dispatch on finalized phrase
        if (finalized.trim()) {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          handleProcessUserPrompt(finalized.trim(), { dedupe: true });
          return;
        }

        // Silence detection: commit the interim text after 0.9s of quiet
        // (was 1.3s — that extra wait was very noticeable)
        if (interim.trim()) {
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            const buffered = currentTranscriptRef.current.trim();
            if (buffered) handleProcessUserPrompt(buffered, { dedupe: true });
          }, 900);
        }
      };

      recognition = rec;
      recognitionRef.current = rec;
    };

    // Starts recognition, arms the watchdog, and recreates a dead instance.
    const attemptStart = () => {
      if (disposed || !shouldListenRef.current || isStartedRef.current) return;
      if (!recognition) buildRecognition();

      pendingStart = true;
      try {
        recognition.lang = selectedLangRef.current;
        recognition.start();
        isStartedRef.current = true;
      } catch (e) {
        if (e.name === 'InvalidStateError') {
          // Chrome says "already started" — usually true, but if that start
          // was phantom (it raced an internal stop) NO event will ever
          // arrive, and treating this as pure success used to leave
          // isStartedRef=true blocking every future attempt: a silent,
          // permanent wedge. Keep pendingStart set and let the watchdog
          // rebuild the instance when nothing happens.
          clearWatchdog();
          watchdog = setTimeout(() => {
            watchdog = null;
            if (disposed || !pendingStart) return;
            console.warn(
              'SpeechRecognition InvalidStateError start never fired — recreating instance'
            );
            attempts += 1;
            dropInstance();
            attemptStart();
          }, START_WATCHDOG_MS);
          return;
        }
        console.warn('Recognition start exception:', e);
        dropInstance();
        attempts += 1;
        scheduleAttempt(
          RESTART_DELAYS[Math.min(attempts, RESTART_DELAYS.length - 1)]
        );
        return;
      }

      // Chrome sometimes neither fires onstart nor onerror (mic held by
      // another app) — without this the UI sat on "CONNECTING" forever.
      armStartWatchdog();
    };

    // ── Liveness net ────────────────────────────────────────────────────────
    // Chrome occasionally wedges a recognizer for good: it reports success
    // but never emits another event. The Web Speech API exposes no way to
    // query that, so we watch for it: while the shared mic's noise gate
    // hears activity yet the recognizer has been completely event-free for
    // EVENT_STARVATION_MS, rebuild the instance (the documented recovery).
    // A healthy recognizer always emits results/no-speech events during
    // activity, so this never fires in normal operation.
    const livenessTimer = setInterval(() => {
      if (disposed || !shouldListenRef.current) return;
      if (!isStartedRef.current) {
        // Orphaned: should be listening, but nothing is running and no
        // restart timer / pending start / watchdog exists to fix it.
        if (!restartTimerRef.current && !pendingStart && !watchdog) {
          console.warn(
            'SpeechRecognition orphaned (idle with no retry pending) — restarting'
          );
          attemptStart();
        }
        return;
      }
      if (!noiseGateActiveRef.current) return;
      if (Date.now() - lastRecEventAt < EVENT_STARVATION_MS) return;
      console.warn(
        'SpeechRecognition silent while voice present — recycling instance'
      );
      dropInstance();
      attemptStart();
    }, LIVENESS_CHECK_MS);

    startRecognitionRef.current = attemptStart;
    stopRecognitionRef.current = () => {
      attempts = 0;
      clearWatchdog();
      pendingStart = false;
      isStartedRef.current = false;
      setSpeechError(null);
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {
          /* noop */
        }
      }
    };
    abortRecognitionRef.current = () => {
      attempts = 0;
      clearWatchdog();
      pendingStart = false;
      isStartedRef.current = false;
      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {
          /* noop */
        }
      }
    };

    return () => {
      disposed = true;
      clearWatchdog();
      clearInterval(livenessTimer);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
      if (streamFlushTimerRef.current)
        clearTimeout(streamFlushTimerRef.current);
      if (abortControllerRef.current) {
        try {
          abortControllerRef.current.abort();
        } catch (e) {
          /* noop */
        }
      }
      if (ttsSessionRef.current) {
        ttsSessionRef.current.cancel();
        ttsSessionRef.current = null;
      }
      try {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      } catch (e) {
        /* noop */
      }
      dropInstance();
      startRecognitionRef.current = null;
      stopRecognitionRef.current = null;
      abortRecognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // created once; failures recreate the instance internally

  // Synchronize mic listening state
  useEffect(() => {
    if (isListening) {
      safeStartRecognition();
    } else {
      safeStopRecognition();
      setCurrentTranscript('');
    }
  }, [isListening, safeStartRecognition, safeStopRecognition]);

  // ── Noise gate ─────────────────────────────────────────────────────────────
  // The noise-gate indicator is fed by VoicePlasma's single microphone stream
  // (App passes `noiseGateActive`). CommandTerminal no longer opens a second
  // mic — two concurrent getUserMedia streams were starving the recognizer.

  // Handle instant language change
  const handleSelectLanguage = (langCode) => {
    if (langCode === selectedLanguage) return;

    const targetLang = SUPPORTED_LANGUAGES.find((l) => l.code === langCode);
    if (onLanguageChange) {
      onLanguageChange(langCode);
    }

    setCommandLogs((prev) => [
      ...prev,
      {
        id: Date.now(),
        text: `Voice Language set to: ${targetLang ? targetLang.flag : '🌐'} ${
          targetLang ? targetLang.label : langCode
        } (${targetLang ? targetLang.native : ''}) [${langCode}]`,
        sender: 'SYSTEM',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      },
    ]);

    if (shouldListenRef.current && recognitionRef.current) {
      safeAbortRecognition();
      setTimeout(() => {
        if (shouldListenRef.current) {
          safeStartRecognition();
        }
      }, 180);
    }
  };

  // Handle model change
  const handleModelChange = (e) => {
    const newModel = e.target.value;
    if (onGroqModelChange) {
      onGroqModelChange(newModel);
    }
    const modelMeta = GROQ_MODELS.find((m) => m.id === newModel);
    setCommandLogs((prev) => [
      ...prev,
      {
        id: Date.now(),
        text: `Groq Model Switched: ${modelMeta ? modelMeta.label : newModel}`,
        sender: 'SYSTEM',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      },
    ]);
  };

  // Keyboard text prompt submission
  const handleManualSubmit = (e) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    const text = manualInput.trim();
    setManualInput('');
    handleProcessUserPrompt(text);
  };

  const handleClearLogs = (e) => {
    e.stopPropagation();
    setCommandLogs([
      {
        id: Date.now(),
        text: 'Command terminal logs cleared. Groq LPU standing by.',
        sender: 'SYSTEM',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      },
    ]);
    setCurrentTranscript('');
  };

  const currentLangObj =
    SUPPORTED_LANGUAGES.find((l) => l.code === selectedLanguage) ||
    SUPPORTED_LANGUAGES[0];

  const currentModelMeta =
    GROQ_MODELS.find((m) => m.id === groqModel) || GROQ_MODELS[0];

  return (
    <div className="terminal-wrapper">
      {/* Mini Top Slide Handle Tab when minimized */}
      {!isOpen && (
        <div
          className="terminal-slide-handle"
          style={{ borderColor: `${blobConfig.color}66` }}
          onClick={() => setIsOpen(true)}
          title="Click to open Command Terminal"
        >
          <div className="handle-content">
            <span
              className="handle-pulse-dot"
              style={{ backgroundColor: blobConfig.color }}
            ></span>
            <span className="handle-text">TERMINAL CONSOLE</span>
            <span className="handle-lang-pill">
              {currentLangObj.flag} {currentLangObj.native}
            </span>
            <span className="handle-groq-badge">⚡ GROQ LPU</span>
            <span className="handle-arrow">▼</span>
          </div>
        </div>
      )}

      {/* Center Holographic Console */}
      <div
        className={`holographic-console ${isOpen ? 'slide-down' : 'slide-up'}`}
        style={{
          borderColor: `${blobConfig.color}55`,
          boxShadow: isOpen
            ? `0 20px 50px rgba(0, 0, 0, 0.9), 0 0 30px ${blobConfig.color}25, inset 0 1px 1px rgba(255, 255, 255, 0.25)`
            : 'none',
        }}
      >
        {/* Top Header Bar */}
        <div
          className="console-header"
          style={{ borderBottomColor: `${blobConfig.color}33` }}
        >
          <div className="console-title-group">
            <span
              className="console-indicator"
              style={{
                backgroundColor:
                  isListening && speechError
                    ? '#ef4444'            // red = sensor fault (visible, not hidden)
                    : isListening
                    ? noiseGateActive
                      ? '#22c55e'          // green = voice above threshold
                      : recognitionActive
                      ? blobConfig.color   // accent = listening/quiet
                      : '#eab308'          // yellow = connecting
                    : isGenerating
                    ? '#a855f7'
                    : '#557788',
                boxShadow:
                  isListening && speechError
                    ? '0 0 10px #ef4444'
                    : (isListening && (recognitionActive || noiseGateActive)) ||
                      isGenerating
                    ? `0 0 10px ${noiseGateActive ? '#22c55e' : blobConfig.color}`
                    : 'none',
                transition: 'background-color 0.15s ease',
              }}
            ></span>
            <span className="console-title" style={{ color: blobConfig.color }}>
              COMMAND TERMINAL // GROQ LPU CORE
            </span>
            <span
              className={`console-status-tag ${
                isGenerating ? 'generating' : ''
              }`}
            >
              {isListening && speechError
                ? '⚠ SENSOR FAULT'
                : isGenerating
                ? 'STREAMING LPU'
                : isListening
                ? noiseGateActive
                  ? '🎙️ VOICE ACTIVE'
                  : recognitionActive
                  ? 'REC ACTIVE'
                  : 'CONNECTING'
                : 'STANDBY'}
            </span>
          </div>

          <div className="console-actions">
            {/* Groq Model Selector */}
            <div className="model-selector-wrap" title="Active Groq LLM Model">
              <span className="model-icon">⚡</span>
              <select
                className="groq-model-select"
                value={groqModel}
                onChange={handleModelChange}
                style={{
                  borderColor: `${blobConfig.color}44`,
                  color: blobConfig.color,
                }}
              >
                {GROQ_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Quick Voice Output (TTS) Toggle */}
            <button
              className={`console-btn voice-tts-btn ${
                voiceFeedbackEnabled ? 'active-voice' : ''
              }`}
              onClick={() => setVoiceFeedbackEnabled(!voiceFeedbackEnabled)}
              title={
                voiceFeedbackEnabled
                  ? 'Voice response is enabled (Click to mute)'
                  : 'Voice response muted (Click to enable)'
              }
            >
              {voiceFeedbackEnabled ? '🔊 VOICE ON' : '🔈 MUTE'}
            </button>

            <button
              className={`console-btn ${isPinned ? 'active-pin' : ''}`}
              onClick={() => setIsPinned(!isPinned)}
              title={isPinned ? 'Unpin auto-minimize' : 'Pin console open'}
            >
              {isPinned ? '📌 PINNED' : '📍 PIN'}
            </button>
            <button
              className="console-btn"
              onClick={handleClearLogs}
              title="Clear terminal history"
            >
              CLEAR
            </button>
            <button
              className="console-btn close-btn"
              onClick={() => setIsOpen(false)}
              title="Slide console up"
            >
              ▲ SLIDE UP
            </button>
          </div>
        </div>

        {/* Noise Gate / VAD Status Bar — visible when mic is active */}
        {isListening && (
          <div
            className="vad-status-bar"
            style={{
              borderBottomColor: `${blobConfig.color}22`,
              background: noiseGateActive
                ? 'linear-gradient(90deg, rgba(34,197,94,0.1), transparent)'
                : 'transparent',
              transition: 'background 0.25s ease',
            }}
          >
            <span className="vad-label">🎚️ NOISE GATE:</span>
            <span className={`vad-indicator ${noiseGateActive ? 'vad-active' : 'vad-quiet'}`}>
              {noiseGateActive ? '▮▮▮▮▮ VOICE DETECTED' : '▁▁▁▁▁ QUIET / BACKGROUND'}
            </span>
            <span className="vad-hint">Focus: Human voice 85Hz–4kHz</span>
          </div>
        )}

        {/* Real-time Multi-Language Quick Bar */}
        <div
          className="console-language-bar"
          style={{ borderBottomColor: `${blobConfig.color}22` }}
        >
          <div className="lang-bar-label">
            <span className="lang-icon">🌐</span>
            <span>VOICE LANG:</span>
          </div>

          {/* Priority Quick Switch Pills */}
          <div className="lang-pills-row">
            {SUPPORTED_LANGUAGES.filter((l) => l.isPriority).map((lang) => (
              <button
                key={lang.code}
                className={`lang-pill-btn ${
                  selectedLanguage === lang.code ? 'active' : ''
                }`}
                style={{
                  borderColor:
                    selectedLanguage === lang.code
                      ? blobConfig.color
                      : 'rgba(255, 255, 255, 0.15)',
                  boxShadow:
                    selectedLanguage === lang.code
                      ? `0 0 10px ${blobConfig.color}55`
                      : 'none',
                }}
                onClick={() => handleSelectLanguage(lang.code)}
                title={`Switch speech recognition to ${lang.label}`}
              >
                <span className="lang-flag">{lang.flag}</span>
                <span className="lang-pill-text">{lang.native}</span>
              </button>
            ))}

            {/* Dropdown for other international & regional languages */}
            <div className="lang-select-wrapper">
              <select
                className="lang-more-dropdown"
                value={
                  SUPPORTED_LANGUAGES.filter((l) => !l.isPriority).some(
                    (l) => l.code === selectedLanguage
                  )
                    ? selectedLanguage
                    : ''
                }
                onChange={(e) => {
                  if (e.target.value) handleSelectLanguage(e.target.value);
                }}
                style={{
                  borderColor: `${blobConfig.color}44`,
                  color: blobConfig.color,
                }}
              >
                <option value="" disabled>
                  + More Languages...
                </option>
                {SUPPORTED_LANGUAGES.filter((l) => !l.isPriority).map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.flag} {lang.label} ({lang.native})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="lang-active-status">
            <span className="active-tag" style={{ color: blobConfig.color }}>
              ACTIVE MODEL: {currentModelMeta.label.split('(')[0].trim()}
            </span>
          </div>
        </div>

        {/* Terminal Body Logs Feed */}
        <div className="console-body" ref={terminalBodyRef}>
          {commandLogs.map((log) => (
            <div
              key={log.id}
              className={`log-entry log-${log.sender.toLowerCase()} ${
                log.isError ? 'log-error' : ''
              }`}
            >
              <span className="log-time">[{log.timestamp}]</span>
              <span
                className="log-sender"
                style={{
                  color:
                    log.sender === 'VOICE_USER' ? '#ffffff' : blobConfig.color,
                }}
              >
                {log.sender === 'VOICE_USER'
                  ? 'USER_VOICE >'
                  : log.sender === 'JARVIS'
                  ? 'JARVIS >'
                  : 'SYS >'}
              </span>

              {log.langBadge && (
                <span
                  className="log-lang-badge"
                  style={{
                    borderColor: `${blobConfig.color}66`,
                    color: blobConfig.color,
                  }}
                >
                  {log.langBadge}
                </span>
              )}

              {log.modelBadge && (
                <span className="log-model-badge">{log.modelBadge}</span>
              )}

              <span
                className={`log-message ${
                  /[\u0900-\u097F]/.test(log.text) ? 'hindi-text' : ''
                }`}
              >
                {log.sender === 'VOICE_USER' ? `"${log.text}"` : log.text}
                {log.isStreaming && (
                  <span
                    className="streaming-cursor"
                    style={{ backgroundColor: blobConfig.color }}
                  />
                )}
              </span>
            </div>
          ))}

          {/* Real-time Live Speech Prompt (Typing live as you speak) */}
          {currentTranscript && (
            <div className="live-speech-stream">
              <span className="stream-prompt" style={{ color: blobConfig.color }}>
                🎙️ {currentLangObj.flag} SPEAKING &gt;
              </span>
              <span
                className={`stream-text ${
                  /[\u0900-\u097F]/.test(currentTranscript) ? 'hindi-text' : ''
                }`}
              >
                "{currentTranscript}"
              </span>
              <span
                className="cursor-blink"
                style={{ backgroundColor: blobConfig.color }}
              ></span>
            </div>
          )}
        </div>

        {/* Manual Keyboard Prompt Input */}
        <form onSubmit={handleManualSubmit} className="terminal-manual-row">
          <span className="input-chevron" style={{ color: blobConfig.color }}>
            &gt;
          </span>
          <input
            type="text"
            className="terminal-input-field"
            placeholder={
              isListening
                ? 'Speak into microphone or type a command here...'
                : 'Type a command here or click Activate Mic below...'
            }
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
          />
          <button
            type="submit"
            className="manual-submit-btn"
            style={{
              borderColor: blobConfig.color,
              color: blobConfig.color,
            }}
            disabled={!manualInput.trim()}
          >
            {isGenerating ? 'STREAMING...' : 'TRANSMIT'}
          </button>
        </form>

        {/* Bottom Status / Quick Input Bar */}
        <div
          className="console-footer"
          style={{ borderTopColor: `${blobConfig.color}22` }}
        >
          <div className="footer-info">
            <span className="hud-label">VOICE SENSOR:</span>
            <span className="hud-val" style={{ color: blobConfig.color }}>
              {isListening
                ? `REAL-TIME STREAMING // ${currentLangObj.label.toUpperCase()} (${currentLangObj.code})`
                : 'STANDBY (CLICK TO ENGAGE)'}
            </span>
            <span className="hud-lpu-badge">⚡ GROQ LPU ULTRA-FAST</span>
            <span
              className={`hud-bridge-badge ${
                bridgeOnline ? 'bridge-on' : 'bridge-off'
              }`}
              title={
                bridgeOnline
                  ? 'Desktop Bridge online — apps, files and folders open on this PC.'
                  : 'Desktop Bridge offline — run: npm run bridge  (or double-click bridge\\bridge-start.bat). Links still open in a new tab.'
              }
            >
              {bridgeOnline ? '🖥️ BRIDGE ONLINE' : '🖥️ BRIDGE OFFLINE'}
            </span>
          </div>

          {!isListening && (
            <button
              className="engage-mic-quick-btn"
              style={{
                borderColor: blobConfig.color,
                color: blobConfig.color,
              }}
              onClick={onToggleListening}
            >
              🎙️ ACTIVATE MIC
            </button>
          )}
        </div>

        {speechError && (
          <div className="console-error-banner">{speechError}</div>
        )}
      </div>
    </div>
  );
};

export default CommandTerminal;

import React, { useState, useCallback, useEffect } from 'react';
import './App.css';
import Navbar from './components/Navbar';
import VoicePlasma from './components/VoicePlasma';
import CommandTerminal from './components/CommandTerminal';
import DigitalClock from './components/DigitalClock';
import ScreenVision from './components/ScreenVision';
import SystemControls from './components/SystemControls';
import MusicPlayer from './components/MusicPlayer';
import Dashboard from './components/Dashboard';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './constants/languages';
import { getStoredModel } from './services/groqService';

// ── Routing (zero dependencies, real URLs) ──────────────────────────────────
// The existing Jarvis interface IS the home page: '/', '/home' and any
// unknown path render it. '/dashboard' and '/about' render placeholder
// pages. Navigation uses pushState so refresh and back/forward work.
const ROUTES = { HOME: '/home', DASHBOARD: '/dashboard', ABOUT: '/about' };

const pageFromPath = (path) => {
  const p = String(path || '/').replace(/\/+$/, '').toLowerCase();
  if (p === ROUTES.DASHBOARD) return 'DASHBOARD';
  if (p === ROUTES.ABOUT) return 'ABOUT';
  return 'HOME';
};

function App() {
  const [isListening, setIsListening] = useState(false);

  // Voice presence reported by VoicePlasma (single mic pipeline) — drives the
  // console's NOISE GATE indicator without opening a second microphone stream.
  const [voiceActive, setVoiceActive] = useState(false);

  const handleVoiceActivity = useCallback((active) => {
    setVoiceActive(active);
  }, []);

  const [selectedLanguage, setSelectedLanguage] = useState(() => {
    const saved = localStorage.getItem('jarvis_voice_lang');
    if (saved && SUPPORTED_LANGUAGES.some((l) => l.code === saved)) {
      return saved;
    }
    return DEFAULT_LANGUAGE;
  });

  const [groqModel, setGroqModel] = useState(() => getStoredModel());

  // The Groq API key now lives in the local .env file and is used by the
  // desktop bridge only. Clear the copy older versions left in this browser.
  useEffect(() => {
    localStorage.removeItem('jarvis_groq_api_key');
  }, []);

  const [blobConfig, setBlobConfig] = useState(() => {
    const saved = localStorage.getItem('jarvis_blob_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved blob config', e);
      }
    }
    return {
      color: '#00f0ff', // Default Arc Cyan
      size: 1.0, // Scale 0.7x to 1.5x
      sensitivity: 3.5, // 1.0x to 8.0x
      smoothness: 0.18, // Damping factor (lower = smoother liquid, higher = faster)
    };
  });

  const updateBlobConfig = (updates) => {
    setBlobConfig((prev) => {
      const next = { ...prev, ...updates };
      localStorage.setItem('jarvis_blob_config', JSON.stringify(next));
      return next;
    });
  };

  const updateLanguage = (newLang) => {
    setSelectedLanguage(newLang);
    localStorage.setItem('jarvis_voice_lang', newLang);
  };

  const updateGroqModel = (model) => {
    setGroqModel(model);
    localStorage.setItem('jarvis_groq_model', model);
  };

  const handleToggleListening = () => {
    setIsListening((prev) => !prev);
  };

  // ── Current page state ──────────────────────────────────────────────────
  const [page, setPage] = useState(() => pageFromPath(window.location.pathname));

  useEffect(() => {
    // Back/forward buttons and hard refreshes stay in sync with the URL.
    const onPopState = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    // Application start always lands on HOME: normalize '/' (and any other
    // unknown startup path) to '/home' without reloading the page.
    if (
      pageFromPath(window.location.pathname) === 'HOME' &&
      window.location.pathname !== ROUTES.HOME
    ) {
      window.history.replaceState(window.history.state, '', ROUTES.HOME);
    }
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((id) => {
    // SETTINGS is not a page — it stays the existing dropdown panel in the
    // Navbar, untouched. HOME / DASHBOARD / ABOUT are real routes.
    if (id === 'SETTINGS') return;
    const path = ROUTES[id] || ROUTES.HOME;
    if (window.location.pathname !== path) {
      window.history.pushState({ page: id }, '', path);
    }
    setPage(id in ROUTES ? id : 'HOME');
  }, []);

  return (
    <div className="App">
      <Navbar
        blobConfig={blobConfig}
        updateBlobConfig={updateBlobConfig}
        selectedLanguage={selectedLanguage}
        onLanguageChange={updateLanguage}
        groqModel={groqModel}
        onGroqModelChange={updateGroqModel}
        activePage={page}
        onNavigate={navigate}
      />

      {/* Routes — Dashboard is the real monitoring page; About stays a
          placeholder. The Jarvis interface below stays mounted (hidden on
          these routes) exactly as before, so voice/history survive. */}
      {page === 'DASHBOARD' && <Dashboard />}
      {page === 'ABOUT' && (
        <section className="route-placeholder" aria-label="ABOUT page">
          <span className="route-placeholder-title">ABOUT</span>
          <p className="route-placeholder-note">
            About J.A.R.V.I.S. will appear here.
          </p>
        </section>
      )}

      {/* The entire existing Jarvis interface, byte-for-byte unchanged.
          display:contents makes the wrapper boxless (layout identical to
          before), and hiding it with display:none on other routes keeps
          every component MOUNTED — voice, conversation history and all
          state survive navigation away and back. */}
      <div
        className="home-view"
        style={{ display: page === 'HOME' ? 'contents' : 'none' }}
      >
        <DigitalClock />
        <ScreenVision />
        {/* Top-right column: the existing Volume/Brightness panel with the
            Music Player directly below it — same glass panel language. */}
        <div className="corner-stack">
          <SystemControls />
          <MusicPlayer />
        </div>
        <CommandTerminal
          blobConfig={blobConfig}
          isListening={isListening}
          onToggleListening={handleToggleListening}
          selectedLanguage={selectedLanguage}
          onLanguageChange={updateLanguage}
          groqModel={groqModel}
          onGroqModelChange={updateGroqModel}
          noiseGateActive={voiceActive}
        />
        <VoicePlasma
          blobConfig={blobConfig}
          isListening={isListening}
          onToggleListening={handleToggleListening}
          onVoiceActivity={handleVoiceActivity}
        />
      </div>
    </div>
  );
}

export default App;

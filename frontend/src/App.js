import React, { useState, useCallback, useEffect } from 'react';
import './App.css';
import Navbar from './components/Navbar';
import VoicePlasma from './components/VoicePlasma';
import CommandTerminal from './components/CommandTerminal';
import DigitalClock from './components/DigitalClock';
import ScreenVision from './components/ScreenVision';
import SystemControls from './components/SystemControls';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './constants/languages';
import { getStoredModel } from './services/groqService';

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

  return (
    <div className="App">
      <Navbar
        blobConfig={blobConfig}
        updateBlobConfig={updateBlobConfig}
        selectedLanguage={selectedLanguage}
        onLanguageChange={updateLanguage}
        groqModel={groqModel}
        onGroqModelChange={updateGroqModel}
      />
      <DigitalClock />
      <ScreenVision />
      <SystemControls />
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
  );
}

export default App;

import React, { useState, useRef, useEffect } from 'react';
import './Navbar.css';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../constants/languages';
import { GROQ_MODELS } from '../services/groqService';

const Navbar = ({
  blobConfig,
  updateBlobConfig,
  selectedLanguage = DEFAULT_LANGUAGE,
  onLanguageChange,
  groqModel = 'qwen/qwen3.8-27b',
  onGroqModelChange,
}) => {
  const [activeItem, setActiveItem] = useState('HOME');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blobSectionOpen, setBlobSectionOpen] = useState(false);
  const [languageSectionOpen, setLanguageSectionOpen] = useState(false);
  const [groqSectionOpen, setGroqSectionOpen] = useState(true);

  const settingsRef = useRef(null);

  const navItems = [
    { id: 'HOME', label: 'HOME' },
    { id: 'DASHBOARD', label: 'DASHBOARD' },
    { id: 'SETTINGS', label: 'SETTINGS' },
    { id: 'ABOUT', label: 'ABOUT' },
  ];

  const colorPresets = [
    { label: 'Arc Cyan', value: '#00f0ff' },
    { label: 'Plasma Blue', value: '#3b82f6' },
    { label: 'Emerald', value: '#10b981' },
    { label: 'Arc Purple', value: '#a855f7' },
    { label: 'Crimson', value: '#ef4444' },
    { label: 'Solar Amber', value: '#f59e0b' },
  ];

  const currentLangObj =
    SUPPORTED_LANGUAGES.find((l) => l.code === selectedLanguage) ||
    SUPPORTED_LANGUAGES[0];

  const currentModelObj =
    GROQ_MODELS.find((m) => m.id === groqModel) || GROQ_MODELS[0];

  // Close settings when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setSettingsOpen(false);
      }
    };
    if (settingsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [settingsOpen]);

  const handleNavClick = (id) => {
    setActiveItem(id);
    if (id === 'SETTINGS') {
      setSettingsOpen((prev) => !prev);
    } else {
      setSettingsOpen(false);
    }
    setMobileMenuOpen(false);
  };

  return (
    <nav className="navbar-container">
      <div className="liquid-glass-navbar">
        {/* Ambient liquid glow & reflection */}
        <div className="liquid-glow-layer"></div>
        <div className="glass-reflection-line"></div>

        {/* Brand Header */}
        <div className="navbar-brand">
          <span className="brand-text">J.A.R.V.I.S.</span>
          <span className="brand-dot"></span>
        </div>

        {/* Desktop Links */}
        <ul className="navbar-links">
          {navItems.map((item) => (
            <li key={item.id} className="nav-item">
              <button
                className={`nav-link-btn ${
                  activeItem === item.id ||
                  (item.id === 'SETTINGS' && settingsOpen)
                    ? 'active'
                    : ''
                }`}
                onClick={() => handleNavClick(item.id)}
              >
                <span className="nav-link-text">{item.label}</span>
                {(activeItem === item.id ||
                  (item.id === 'SETTINGS' && settingsOpen)) && (
                  <span className="active-indicator" />
                )}
              </button>
            </li>
          ))}
        </ul>

        {/* Groq Engine Badge in Navbar */}
        <div
          className="navbar-groq-pill"
          onClick={() => {
            setSettingsOpen(true);
            setGroqSectionOpen(true);
          }}
          title="Active Groq AI Model. Click to configure."
        >
          <span className="groq-bolt">⚡</span>
          <span className="groq-pill-label">
            {groqModel.includes('prompt-guard') ? 'GUARD 22M' : 'GROQ LPU'}
          </span>
        </div>

        {/* Quick Language Indicator in Navbar */}
        <button
          className="navbar-lang-pill"
          style={{
            borderColor: `${blobConfig.color}55`,
            color: blobConfig.color,
          }}
          onClick={() => {
            setSettingsOpen(true);
            setLanguageSectionOpen(true);
          }}
          title="Active voice language. Click to switch."
        >
          <span className="pill-flag">{currentLangObj.flag}</span>
          <span className="pill-text">{currentLangObj.native}</span>
        </button>

        {/* Mobile Toggle */}
        <button
          className={`mobile-menu-toggle ${mobileMenuOpen ? 'open' : ''}`}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle navigation menu"
        >
          <span className="hamburger-bar"></span>
          <span className="hamburger-bar"></span>
          <span className="hamburger-bar"></span>
        </button>
      </div>

      {/* Settings Dropdown Panel */}
      {settingsOpen && (
        <div className="liquid-settings-dropdown" ref={settingsRef}>
          <div className="settings-panel-header">
            <span className="settings-title">SYSTEM SETTINGS</span>
            <button
              className="close-panel-btn"
              onClick={() => setSettingsOpen(false)}
            >
              ✕
            </button>
          </div>

          {/* Section: GROQ LPU AI ENGINE */}
          <div className="settings-section">
            <button
              className={`section-header-btn ${groqSectionOpen ? 'open' : ''}`}
              onClick={() => setGroqSectionOpen(!groqSectionOpen)}
            >
              <div className="section-title-wrap">
                <span className="section-icon">⚡</span>
                <span className="section-name">GROQ LPU AI ENGINE</span>
              </div>
              <span className="section-arrow">
                {groqSectionOpen ? '▲' : '▼'}
              </span>
            </button>

            {groqSectionOpen && (
              <div className="blob-options-container">
                {/* Active Model Selection */}
                <div className="blob-option-group">
                  <div className="option-label-row">
                    <span className="option-title">ACTIVE AI MODEL</span>
                    <span
                      className="option-value-badge"
                      style={{ color: '#f59e0b' }}
                    >
                      {currentModelObj.label.split('(')[0].trim()}
                    </span>
                  </div>

                  <div className="groq-model-list">
                    {GROQ_MODELS.map((m) => (
                      <div
                        key={m.id}
                        className={`groq-model-item ${
                          groqModel === m.id ? 'selected' : ''
                        }`}
                        onClick={() =>
                          onGroqModelChange && onGroqModelChange(m.id)
                        }
                        style={{
                          borderColor:
                            groqModel === m.id
                              ? blobConfig.color
                              : 'rgba(255, 255, 255, 0.1)',
                          boxShadow:
                            groqModel === m.id
                              ? `0 0 10px ${blobConfig.color}44`
                              : 'none',
                        }}
                      >
                        <div className="model-radio-circle">
                          {groqModel === m.id && (
                            <span
                              className="radio-inner"
                              style={{ backgroundColor: blobConfig.color }}
                            />
                          )}
                        </div>
                        <div className="model-info">
                          <span className="model-title">{m.label}</span>
                          <span className="model-desc">{m.description}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section: VOICE & LANGUAGE ENGINE */}
          <div className="settings-section">
            <button
              className={`section-header-btn ${
                languageSectionOpen ? 'open' : ''
              }`}
              onClick={() => setLanguageSectionOpen(!languageSectionOpen)}
            >
              <div className="section-title-wrap">
                <span className="section-icon">🌐</span>
                <span className="section-name">VOICE & LANGUAGE ENGINE</span>
              </div>
              <span className="section-arrow">
                {languageSectionOpen ? '▲' : '▼'}
              </span>
            </button>

            {languageSectionOpen && (
              <div className="blob-options-container">
                <div className="blob-option-group">
                  <div className="option-label-row">
                    <span className="option-title">
                      ACTIVE RECOGNITION LANGUAGE
                    </span>
                    <span
                      className="option-value-badge"
                      style={{ color: blobConfig.color }}
                    >
                      {currentLangObj.flag} {currentLangObj.label} [
                      {currentLangObj.code}]
                    </span>
                  </div>

                  <div className="lang-settings-grid">
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        className={`lang-setting-card ${
                          selectedLanguage === lang.code ? 'selected' : ''
                        }`}
                        style={{
                          borderColor:
                            selectedLanguage === lang.code
                              ? blobConfig.color
                              : 'rgba(255, 255, 255, 0.1)',
                          boxShadow:
                            selectedLanguage === lang.code
                              ? `0 0 12px ${blobConfig.color}44`
                              : 'none',
                        }}
                        onClick={() =>
                          onLanguageChange && onLanguageChange(lang.code)
                        }
                      >
                        <span className="lang-card-flag">{lang.flag}</span>
                        <div className="lang-card-text">
                          <span className="lang-card-native">
                            {lang.native}
                          </span>
                          <span className="lang-card-label">{lang.label}</span>
                        </div>
                        {selectedLanguage === lang.code && (
                          <span
                            className="lang-card-active-dot"
                            style={{ backgroundColor: blobConfig.color }}
                          />
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="engine-status-note">
                    ⚡ Web Speech Engine: Real-time, Unlimited & 100% Free
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section: BLOB (VOICE PLASMA) */}
          <div className="settings-section">
            <button
              className={`section-header-btn ${blobSectionOpen ? 'open' : ''}`}
              onClick={() => setBlobSectionOpen(!blobSectionOpen)}
            >
              <div className="section-title-wrap">
                <span className="section-icon">🔮</span>
                <span className="section-name">BLOB (VOICE PLASMA)</span>
              </div>
              <span className="section-arrow">
                {blobSectionOpen ? '▲' : '▼'}
              </span>
            </button>

            {blobSectionOpen && (
              <div className="blob-options-container">
                {/* 1. Color of the Blob */}
                <div className="blob-option-group">
                  <div className="option-label-row">
                    <span className="option-title">1. BLOB COLOR</span>
                    <span
                      className="color-preview-chip"
                      style={{
                        backgroundColor: blobConfig.color,
                        boxShadow: `0 0 10px ${blobConfig.color}`,
                      }}
                    ></span>
                  </div>
                  <div className="color-presets-row">
                    {colorPresets.map((preset) => (
                      <button
                        key={preset.value}
                        className={`preset-color-btn ${
                          blobConfig.color === preset.value ? 'selected' : ''
                        }`}
                        style={{
                          backgroundColor: preset.value,
                          boxShadow:
                            blobConfig.color === preset.value
                              ? `0 0 12px ${preset.value}`
                              : 'none',
                        }}
                        onClick={() => updateBlobConfig({ color: preset.value })}
                        title={preset.label}
                      />
                    ))}
                    <div
                      className="custom-color-input-wrap"
                      title="Custom color"
                    >
                      <input
                        type="color"
                        value={blobConfig.color}
                        onChange={(e) =>
                          updateBlobConfig({ color: e.target.value })
                        }
                        className="custom-color-picker"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. Size of the Blob */}
                <div className="blob-option-group">
                  <div className="option-label-row">
                    <span className="option-title">2. BLOB SIZE</span>
                    <span className="option-value-badge">
                      {Math.round(blobConfig.size * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.7"
                    max="1.5"
                    step="0.05"
                    value={blobConfig.size}
                    onChange={(e) =>
                      updateBlobConfig({ size: parseFloat(e.target.value) })
                    }
                    className="liquid-slider"
                  />
                  <div className="slider-ticks">
                    <span>Compact (70%)</span>
                    <span>Standard</span>
                    <span>Expanded (150%)</span>
                  </div>
                </div>

                {/* 3. Sensitivity & Smoothness of the Blob */}
                <div className="blob-option-group">
                  <div className="option-label-row">
                    <span className="option-title">
                      3. SMOOTHNESS & SENSITIVITY
                    </span>
                  </div>

                  {/* Smoothness */}
                  <div className="sub-slider-item">
                    <div className="sub-label-row">
                      <span>PLASMA SMOOTHNESS</span>
                      <span className="sub-val">
                        {blobConfig.smoothness <= 0.12
                          ? 'Ultra Smooth'
                          : blobConfig.smoothness <= 0.22
                          ? 'Liquid Smooth'
                          : 'Dynamic'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.08"
                      max="0.32"
                      step="0.02"
                      value={blobConfig.smoothness}
                      onChange={(e) =>
                        updateBlobConfig({
                          smoothness: parseFloat(e.target.value),
                        })
                      }
                      className="liquid-slider"
                    />
                    <div className="slider-ticks">
                      <span>Silky Smooth</span>
                      <span>Balanced</span>
                      <span>Snappy</span>
                    </div>
                  </div>

                  {/* Sensitivity */}
                  <div className="sub-slider-item" style={{ marginTop: '10px' }}>
                    <div className="sub-label-row">
                      <span>VOICE GAIN / SENSITIVITY</span>
                      <span className="sub-val">
                        {blobConfig.sensitivity.toFixed(1)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1.0"
                      max="8.0"
                      step="0.5"
                      value={blobConfig.sensitivity}
                      onChange={(e) =>
                        updateBlobConfig({
                          sensitivity: parseFloat(e.target.value),
                        })
                      }
                      className="liquid-slider"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="mobile-glass-menu">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`mobile-nav-btn ${
                activeItem === item.id ? 'active' : ''
              }`}
              onClick={() => handleNavClick(item.id)}
            >
              {item.label}
            </button>
          ))}
          <div className="mobile-lang-row">
            <span className="mobile-lang-title">GROQ MODEL:</span>
            <span className="mobile-model-tag">
              ⚡ {currentModelObj.label.split('(')[0]}
            </span>
          </div>
          <div className="mobile-lang-row">
            <span className="mobile-lang-title">VOICE LANGUAGE:</span>
            <div className="mobile-lang-chips">
              {SUPPORTED_LANGUAGES.filter((l) => l.isPriority).map((lang) => (
                <button
                  key={lang.code}
                  className={`mobile-lang-chip ${
                    selectedLanguage === lang.code ? 'active' : ''
                  }`}
                  onClick={() =>
                    onLanguageChange && onLanguageChange(lang.code)
                  }
                >
                  {lang.flag} {lang.native}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;

import React, { useEffect, useRef, useState, useCallback } from 'react';
import './VoicePlasma.css';

const hexToRgb = (hex) => {
  const cleanHex = (hex || '#00f0ff').replace('#', '');
  if (cleanHex.length === 3) {
    return {
      r: parseInt(cleanHex[0] + cleanHex[0], 16),
      g: parseInt(cleanHex[1] + cleanHex[1], 16),
      b: parseInt(cleanHex[2] + cleanHex[2], 16),
    };
  }
  return {
    r: parseInt(cleanHex.substring(0, 2), 16) || 0,
    g: parseInt(cleanHex.substring(2, 4), 16) || 240,
    b: parseInt(cleanHex.substring(4, 6), 16) || 255,
  };
};

const VoicePlasma = ({
  blobConfig = { color: '#00f0ff', size: 1.0, sensitivity: 3.5, smoothness: 0.18 },
  isListening: propIsListening,
  onToggleListening,
  onVoiceActivity,
}) => {
  const canvasRef = useRef(null);
  const [isListening, setIsListening] = useState(false);
  const [micError, setMicError] = useState(null);
  const [voiceLevel, setVoiceLevel] = useState(0);

  // Voice-presence reporting — this component owns the ONLY microphone stream,
  // so the console's noise-gate HUD reads it from here instead of opening a
  // second mic (two concurrent streams starve the Web Speech recognizer).
  const onVoiceActivityRef = useRef(onVoiceActivity);
  const voiceActiveRef = useRef(false);
  const lastLoudAtRef = useRef(0);

  useEffect(() => {
    onVoiceActivityRef.current = onVoiceActivity;
  }, [onVoiceActivity]);

  // Audio refs
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const gainNodeRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const freqDataRef = useRef(null);
  const timeDataRef = useRef(null);
  const animationFrameIdRef = useRef(null);

  // Smooth audio reaction values
  const smoothedAudioRef = useRef({
    volume: 0,
    bass: 0,
  });

  // Sphere geometry data
  const particlesRef = useRef([]);
  const rotationRef = useRef({ x: 0.22, y: 0 });

  // Generate 3D spherical dots matching reference image
  const initSphereGeometry = useCallback((sizeScale = 1.0) => {
    const points = [];
    const baseRadius = 58 * sizeScale; // Scaled base radius
    const latitudeRings = 28;

    for (let i = 0; i <= latitudeRings; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / latitudeRings;
      const ringRadius = baseRadius * Math.cos(phi);
      const y = baseRadius * Math.sin(phi);

      const isPolar = Math.abs(Math.sin(phi)) > 0.82;
      let dotsInRing;

      if (isPolar) {
        dotsInRing = 20; // Concentric rings at poles
      } else {
        dotsInRing = Math.max(8, Math.round(36 * Math.cos(phi)));
      }

      for (let j = 0; j < dotsInRing; j++) {
        const theta = (2 * Math.PI * j) / dotsInRing;
        const x = ringRadius * Math.cos(theta);
        const z = ringRadius * Math.sin(theta);

        points.push({
          baseX: x,
          baseY: y,
          baseZ: z,
          ringIndex: i,
          dotIndex: j,
          phi,
          theta,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    particlesRef.current = points;
  }, []);

  // Update gain when sensitivity changes from settings
  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(
        blobConfig.sensitivity,
        audioContextRef.current.currentTime,
        0.05
      );
    }
  }, [blobConfig.sensitivity]);

  // Re-init geometry if size scale changes
  useEffect(() => {
    initSphereGeometry(blobConfig.size);
  }, [blobConfig.size, initSphereGeometry]);

  // Initialize Microphone Web Audio API
  const startListening = async () => {
    try {
      setMicError(null);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;
      analyser.smoothingTimeConstant = 0.4;

      const gainNode = audioCtx.createGain();
      gainNode.gain.value = blobConfig.sensitivity;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(gainNode);
      gainNode.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const freqData = new Uint8Array(bufferLength);
      const timeData = new Uint8Array(bufferLength);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;
      gainNodeRef.current = gainNode;
      mediaStreamRef.current = stream;
      freqDataRef.current = freqData;
      timeDataRef.current = timeData;

      setIsListening(true);
    } catch (err) {
      console.error('Microphone error:', err);
      setMicError(
        err.name === 'NotAllowedError'
          ? 'Mic blocked in browser'
          : 'Audio input unavailable'
      );
      setIsListening(false);
    }
  };

  // Stop Microphone listening
  const stopListening = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    gainNodeRef.current = null;
    freqDataRef.current = null;
    timeDataRef.current = null;
    smoothedAudioRef.current = { volume: 0, bass: 0 };
    // Make sure the console's noise-gate indicator goes dark with the mic
    if (voiceActiveRef.current) {
      voiceActiveRef.current = false;
      if (onVoiceActivityRef.current) onVoiceActivityRef.current(false);
    }
    setIsListening(false);
    setVoiceLevel(0);
  };

  // Synchronize with parent listening state if provided
  useEffect(() => {
    if (propIsListening !== undefined) {
      if (propIsListening && !isListening) {
        startListening();
      } else if (!propIsListening && isListening) {
        stopListening();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propIsListening]);

  // Toggle mic on/off
  const toggleListening = () => {
    if (onToggleListening) {
      onToggleListening();
    } else {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const baseCanvasSize = 180;
    const size = Math.round(baseCanvasSize * blobConfig.size);
    canvas.width = size;
    canvas.height = size;

    const { r, g, b } = hexToRgb(blobConfig.color);
    let lastLevelUpdate = 0;
    let lastLevelValue = -1;
    let idleFrameDrawn = false;

    const render = (time) => {
      const seconds = time * 0.001;

      let currentVol = 0;
      let currentBass = 0;

      if (
        isListening &&
        analyserRef.current &&
        freqDataRef.current &&
        timeDataRef.current
      ) {
        if (audioContextRef.current?.state === 'suspended') {
          audioContextRef.current.resume();
        }

        const analyser = analyserRef.current;
        const freq = freqDataRef.current;
        const timeDomain = timeDataRef.current;

        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(timeDomain);

        // RMS sound energy
        let sumSquares = 0;
        const tLen = timeDomain.length;
        for (let i = 0; i < tLen; i++) {
          const norm = (timeDomain[i] - 128) / 128;
          sumSquares += norm * norm;
        }
        const rms = Math.sqrt(sumSquares / tLen);
        const rmsLevel = rms * 3.6;

        // Human speech vocal band
        let vocalSum = 0;
        let bassSum = 0;
        for (let i = 2; i <= 32; i++) {
          const v = freq[i] / 255;
          vocalSum += v;
          if (i <= 8) bassSum += v;
        }

        const vocalAvg = vocalSum / 31;
        const combined = Math.max(rmsLevel, vocalAvg * 2.2);

        // NOISE GATE: Ambient noise filtered out
        const NOISE_GATE = 0.13;
        if (combined > NOISE_GATE) {
          currentVol = Math.min(1, (combined - NOISE_GATE) * 1.6);
          currentBass = (bassSum / 7) * 1.4;
        } else {
          currentVol = 0;
          currentBass = 0;
        }
      }

      // Smoothness parameter: smooth attack and decay
      const smooth = smoothedAudioRef.current;
      const smoothFactor = blobConfig.smoothness || 0.18;
      const attackSpeed = currentVol > smooth.volume ? Math.min(0.48, smoothFactor * 1.8) : smoothFactor;
      smooth.volume += (currentVol - smooth.volume) * attackSpeed;
      smooth.bass += (currentBass - smooth.bass) * attackSpeed;

      const voiceEnergy = smooth.volume > 0.015 ? smooth.volume : 0;

      // Throttled state update — this used to re-render React on every frame
      if (time - lastLevelUpdate >= 100) {
        lastLevelUpdate = time;
        const nextLevel = Math.round(voiceEnergy * 100);
        if (nextLevel !== lastLevelValue) {
          lastLevelValue = nextLevel;
          setVoiceLevel(nextLevel);
        }
      }

      // Report voice presence to the console's noise-gate HUD.
      // Hysteresis (600ms hangover) keeps the indicator from flickering.
      if (isListening && voiceEnergy > 0.1) {
        lastLoudAtRef.current = time;
      }
      const voiceActive =
        isListening && (voiceEnergy > 0.1 || time - lastLoudAtRef.current < 600);
      if (voiceActive !== voiceActiveRef.current) {
        voiceActiveRef.current = voiceActive;
        if (onVoiceActivityRef.current) onVoiceActivityRef.current(voiceActive);
      }

      // Idle optimisation: once the sphere has settled and nothing is moving,
      // skip the redraw instead of painting the same static frame at 60fps.
      const settled =
        voiceEnergy === 0 && smooth.volume < 0.002 && smooth.bass < 0.002;
      if (settled && idleFrameDrawn) {
        animationFrameIdRef.current = requestAnimationFrame(render);
        return;
      }
      idleFrameDrawn = settled;

      ctx.clearRect(0, 0, size, size);

      const cx = size / 2;
      const cy = size / 2;
      const fov = 190 * blobConfig.size;

      // Stationary when quiet, rotates ONLY on voice detected
      if (voiceEnergy > 0) {
        rotationRef.current.y += voiceEnergy * 0.038;
      }

      const rotX = rotationRef.current.x;
      const rotY = rotationRef.current.y;
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      // Central Plasma Core Glow with custom color
      const coreRadius = (22 + voiceEnergy * 35) * blobConfig.size;
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
      coreGrad.addColorStop(
        0,
        `rgba(${r}, ${g}, ${b}, ${0.1 + voiceEnergy * 0.55})`
      );
      coreGrad.addColorStop(
        0.5,
        `rgba(${Math.round(r * 0.3)}, ${Math.round(g * 0.3)}, ${Math.round(b * 0.8)}, ${0.04 + voiceEnergy * 0.3})`
      );
      coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.save();
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Transform & Project 3D Spherical Dots
      const projected = [];
      const particles = particlesRef.current;
      const pCount = particles.length;
      const currentRadius = 58 * blobConfig.size;

      for (let i = 0; i < pCount; i++) {
        const p = particles[i];

        let displacement = 0;
        if (voiceEnergy > 0) {
          const ripple =
            Math.sin(p.phi * 5 + seconds * 9) *
            Math.cos(p.theta * 4 + seconds * 7);
          displacement =
            (voiceEnergy * 30 * ripple +
            smooth.bass * 20 +
            voiceEnergy * 12 * Math.sin(p.theta * 3 + seconds * 6)) * blobConfig.size;
        }

        const scale = 1 + displacement / currentRadius;
        const px = p.baseX * scale;
        const py = p.baseY * scale;
        const pz = p.baseZ * scale;

        // 3D Rotations
        const x1 = px * cosY + pz * sinY;
        const y1 = py;
        const z1 = -px * sinY + pz * cosY;

        const x2 = x1;
        const y2 = y1 * cosX - z1 * sinX;
        const z2 = y1 * sinX + z1 * cosX;

        // Perspective Projection
        const depth = z2 + 140 * blobConfig.size;
        if (depth > 5) {
          const projScale = fov / depth;
          const screenX = cx + x2 * projScale;
          const screenY = cy + y2 * projScale;
          const depthNorm = Math.max(0, Math.min(1, (z2 + 65 * blobConfig.size) / (130 * blobConfig.size)));

          projected.push({
            x: screenX,
            y: screenY,
            z: z2,
            depthNorm,
            isPolar: Math.abs(Math.sin(p.phi)) > 0.82,
          });
        }
      }

      // Sort points back-to-front
      projected.sort((a, b) => a.z - b.z);

      // Render dots
      const projLen = projected.length;
      for (let i = 0; i < projLen; i++) {
        const dot = projected[i];

        const baseSize = (dot.isPolar ? 1.0 : 1.25) * blobConfig.size;
        const radius = Math.max(
          0.5,
          (baseSize + dot.depthNorm * 0.9 * blobConfig.size + voiceEnergy * 1.6 * blobConfig.size) *
            (dot.isPolar ? 0.9 : 1.0)
        );

        const alpha = Math.min(
          1,
          0.22 + dot.depthNorm * 0.6 + voiceEnergy * 0.45
        );

        let dotColor;
        if (voiceEnergy > 0.4 && dot.depthNorm > 0.55) {
          dotColor = `rgba(245, 255, 255, ${alpha})`;
        } else if (dot.depthNorm > 0.45 || voiceEnergy > 0.15) {
          dotColor = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        } else {
          dotColor = `rgba(${Math.round(r * 0.35 + 20)}, ${Math.round(g * 0.35 + 20)}, ${Math.round(b * 0.85 + 20)}, ${alpha * 0.85})`;
        }

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;

        // Glow only on front-facing dots — enabling shadowBlur for every dot
        // while speaking was the single most expensive canvas operation here.
        if (dot.depthNorm > 0.75 || (voiceEnergy > 0.35 && dot.depthNorm > 0.62)) {
          ctx.shadowBlur = 4 + voiceEnergy * 8;
          ctx.shadowColor = blobConfig.color;
        } else {
          ctx.shadowBlur = 0;
        }

        ctx.fill();
      }

      animationFrameIdRef.current = requestAnimationFrame(render);
    };

    animationFrameIdRef.current = requestAnimationFrame(render);

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [blobConfig.color, blobConfig.size, blobConfig.smoothness, isListening]);

  useEffect(() => {
    return () => {
      stopListening();
    };
  }, []);

  const dockDimension = Math.round(170 * blobConfig.size);
  const canvasDimension = Math.round(160 * blobConfig.size);

  return (
    <div className="corner-plasma-widget">
      {/* Dynamic Sized & Colored Hologram Sphere Dock */}
      <div
        className={`mini-plasma-dock ${isListening ? 'active' : ''} ${
          voiceLevel > 10 ? 'voice-reacting' : ''
        }`}
        style={{
          width: `${dockDimension}px`,
          height: `${dockDimension}px`,
          borderColor: isListening ? blobConfig.color : undefined,
          boxShadow: voiceLevel > 10
            ? `0 12px 35px rgba(0,0,0,0.9), 0 0 30px ${blobConfig.color}88`
            : undefined,
        }}
        onClick={toggleListening}
        title={
          isListening
            ? 'Voice core active: Click to mute'
            : 'Click to activate voice core'
        }
      >
        {/* Hologram Reticle Border */}
        <div
          className="mini-hud-reticle"
          style={{ borderColor: `${blobConfig.color}44` }}
        ></div>

        {/* 3D Plasma Sphere Canvas */}
        <canvas
          ref={canvasRef}
          className="mini-plasma-canvas"
          style={{
            width: `${canvasDimension}px`,
            height: `${canvasDimension}px`,
          }}
        />

        {/* Status Indicator Badge */}
        <div className="mini-core-badge">
          <span
            className={`core-indicator-light ${
              isListening
                ? voiceLevel > 10
                  ? 'speaking'
                  : 'listening'
                : 'idle'
            }`}
            style={{
              backgroundColor: isListening ? blobConfig.color : undefined,
              boxShadow: isListening ? `0 0 8px ${blobConfig.color}` : undefined,
            }}
          ></span>
          <span className="core-badge-text">
            {isListening
              ? voiceLevel > 10
                ? 'REACTING'
                : 'READY'
              : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* Clean Mini Mic Button */}
      <button
        className={`mini-mic-btn ${isListening ? 'listening' : ''}`}
        style={{
          color: isListening ? blobConfig.color : undefined,
          borderColor: isListening ? `${blobConfig.color}88` : undefined,
        }}
        onClick={toggleListening}
        aria-label="Toggle voice sensor"
      >
        {isListening ? '🎙️ LISTENING' : '🎙️ ACTIVATE'}
      </button>

      {micError && <div className="mini-error-pill">{micError}</div>}
    </div>
  );
};

export default VoicePlasma;

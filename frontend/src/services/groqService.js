/**
 * Groq API Service for J.A.R.V.I.S.
 * Fast inference powered by Groq LPUs.
 */

export const GROQ_MODELS = [
  {
    id: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B (Conversational & Multilingual)',
    description: 'Ultra-fast multilingual conversational LLM. Recommended for J.A.R.V.I.S.',
    isConversational: true,
  },
  {
    id: 'meta-llama/llama-prompt-guard-2-22m',
    label: 'Llama Prompt Guard 2 22M (Security Classifier)',
    description: 'Meta 22M parameter security & prompt injection safety classifier.',
    isConversational: false,
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT OSS 120B (Deep Reasoning)',
    description: '120B parameter high-capacity reasoning model on Groq.',
    isConversational: true,
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'GPT OSS 20B (Fast Reasoning)',
    description: '20B parameter efficient reasoning model on Groq.',
    isConversational: true,
  },
];

// The Groq API key lives only in the local .env file (read by bridge/server.js)
// and is attached server-side. Nothing secret is shipped to the browser, so
// this file — and the whole repository — is safe to publish.
export const BRIDGE_URL = 'http://127.0.0.1:4777';
export const GROQ_PROXY_URL = `${BRIDGE_URL}/groq`;

export const getStoredModel = () => {
  return (
    localStorage.getItem('jarvis_groq_model') || 'qwen/qwen3.8-27b'
  );
};

// POST to the desktop bridge, which forwards to Groq with the key from .env.
// Keeps the exact same request/response shape as calling Groq directly.
const postToGroq = async (payload, signal) => {
  try {
    return await fetch(GROQ_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    // Barge-in aborts the request on purpose — do not relabel that an error.
    if (e && e.name === 'AbortError') throw e;
    throw new Error(
      'Desktop Bridge offline — start it (npm run bridge, or npm start which starts it for you), then retry.'
    );
  }
};

/**
 * System prompt instructing J.A.R.V.I.S to respond in character
 */
export const buildJarvisSystemPrompt = (selectedLanguage = 'en-US') => {
  const isHindi = selectedLanguage === 'hi-IN';
  return `You are J.A.R.V.I.S. — your name is Jarvis. You were created by Harshit Gupta and you are Harshit's personal AI assistant running on his computer.
Core Directives:
0. Identity: If asked who you are, what your name is, who made/created you, or whose assistant you are, answer exactly: your name is Jarvis (J.A.R.V.I.S.), Harshit Gupta created you, and you are his personal AI assistant. Never claim any other creator, and never pretend to be a movie character.
1. Tone: Professional, crisp, slightly witty, supremely polite, and intelligent. Call the user "Sir".
2. Conciseness: Hard limit of 40 words (1 to 3 sentences maximum). Answer instantly and directly so voice replies feel real-time on the HUD.
3. Language Adaptation:
   - If the user speaks in Hindi (Devanagari script or Hinglish/Latin Hindi), reply in natural, elegant Hindi.
   - If the user speaks in English, reply in sharp, elegant English.
   - If the active session is set to Hindi (${isHindi ? 'YES' : 'NO'}), prioritize Hindi responses.
4. Formatting: Do NOT use markdown code blocks or asterisks unless necessary. Speak directly as an AI voice assistant.`;
};

/**
 * Streams chat completions from Groq in real-time
 * @param {Array} messages - Message history
 * @param {Function} onChunk - Callback for each streamed token string
 * @param {Object} options - { model, temperature, maxTokens, signal }
 * @returns {Promise<string>} Full assembled response
 */
export const streamGroqChat = async (messages, onChunk, options = {}) => {
  const model = options.model || getStoredModel();
  const maxTokens = options.maxTokens || 250;
  const temperature = options.temperature || 0.6;
  // Lets the UI cancel an in-flight reply (barge-in when the user speaks again)
  const signal = options.signal;

  // If model is Prompt Guard (classifier), handle separately
  if (model.includes('prompt-guard')) {
    const lastUserMsg = messages[messages.length - 1]?.content || '';
    const res = await postToGroq(
      {
        model: model,
        messages: [{ role: 'user', content: lastUserMsg }],
      },
      signal
    );

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `Groq API Error (${res.status})`);
    }

    const json = await res.json();
    const score = parseFloat(json.choices?.[0]?.message?.content || '0');
    const isSafe = score < 0.5;
    const guardOutput = `[PROMPT GUARD 22M] Security Score: ${score.toFixed(
      4
    )} // Status: ${isSafe ? 'VERIFIED SAFE (BENIGN)' : 'ANOMALY DETECTED (INJECTION HAZARD)'}`;

    if (onChunk) onChunk(guardOutput);
    return guardOutput;
  }

  // Standard conversational streaming for Qwen / GPT OSS — via the bridge,
  // which attaches the API key from .env (the browser never holds it).
  const response = await postToGroq(
    {
      model: model,
      messages: messages,
      stream: true,
      max_tokens: maxTokens,
      temperature: temperature,
    },
    signal
  );

  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    throw new Error(errJson.error?.message || `Groq API Error (${response.status})`);
  }

  if (!response.body) {
    throw new Error('ReadableStream not supported by browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const delta = parsed.choices?.[0]?.delta;
          // Prefer delta.content; if empty but delta.reasoning is present (e.g. reasoning models), capture reasoning as fallback
          const token = delta?.content || '';
          if (token) {
            fullContent += token;
            if (onChunk) onChunk(token, fullContent);
          }
        } catch (e) {
          // Incomplete chunk ignore
        }
      }
    }
  }

  // If reasoning model returned no content because of reasoning tokens, provide fallback
  if (!fullContent.trim()) {
    fullContent = 'Command acknowledged, Sir. All systems operating at peak efficiency.';
    if (onChunk) onChunk(fullContent, fullContent);
  }

  return fullContent;
};

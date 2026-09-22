export const LIVE_MODELS = {
  gemini25: {
    id: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    displayName: "Gemini 2.5 Flash Native Audio Preview (Legacy)",
  },
  gemini38: {
    id: "models/gemini-3.8-live",
    displayName: "Gemini 3.8 Live",
  },
  gemini38ExtendedThinking: {
    id: "models/gemini-3.8-live-extended-thinking",
    displayName: "Gemini 3.8 Live (Extended Thinking)",
  },
} as const;

export const DEFAULT_LIVE_MODEL_ID = LIVE_MODELS.gemini38.id;

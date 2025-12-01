/**
 * Project-level TypeScript types for better JSDoc and type checking while using checkJs.
 */

export type SongInfo = {
  title: string;
  artist?: string;
  videoId?: string;
  album?: string;
  duration?: number;
  source?: string;
  subtitle?: boolean;
  songId?: string;
  [key: string]: any;
};

export type LyricSyllable = {
  text: string;
  start?: number;
  end?: number;
  romanizedText?: string;
};

export type LyricLine = {
  id?: string | number;
  text: string;
  translatedText?: string;
  romanizedText?: string;
  timestamp?: number;
  syllabus?: LyricSyllable[];
  syllables?: LyricSyllable[];
  chunk?: Array<{ text: string; [key: string]: any }>;
  [key: string]: any;
};

export type LyricsData = {
  data: LyricLine[];
  metadata?: Record<string, any>;
  translationMeta?: TranslationMeta;
};

export type LyricsCacheEntry = {
  lyrics: LyricsData;
  version: number | string;
};

export type TranslationMeta = {
  action?: TranslationAction;
  provider?: string;
  targetLang?: string;
  requestedTargetLang?: string;
  sourceLang?: string | null;
  fallbackUsed?: boolean;
  skippedReason?: string | null;
  failedLines?: number[];
  generatedAt?: number;
  cached?: boolean;
  cacheSource?: string | null;
  lastServedAt?: number;
};

export type TranslationResult = {
  data: LyricsData['data'];
  meta?: TranslationMeta;
};

export type TranslationAction = 'translate' | 'romanize' | string;

export type LyricsProvider =
  | 'kpoe'
  | 'customKpoe'
  | 'lrclib'
  | 'local'
  | 'gemini'
  | 'google';

export type LyricsSettings = {
  lyricsProvider?: LyricsProvider;
  lyricsSourceOrder?: string[];
  cacheStrategy?: 'aggressive' | 'moderate' | 'none';
  customKpoeUrl?: string;
};

export type TranslationSettings = {
  translationProvider?: string;
  romanizationProvider?: string;
  overrideTranslateTarget?: boolean;
  customTranslateTarget?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiRomanizationModel?: string;
  overrideGeminiPrompt?: boolean;
  customGeminiPrompt?: string;
  overrideGeminiRomanizePrompt?: boolean;
  customGeminiRomanizePrompt?: string;
};

export type StructuredLyricsChunk = {
  text: string;
  chunkIndex?: number;
};

export type StructuredLyricsLine = {
  text: string;
  original_line_index?: number;
  chunk?: StructuredLyricsChunk[];
  [key: string]: any;
};

export type StructuredLyricsInput = StructuredLyricsLine[];

export type GeminiResponseLine = {
  text: string;
  original_line_index: number;
  chunk?: StructuredLyricsChunk[];
};

export type GeminiRomanizedResponse = {
  romanized_lyrics: GeminiResponseLine[];
};

export type BackgroundMessage = {
  type: string;
  [key: string]: any;
};

export type SendResponse = (response: any) => void;

export type LocalLyricsRecord = {
  songId: string;
  songInfo: SongInfo;
  lyrics: any;
  timestamp?: number;
};

declare global {
  const chrome: any;
  const browser: any;
}

export {};

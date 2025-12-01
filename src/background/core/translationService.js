// ==================================================================================================
// TRANSLATION SERVICE
// ==================================================================================================

import { state } from '../storage/state.js';
import { translationsDB } from '../storage/database.js';
import { SettingsManager } from '../storage/settings.js';
import { PROVIDERS } from '../constants.js';
import { Utilities } from '../utils/utilities.js';
import { LyricsService } from './lyricsService.js';
import { GoogleService } from '../services/googleService.js';
import { GeminiService } from '../gemini/geminiService.js';

/** @typedef {import('../../types').SongInfo} SongInfo */
/** @typedef {import('../../types').LyricsData} LyricsData */
/** @typedef {import('../../types').LyricsCacheEntry} LyricsCacheEntry */
/** @typedef {import('../../types').TranslationAction} TranslationAction */
/** @typedef {import('../../types').TranslationMeta} TranslationMeta */
/** @typedef {import('../../types').TranslationResult} TranslationResult */
/** @typedef {import('../../types').TranslationSettings} TranslationSettings */

export class TranslationService {
  /** @param {string | null | undefined} lang */
  static normalizeLanguageCode(lang) {
    if (!lang || typeof lang !== 'string') return '';
    return lang.trim().toLowerCase().split(/[-_]/)[0];
  }

  /** @param {LyricsData} originalLyrics */
  static async detectSourceLanguage(originalLyrics) {
    const sampleTexts = originalLyrics?.data
      ?.map(line => line.text)
      .filter(Boolean)
      .slice(0, 5);

    if (!sampleTexts?.length) return null;

    try {
      const joined = sampleTexts.join('\n');
      const detectUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(joined)}`;
      const response = await fetch(detectUrl);
      if (!response.ok) return null;

      const data = await response.json();
      const detectedLang = data?.[2];

      return typeof detectedLang === 'string' ? detectedLang.toLowerCase() : null;
    } catch (error) {
      console.warn("TranslationService: Language detection failed, proceeding without optimization", error);
      return null;
    }
  }

  /**
   * Annotate cached translation metadata before returning it.
   * @param {LyricsData} translatedLyrics
   * @param {'memory' | 'db'} cacheSource
   * @returns {LyricsData}
   */
  static annotateCacheHit(translatedLyrics, cacheSource) {
    if (!translatedLyrics.translationMeta) {
      translatedLyrics.translationMeta = {};
    }
    translatedLyrics.translationMeta.cached = true;
    translatedLyrics.translationMeta.cacheSource = cacheSource;
    translatedLyrics.translationMeta.lastServedAt = Date.now();
    return translatedLyrics;
  }

  /**
   * @param {SongInfo} songInfo
   * @param {TranslationAction} action
   * @param {string} targetLang
   */
  static createCacheKey(songInfo, action, targetLang) {
    const baseLyricsCacheKey = LyricsService.createCacheKey(songInfo);
    return `${baseLyricsCacheKey} - ${action} - ${targetLang}`;
  }

  /**
   * @param {SongInfo} songInfo
   * @param {TranslationAction} action
   * @param {string} targetLang
   * @param {boolean} [forceReload=false]
   * @returns {Promise<LyricsData>}
   */
  static async getOrFetch(songInfo, action, targetLang, forceReload = false) {
    const translatedKey = this.createCacheKey(songInfo, action, targetLang);
    
    const { lyrics: originalLyrics, version: originalVersion } = 
      await LyricsService.getOrFetch(songInfo, forceReload);
    
    if (Utilities.isEmptyLyrics(originalLyrics)) {
      throw new Error('Original lyrics not found or empty');
    }

    if (!forceReload) {
      const cached = await this.getCached(translatedKey, originalVersion);
      if (cached) return cached;
    }

    if (!forceReload && state.hasOngoingFetch(translatedKey)) {
      return state.getOngoingFetch(translatedKey);
    }

    const translationPromise = this.performAndCacheTranslation(
      translatedKey,
      originalLyrics,
      originalVersion,
      action,
      targetLang
    );

    state.setOngoingFetch(translatedKey, translationPromise);
    
    try {
      return await translationPromise;
    } finally {
      state.deleteOngoingFetch(translatedKey);
    }
  }

  /**
   * @param {string} translatedKey
   * @param {LyricsData} originalLyrics
   * @param {number | string} originalVersion
   * @param {TranslationAction} action
   * @param {string} targetLang
   */
  static async performAndCacheTranslation(translatedKey, originalLyrics, originalVersion, action, targetLang) {
    const settings = await SettingsManager.getTranslationSettings();
    const resolvedTargetLang = settings.overrideTranslateTarget && settings.customTranslateTarget
      ? settings.customTranslateTarget
      : targetLang;

    const translationResult = await this.performTranslation(
      originalLyrics,
      action,
      resolvedTargetLang,
      settings
    );

    const meta = translationResult.meta || {};

    const finalTranslatedLyrics = {
      ...originalLyrics,
      data: translationResult.data || originalLyrics.data,
      translationMeta: {
        action,
        provider: meta.provider || 'unknown',
        targetLang: this.normalizeLanguageCode(resolvedTargetLang) || resolvedTargetLang,
        requestedTargetLang: targetLang,
        sourceLang: meta.sourceLang || 'auto',
        fallbackUsed: meta.fallbackUsed || false,
        skippedReason: meta.skippedReason || null,
        failedLines: meta.failedLines || [],
        generatedAt: Date.now()
      }
    };

    state.setCached(translatedKey, {
      translatedLyrics: finalTranslatedLyrics,
      originalVersion
    });
    
    await translationsDB.set({
      key: translatedKey,
      translatedLyrics: finalTranslatedLyrics,
      originalVersion
    });

    return finalTranslatedLyrics;
  }

  /**
   * @param {string} key
   * @param {number | string} originalVersion
   */
  static async getCached(key, originalVersion) {
    // Check memory
    if (state.hasCached(key)) {
      const cached = state.getCached(key);
      if (cached.originalVersion === originalVersion) {
        return this.annotateCacheHit(cached.translatedLyrics, 'memory');
      }
    }

    const dbCached = await translationsDB.get(key);
    if (dbCached) {
      if (dbCached.originalVersion === originalVersion) {
        state.setCached(key, {
          translatedLyrics: dbCached.translatedLyrics,
          originalVersion: dbCached.originalVersion
        });
        return this.annotateCacheHit(dbCached.translatedLyrics, 'db');
      } else {
        await translationsDB.delete(key);
      }
    }

    return null;
  }

  /**
   * @param {LyricsData} originalLyrics
   * @param {TranslationAction} action
   * @param {string} targetLang
   * @param {TranslationSettings} settings
   * @returns {Promise<TranslationResult>}
   */
  static async performTranslation(originalLyrics, action, targetLang, settings) {
    if (action === 'translate') {
      return this.translate(originalLyrics, targetLang, settings);
    } else if (action === 'romanize') {
      return this.romanize(originalLyrics, settings);
    }
    
    return {
      data: originalLyrics.data,
      meta: {
        provider: 'passthrough',
        sourceLang: null,
        failedLines: []
      }
    };
  }

  /**
   * @param {LyricsData} originalLyrics
   * @param {string} targetLang
   * @param {TranslationSettings} settings
   * @returns {Promise<TranslationResult>}
   */
  static async translate(originalLyrics, targetLang, settings) {
    const useGemini = settings.translationProvider === PROVIDERS.GEMINI && settings.geminiApiKey;
    const sourceLang = await this.detectSourceLanguage(originalLyrics);
    const normalizedTarget = this.normalizeLanguageCode(targetLang);

    /** @type {TranslationMeta} */
    const meta = {
      provider: useGemini ? PROVIDERS.GEMINI : PROVIDERS.GOOGLE,
      sourceLang: sourceLang || 'auto',
      fallbackUsed: false,
      skippedReason: null,
      failedLines: []
    };

    if (sourceLang && normalizedTarget && sourceLang === normalizedTarget) {
      meta.provider = 'pass-through';
      meta.skippedReason = 'source-matches-target';

      return {
        data: originalLyrics.data.map(line => ({ ...line, translatedText: line.text })),
        meta
      };
    }
    
    if (useGemini) {
      try {
        const textsToTranslate = originalLyrics.data.map(line => line.text);
        const translatedTexts = await GeminiService.translate(textsToTranslate, targetLang, settings);
        return {
          data: this.mergeTranslatedTexts(originalLyrics, translatedTexts),
          meta
        };
      } catch (error) {
        console.warn("Gemini translation failed, falling back to Google:", error);
        meta.fallbackUsed = true;
        meta.provider = PROVIDERS.GOOGLE;
      }
    }
    
    const googleResult = await this.translateWithGoogle(originalLyrics, targetLang);
    meta.failedLines = googleResult.failedIndices;

    return {
      data: googleResult.data,
      meta
    };
  }

  /**
   * @param {LyricsData} originalLyrics
   * @param {string} targetLang
   */
  static async translateWithGoogle(originalLyrics, targetLang) {
    const texts = originalLyrics.data.map(line => line.text);
    const translatedTexts = new Array(texts.length);
    const workerCount = Math.min(5, Math.max(1, texts.length));
    let nextIndex = 0;
    const failedIndices = new Set();

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= texts.length) break;
        try {
          translatedTexts[currentIndex] = await GoogleService.translate(texts[currentIndex], targetLang);
        } catch (error) {
          console.warn("Google translation failed, falling back to original text:", error);
          failedIndices.add(currentIndex);
          translatedTexts[currentIndex] = texts[currentIndex];
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    return {
      data: this.mergeTranslatedTexts(originalLyrics, translatedTexts),
      failedIndices: Array.from(failedIndices)
    };
  }

  /**
   * @param {LyricsData} originalLyrics
   * @param {TranslationSettings} settings
   * @returns {Promise<TranslationResult>}
   */
  static async romanize(originalLyrics, settings) {
    // Check for prebuilt romanization
    const hasPrebuilt = originalLyrics.data.some(line =>
      line.romanizedText || (line.syllabus && line.syllabus.some(syl => syl.romanizedText))
    );

    /** @type {TranslationMeta} */
    const meta = {
      provider: settings.romanizationProvider === PROVIDERS.GEMINI && settings.geminiApiKey
        ? PROVIDERS.GEMINI
        : PROVIDERS.GOOGLE,
      sourceLang: null,
      fallbackUsed: false,
      skippedReason: null,
      failedLines: []
    };

    if (hasPrebuilt) {
      console.log("Using prebuilt romanization");
      meta.provider = 'prebuilt';
      meta.skippedReason = 'prebuilt-romanization';
      return { data: originalLyrics.data, meta };
    }

    const useGemini = settings.romanizationProvider === PROVIDERS.GEMINI && settings.geminiApiKey;

    if (useGemini) {
      const data = await GeminiService.romanize(originalLyrics, settings);
      return { data, meta };
    }

    // Try Google first, fallback to Gemini if available and Google appears to have failed
    const googleResult = await GoogleService.romanize(originalLyrics);

    // Check if Google actually succeeded (results should differ from input for non-Latin scripts)
    const allResultsSameAsInput = originalLyrics.data.every((line, index) => {
      const resultLine = googleResult[index];
      if (!resultLine) return true;

      // For line-by-line: check if romanizedText is same as text
      if (resultLine.romanizedText && resultLine.romanizedText.trim() === line.text.trim()) {
        return true;
      }

      // For word-by-word: check if all syllables have same romanizedText as text
      if (resultLine.syllabus && line.syllabus) {
        return resultLine.syllabus.every((syl, sylIndex) => {
          const originalSyl = line.syllabus[sylIndex];
          return !originalSyl || !syl.romanizedText || syl.romanizedText.trim() === originalSyl.text.trim();
        });
      }

      return false;
    });

    // If all results are same as input and we have Gemini API key, try Gemini as fallback
    if (allResultsSameAsInput && settings.geminiApiKey) {
      console.warn("Google romanization appears to have failed (all results same as input), attempting Gemini fallback");
      meta.fallbackUsed = true;
      meta.provider = PROVIDERS.GEMINI;
      const geminiResult = await GeminiService.romanize(originalLyrics, settings);
      return { data: geminiResult, meta };
    }

    return { data: googleResult, meta };
  }

  /**
   * @param {LyricsData} originalLyrics
   * @param {string[]} translatedTexts
   */
  static mergeTranslatedTexts(originalLyrics, translatedTexts) {
    return originalLyrics.data.map((line, index) => ({
      ...line,
      translatedText: translatedTexts[index] || line.text
    }));
  }
}

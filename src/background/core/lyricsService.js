// ==================================================================================================
// LYRICS SERVICE
// ==================================================================================================

import { state } from '../storage/state.js';
import { lyricsDB, localLyricsDB } from '../storage/database.js';
import { SettingsManager } from '../storage/settings.js';
import { CONFIG, PROVIDERS } from '../constants.js';
import { DataParser } from '../utils/dataParser.js';
import { Utilities } from '../utils/utilities.js';
import { KPoeService } from '../services/kpoeService.js';
import { LRCLibService } from '../services/lrclibService.js';
import { YouTubeService } from '../services/youtubeService.js';

/** @typedef {import('../../types').SongInfo} SongInfo */
/** @typedef {import('../../types').LyricsCacheEntry} LyricsCacheEntry */
/** @typedef {import('../../types').LyricsData} LyricsData */
/** @typedef {import('../../types').LyricsSettings} LyricsSettings */

export class LyricsService {
  /** @param {SongInfo} songInfo */
  static createCacheKey(songInfo) {
    const artist = songInfo.artist || '';
    const album = songInfo.album || '';
    const duration = songInfo.duration || '';
    return `${songInfo.title} - ${artist} - ${album} - ${duration}`;
  }

  /** @param {SongInfo | null | undefined} songInfo */
  static validateSongInfo(songInfo) {
    if (!songInfo || !songInfo.title || !songInfo.artist) {
      throw new Error('Song info must include title and artist');
    }
  }

  /**
   * @param {SongInfo} songInfo
   * @param {boolean} [forceReload=false]
   * @returns {Promise<LyricsCacheEntry>}
   */
  static async getOrFetch(songInfo, forceReload = false) {
    this.validateSongInfo(songInfo);

    const cacheKey = this.createCacheKey(songInfo);

    if (!forceReload && state.hasCached(cacheKey)) {
      return state.getCached(cacheKey);
    }

    if (!forceReload) {
      const dbResult = await this.getFromDB(cacheKey);
      if (dbResult) {
        state.setCached(cacheKey, dbResult);
        return dbResult;
      }

      const localResult = await this.checkLocalLyrics(songInfo);
      if (localResult) {
        state.setCached(cacheKey, localResult);
        return localResult;
      }
    }

    if (state.hasOngoingFetch(cacheKey)) {
      return state.getOngoingFetch(cacheKey);
    }

    const fetchPromise = this.fetchNewLyrics(songInfo, cacheKey, forceReload);
    state.setOngoingFetch(cacheKey, fetchPromise);
    
    return fetchPromise;
  }

  /** @param {string} key */
  static async getFromDB(key) {
    const settings = await SettingsManager.get({ cacheStrategy: 'aggressive' });
    
    if (settings.cacheStrategy === 'none') {
      return null;
    }

    const result = await lyricsDB.get(key);
    
    if (!result) return null;

    const now = Date.now();
    const strategy = settings.cacheStrategy && settings.cacheStrategy in CONFIG.CACHE_EXPIRY
      ? settings.cacheStrategy
      : 'aggressive';
    const expirationTime = CONFIG.CACHE_EXPIRY[strategy];
    const age = now - result.timestamp;

    if (age < expirationTime) {
      return { lyrics: result.lyrics, version: result.version };
    }

    await lyricsDB.delete(key);
    return null;
  }

  /** @param {SongInfo} songInfo */
  static async checkLocalLyrics(songInfo) {
    if (songInfo.songId) {
      const directLocal = await localLyricsDB.get(songInfo.songId);
      if (directLocal) {
        return {
          lyrics: DataParser.parseKPoeFormat(directLocal.lyrics),
          version: directLocal.timestamp || songInfo.songId
        };
      }
    }

    const localLyricsList = await localLyricsDB.getAll();
    const matched = localLyricsList.find(item =>
      item.songInfo.title === songInfo.title &&
      item.songInfo.artist === songInfo.artist
    );

    if (matched) {
      const fetchedLocal = await localLyricsDB.get(matched.songId);
      if (fetchedLocal) {
        console.log(`Found local lyrics for "${songInfo.title}"`);
        return {
          lyrics: DataParser.parseKPoeFormat(fetchedLocal.lyrics),
          version: fetchedLocal.timestamp || matched.songId
        };
      }
    }

    return null;
  }

  /**
   * @param {SongInfo} songInfo
   * @param {string} cacheKey
   * @param {boolean} forceReload
   * @returns {Promise<LyricsCacheEntry>}
   */
  static async fetchNewLyrics(songInfo, cacheKey, forceReload) {
    try {
      const settings = await SettingsManager.getLyricsSettings();
      /** @type {RequestInit} */
      const fetchOptions = settings.cacheStrategy === 'none' ? { cache: 'no-store' } : {};

      const providers = this.getProviderOrder(settings);
      
      /** @type {LyricsData | null} */
      let lyrics = null;
      for (const provider of providers) {
        lyrics = await this.fetchFromProvider(provider, songInfo, settings, fetchOptions, forceReload);
        if (!Utilities.isEmptyLyrics(lyrics)) break;
      }

      // Fallback to YouTube subtitles
      if (Utilities.isEmptyLyrics(lyrics) && songInfo.videoId && songInfo.subtitle) {
        lyrics = await YouTubeService.fetchSubtitles(songInfo);
      }

      if (!lyrics || Utilities.isEmptyLyrics(lyrics)) {
        throw new Error('No lyrics found from any provider');
      }

      const fetchedAt = Date.now();
      const lyricsWithMeta = {
        ...lyrics,
        metadata: { ...(lyrics.metadata || {}), fetchedAt }
      };

      const version = fetchedAt;
      const result = { lyrics: lyricsWithMeta, version };

      state.setCached(cacheKey, result);
      
      if (settings.cacheStrategy !== 'none') {
        await lyricsDB.set({
          key: cacheKey,
          lyrics: lyricsWithMeta,
          version,
          timestamp: fetchedAt,
          duration: songInfo.duration
        });
      }

      return result;

    } finally {
      state.deleteOngoingFetch(cacheKey);
    }
  }

  /**
   * @param {LyricsSettings} settings
   * @returns {string[]}
   */
  static getProviderOrder(settings) {
    const allProviders = Object.values(PROVIDERS).filter(
      p => p !== PROVIDERS.GOOGLE && p !== PROVIDERS.GEMINI
    );
    
    const preferredProvider = allProviders.includes(settings.lyricsProvider)
      ? settings.lyricsProvider
      : PROVIDERS.KPOE;
    
    return [
      preferredProvider,
      ...allProviders.filter(p => p !== preferredProvider)
    ];
  }

  /**
   * @param {string} provider
   * @param {SongInfo} songInfo
   * @param {LyricsSettings} settings
   * @param {RequestInit} fetchOptions
   * @param {boolean} forceReload
   * @returns {Promise<LyricsData | null>}
   */
  static async fetchFromProvider(provider, songInfo, settings, fetchOptions, forceReload) {
    switch (provider) {
      case PROVIDERS.KPOE:
        return KPoeService.fetch(songInfo, settings.lyricsSourceOrder, forceReload, fetchOptions);
      
      case PROVIDERS.CUSTOM_KPOE:
        if (settings.customKpoeUrl) {
          return KPoeService.fetchCustom(
            songInfo,
            settings.customKpoeUrl,
            settings.lyricsSourceOrder,
            forceReload,
            fetchOptions
          );
        }
        return null;
      
      case PROVIDERS.LRCLIB:
        return LRCLibService.fetch(songInfo, fetchOptions);
      
      case PROVIDERS.LOCAL:
        const localResult = await this.checkLocalLyrics(songInfo);
        return localResult?.lyrics || null;
      
      default:
        return null;
    }
  }
}


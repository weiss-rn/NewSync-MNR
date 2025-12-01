// ==================================================================================================
// MESSAGE HANDLER
// ==================================================================================================

import { MESSAGE_TYPES } from '../constants.js';
import { state } from '../storage/state.js';
import { lyricsDB, translationsDB, localLyricsDB } from '../storage/database.js';
import { LyricsService } from './lyricsService.js';
import { TranslationService } from './translationService.js';
import { SponsorBlockService } from '../services/sponsorblockService.js';

/** @typedef {import('../../types').BackgroundMessage} BackgroundMessage */
/** @typedef {import('../../types').SendResponse} SendResponse */
/** @typedef {import('../../types').SongInfo} SongInfo */

export class MessageHandler {
  /**
   * Handle incoming background messages.
   * @param {BackgroundMessage} message
   * @param {any} sender
   * @param {SendResponse} sendResponse
   */
  static handle(message, sender, sendResponse) {
    if (!message || !message.type) {
      console.warn("Invalid message received:", message);
      sendResponse({ success: false, error: "Invalid message: missing type" });
      return false;
    }

    const handlers = {
      [MESSAGE_TYPES.FETCH_LYRICS]: () => this.fetchLyrics(message, sendResponse),
      [MESSAGE_TYPES.RESET_CACHE]: () => this.resetCache(sendResponse),
      [MESSAGE_TYPES.GET_CACHED_SIZE]: () => this.getCacheSize(sendResponse),
      [MESSAGE_TYPES.TRANSLATE_LYRICS]: () => this.translateLyrics(message, sendResponse),
      [MESSAGE_TYPES.FETCH_SPONSOR_SEGMENTS]: () => this.fetchSponsorSegments(message, sendResponse),
      [MESSAGE_TYPES.UPLOAD_LOCAL_LYRICS]: () => this.uploadLocalLyrics(message, sendResponse),
      [MESSAGE_TYPES.GET_LOCAL_LYRICS_LIST]: () => this.getLocalLyricsList(sendResponse),
      [MESSAGE_TYPES.DELETE_LOCAL_LYRICS]: () => this.deleteLocalLyrics(message, sendResponse),
      [MESSAGE_TYPES.FETCH_LOCAL_LYRICS]: () => this.fetchLocalLyrics(message, sendResponse),
      [MESSAGE_TYPES.UPDATE_LOCAL_LYRICS]: () => this.updateLocalLyrics(message, sendResponse)
    };

    const handler = handlers[message.type];
    
    if (handler) {
      handler().catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error handling ${message.type}:`, error);
        sendResponse({ success: false, error: errorMessage });
      });
      return true;
    }

    console.warn("Unknown message type:", message.type);
    sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
    return false;
  }

  /**
   * Fetch lyrics. Expects message.songInfo to be present.
   * @param {BackgroundMessage} message
   * @param {SendResponse} sendResponse
   */
  static async fetchLyrics(message, sendResponse) {
    try {
      const { lyrics } = await LyricsService.getOrFetch(message.songInfo, message.forceReload);
      sendResponse({ success: true, lyrics, metadata: message.songInfo });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error(`Failed to fetch lyrics for "${message.songInfo?.title}":`, error);
      sendResponse({ success: false, error: errorMessage, metadata: message.songInfo });
    }
  }

  /**
   * Translate lyrics via the configured translation provider.
   * @param {BackgroundMessage} message
   * @param {SendResponse} sendResponse
   */
  static async translateLyrics(message, sendResponse) {
    try {
      const translatedLyrics = await TranslationService.getOrFetch(
        message.songInfo,
        message.action,
        message.targetLang,
        message.forceReload
      );
      sendResponse({ success: true, translatedLyrics });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Translation error:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  static async fetchSponsorSegments(message, sendResponse) {
    try {
      const segments = await SponsorBlockService.fetch(message.videoId);
      sendResponse({ success: true, segments });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error(`Failed to fetch SponsorBlock segments:`, error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  static async resetCache(sendResponse) {
    try {
      state.clear();
      await Promise.all([
        lyricsDB.clear(),
        translationsDB.clear()
      ]);
      sendResponse({ success: true, message: "Cache reset successfully" });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Cache reset error:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  static async getCacheSize(sendResponse) {
    try {
      const [lyricsStats, translationsStats] = await Promise.all([
        lyricsDB.estimateSize(),
        translationsDB.estimateSize()
      ]);
      
      sendResponse({
        success: true,
        sizeKB: lyricsStats.sizeKB + translationsStats.sizeKB,
        cacheCount: lyricsStats.count + translationsStats.count
      });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Get cache size error:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  /**
   * Upload user-provided local lyrics for the current song.
   * @param {BackgroundMessage} message
   * @param {SendResponse} sendResponse
   */
  static async uploadLocalLyrics(message, sendResponse) {
    try {
      const songId = `${message.songInfo.title}-${message.songInfo.artist}-${Date.now()}`;
      await localLyricsDB.set({
        songId,
        songInfo: message.songInfo,
        lyrics: message.jsonLyrics,
        timestamp: Date.now()
      });
      sendResponse({ success: true, message: "Local lyrics uploaded successfully", songId });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Error uploading local lyrics:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  static async getLocalLyricsList(sendResponse) {
    try {
      const lyricsList = await localLyricsDB.getAll();
      const mappedList = lyricsList.map(item => ({
        songId: item.songId,
        songInfo: item.songInfo,
        timestamp: item.timestamp
      }));
      sendResponse({ success: true, lyricsList: mappedList });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Error getting local lyrics list:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  static async updateLocalLyrics(message, sendResponse) {
    try {
      const existingLyrics = await localLyricsDB.get(message.songId);
      if (!existingLyrics) {
        sendResponse({ success: false, error: "No lyrics found for the provided songId" });
        return;
      }

      const updatedRecord = {
        songId: message.songId,
        songInfo: message.songInfo || existingLyrics.songInfo,
        lyrics: message.jsonLyrics,
        timestamp: existingLyrics.timestamp || Date.now()
      };

      await localLyricsDB.set(updatedRecord);
      sendResponse({
        success: true,
        message: "Local lyrics updated successfully",
        lyrics: updatedRecord.lyrics,
        metadata: updatedRecord.songInfo
      });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Error updating local lyrics:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  /**
   * Delete local lyrics by songId.
   * @param {BackgroundMessage} message
   * @param {SendResponse} sendResponse
   */
  static async deleteLocalLyrics(message, sendResponse) {
    try {
      await localLyricsDB.delete(message.songId);
      sendResponse({ success: true, message: "Local lyrics deleted successfully" });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Error deleting local lyrics:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  /**
   * Returns local lyrics for a provided songId.
   * @param {BackgroundMessage} message
   * @param {SendResponse} sendResponse
   */
  static async fetchLocalLyrics(message, sendResponse) {
    try {
      const localLyrics = await localLyricsDB.get(message.songId);
      if (localLyrics) {
        sendResponse({
          success: true,
          lyrics: localLyrics.lyrics,
          metadata: localLyrics.songInfo
        });
      } else {
        sendResponse({ success: false, error: "Local lyrics not found" });
      }
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      console.error("Error fetching local lyrics:", error);
      sendResponse({ success: false, error: errorMessage });
    }
  }

  /** @param {unknown} error */
  static toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
}


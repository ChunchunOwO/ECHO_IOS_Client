import AsyncStorage from '@react-native-async-storage/async-storage';

export type SavedLocalMusicState = {
  favoriteTrackIds: string[];
  queueTrackIds: string[];
  recentTrackIds: string[];
};

const storageKey = 'echo.ios.localMusic.v1';

const emptyState: SavedLocalMusicState = {
  favoriteTrackIds: [],
  queueTrackIds: [],
  recentTrackIds: [],
};

const stringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

export const loadSavedLocalMusicState = async (): Promise<SavedLocalMusicState> => {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) {
      return emptyState;
    }
    const parsed = JSON.parse(raw) as Partial<SavedLocalMusicState>;
    return {
      favoriteTrackIds: stringArray(parsed.favoriteTrackIds),
      queueTrackIds: stringArray(parsed.queueTrackIds),
      recentTrackIds: stringArray(parsed.recentTrackIds),
    };
  } catch {
    return emptyState;
  }
};

export const saveLocalMusicState = async (state: SavedLocalMusicState): Promise<void> => {
  await AsyncStorage.setItem(storageKey, JSON.stringify(state));
};

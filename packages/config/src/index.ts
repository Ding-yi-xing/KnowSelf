export { loadSettings, saveSettings } from "./settings";
export { getDataPaths, ensureDataDirs } from "./paths";
export type { DataPaths } from "./paths";
export { resolvePersonsKey, defaultPersonsKeyPath, KEY_ENV_VAR, KEY_BYTES } from "./keys";
export type { PersonsKeySource } from "./keys";
export {
  SettingsError,
  SettingsParseError,
  SettingsValidationError,
  SettingsWriteError,
  SettingsReferenceError,
  SettingsVersionError,
  PersonsKeyError,
  EncryptionKeyMissingError,
  EncryptionKeyInvalidError,
} from "./errors";
export type { PersonsKeyErrorCode } from "./errors";

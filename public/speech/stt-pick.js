/**
 * Pure STT engine selection. Whisper becomes the default only when it is ready
 * (installed + model downloaded) and the user has not made an explicit choice;
 * an explicit choice is always respected.
 *
 * @param {{ whisper?: { available: boolean, modelReady: boolean } } | undefined} health
 * @param {string | null | undefined} userChoice Stored engine from localStorage, or null/undefined when never chosen.
 * @returns {"browser" | "whisper"}
 */
export function pickStt(health, userChoice) {
  if (userChoice === "whisper" || userChoice === "browser") return userChoice;
  const whisperReady = Boolean(health?.whisper?.available && health?.whisper?.modelReady);
  return whisperReady ? "whisper" : "browser";
}
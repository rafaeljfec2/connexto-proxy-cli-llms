import type { ModelSelection } from "@cursor/sdk";

const COMPOSER_MODEL_ID = "composer-2.5";
const COMPOSER_FAST_MODEL_ID = "composer-2.5-fast";
const FAST_PARAMETER_ID = "fast";

export function cursorModelSelection(modelId: string): ModelSelection {
  if (modelId === COMPOSER_MODEL_ID) {
    return {
      id: COMPOSER_MODEL_ID,
      params: [{ id: FAST_PARAMETER_ID, value: "false" }],
    };
  }
  if (modelId === COMPOSER_FAST_MODEL_ID) {
    return {
      id: COMPOSER_MODEL_ID,
      params: [{ id: FAST_PARAMETER_ID, value: "true" }],
    };
  }
  return { id: modelId };
}

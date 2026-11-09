import type { Express, Request, Response } from "express";
import {
  findComposerModel,
  openAiErrorPayload,
  openAiModelList,
  openAiModelObject,
} from "@agent-runtime-gateway/compatibility-openai";
import {
  ANTIGRAVITY_MODELS,
  findAntigravityModel,
  type AntigravityModel,
} from "@agent-runtime-gateway/provider-antigravity";

const MODEL_CREATED_AT = 1_735_689_600;

function antigravityModelObject(model: AntigravityModel): Record<string, unknown> {
  return {
    id: model.id,
    object: "model",
    created: MODEL_CREATED_AT,
    owned_by: "antigravity",
    permission: [],
    root: model.id,
    parent: null,
    capabilities: model.capabilities,
  };
}

export function registerModelRoutes(app: Express): void {
  app.get("/v1/models", (_req: Request, res: Response): void => {
    const composerModels = openAiModelList();
    res.status(200).json({
      ...composerModels,
      data: [...composerModels.data, ...ANTIGRAVITY_MODELS.map(antigravityModelObject)],
    });
  });

  app.get("/v1/models/:model", (req: Request, res: Response): void => {
    const rawParam = req.params.model;
    const modelId = Array.isArray(rawParam) ? rawParam[0] : (rawParam ?? "");
    const antigravityModel = findAntigravityModel(modelId);
    const model = findComposerModel(modelId);

    if (antigravityModel !== undefined) {
      res.status(200).json(antigravityModelObject(antigravityModel));
      return;
    }

    if (model === undefined) {
      res
        .status(404)
        .json(
          openAiErrorPayload(
            `The model '${modelId}' does not exist`,
            "model_not_found",
          ),
        );
      return;
    }

    res.status(200).json(openAiModelObject(model));
  });
}

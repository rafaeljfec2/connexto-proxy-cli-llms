import type { Express, Request, Response } from "express";
import {
  findComposerModel,
  openAiErrorPayload,
  openAiModelList,
  openAiModelObject,
} from "@agent-runtime-gateway/compatibility-openai";

export function registerModelRoutes(app: Express): void {
  app.get("/v1/models", (_req: Request, res: Response): void => {
    res.status(200).json(openAiModelList());
  });

  app.get("/v1/models/:model", (req: Request, res: Response): void => {
    const rawParam = req.params.model;
    const modelId = Array.isArray(rawParam) ? rawParam[0] : (rawParam ?? "");
    const model = findComposerModel(modelId);

    if (!model) {
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

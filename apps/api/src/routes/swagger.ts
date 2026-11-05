import type { Express, NextFunction, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiForRequest } from "../openapi/request-spec.js";

export function registerSwaggerRoutes(app: Express): void {
  app.get("/openapi.json", (req: Request, res: Response): void => {
    res.status(200).json(openApiForRequest(req));
  });

  app.use(
    "/docs",
    swaggerUi.serve,
    (req: Request, res: Response, next: NextFunction): void => {
      swaggerUi.setup(openApiForRequest(req), {
        customSiteTitle: "Agent Runtime Gateway — API Docs",
        swaggerOptions: {
          persistAuthorization: true,
          tryItOutEnabled: true,
        },
      })(req, res, next);
    },
  );
}

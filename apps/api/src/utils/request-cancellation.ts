import type { Request, Response } from "express";

export interface RequestCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createRequestCancellation(
  req: Request,
  res: Response,
): RequestCancellation {
  const controller = new AbortController();
  let disposed = false;

  const abortIfIncomplete = (): void => {
    if (!res.writableFinished && !controller.signal.aborted) {
      controller.abort();
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    req.off("aborted", abortIfIncomplete);
    res.off("close", abortIfIncomplete);
  };

  req.once("aborted", abortIfIncomplete);
  res.once("close", abortIfIncomplete);
  if (req.aborted || res.destroyed) abortIfIncomplete();

  return { signal: controller.signal, dispose };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  InvalidSessionKeyError,
  SessionSerializationError,
  SessionStorageError,
} from "./errors.js";
import type { FilesystemSessionStoreOptions, SessionStore } from "./types.js";
import { validateNamespace, validateNamespaceAndKey } from "./validation.js";

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

export class FilesystemSessionStore<T> implements SessionStore<T> {
  private readonly rootDir: string;
  private readonly fileMode: number;
  private readonly dirMode: number;

  constructor(options: FilesystemSessionStoreOptions) {
    if (!options.rootDir || typeof options.rootDir !== "string") {
      throw new SessionStorageError("rootDir must be a non-empty string");
    }
    this.rootDir = path.resolve(options.rootDir);
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
    this.dirMode = options.dirMode ?? DEFAULT_DIR_MODE;
  }

  public async get(namespace: string, key: string): Promise<T | undefined> {
    validateNamespaceAndKey(namespace, key);
    const filePath = this.resolvePath(namespace, key);

    try {
      const content = await fs.readFile(filePath, "utf8");
      return this.deserialize(content, key);
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return undefined;
      }
      if (error instanceof SessionStorageError) {
        throw error;
      }
      throw new SessionStorageError(
        `Failed to read session entry for key "${key}" in namespace "${namespace}"`,
        error,
      );
    }
  }

  public async set(namespace: string, key: string, value: T): Promise<void> {
    validateNamespaceAndKey(namespace, key);
    const namespaceDir = this.resolveNamespaceDir(namespace);
    const filePath = this.resolvePath(namespace, key);
    const tempPath = path.join(
      namespaceDir,
      `.${key}.${randomUUID()}.${Date.now()}.tmp`,
    );

    let serialized: string;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (error: unknown) {
      throw new SessionSerializationError(key, error);
    }

    try {
      await fs.mkdir(namespaceDir, { recursive: true, mode: this.dirMode });
      await fs.writeFile(tempPath, serialized, {
        encoding: "utf8",
        mode: this.fileMode,
      });
      await fs.rename(tempPath, filePath);
    } catch (error: unknown) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore temporary file unlink failure
      }
      throw new SessionStorageError(
        `Failed to write session entry for key "${key}" in namespace "${namespace}"`,
        error,
      );
    }
  }

  public async delete(namespace: string, key: string): Promise<boolean> {
    validateNamespaceAndKey(namespace, key);
    const filePath = this.resolvePath(namespace, key);

    try {
      await fs.unlink(filePath);
      return true;
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw new SessionStorageError(
        `Failed to delete session entry for key "${key}" in namespace "${namespace}"`,
        error,
      );
    }
  }

  public async exists(namespace: string, key: string): Promise<boolean> {
    validateNamespaceAndKey(namespace, key);
    const filePath = this.resolvePath(namespace, key);

    try {
      await fs.access(filePath);
      return true;
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw new SessionStorageError(
        `Failed to check existence for key "${key}" in namespace "${namespace}"`,
        error,
      );
    }
  }

  public async list(namespace: string): Promise<string[]> {
    validateNamespace(namespace);
    const namespaceDir = this.resolveNamespaceDir(namespace);

    try {
      const entries = await fs.readdir(namespaceDir, { withFileTypes: true });
      const keys: string[] = [];
      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.endsWith(".json") &&
          !entry.name.startsWith(".")
        ) {
          keys.push(entry.name.slice(0, -".json".length));
        }
      }
      return keys;
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return [];
      }
      throw new SessionStorageError(
        `Failed to list session entries for namespace "${namespace}"`,
        error,
      );
    }
  }

  public async clear(namespace: string): Promise<void> {
    validateNamespace(namespace);
    const namespaceDir = this.resolveNamespaceDir(namespace);

    try {
      await fs.rm(namespaceDir, { recursive: true, force: true });
    } catch (error: unknown) {
      if (!this.isNotFoundError(error)) {
        throw new SessionStorageError(
          `Failed to clear session namespace "${namespace}"`,
          error,
        );
      }
    }
  }

  private resolveNamespaceDir(namespace: string): string {
    const dir = path.resolve(this.rootDir, namespace);
    this.assertWithinRoot(dir);
    return dir;
  }

  private resolvePath(namespace: string, key: string): string {
    const namespaceDir = this.resolveNamespaceDir(namespace);
    const targetFile = path.resolve(namespaceDir, `${key}.json`);
    this.assertWithinDir(targetFile, namespaceDir);
    return targetFile;
  }

  private assertWithinRoot(targetPath: string): void {
    const relative = path.relative(this.rootDir, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new InvalidSessionKeyError(targetPath, "namespace");
    }
  }

  private assertWithinDir(targetPath: string, parentDir: string): void {
    const relative = path.relative(parentDir, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new InvalidSessionKeyError(targetPath, "key");
    }
  }

  private deserialize(content: string, key: string): T {
    try {
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      throw new SessionSerializationError(key, error);
    }
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    );
  }
}

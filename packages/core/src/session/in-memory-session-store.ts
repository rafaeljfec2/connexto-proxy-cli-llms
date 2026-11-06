import type { SessionStore } from "./types.js";
import { validateNamespace, validateNamespaceAndKey } from "./validation.js";

export class InMemorySessionStore<T> implements SessionStore<T> {
  private readonly data = new Map<string, Map<string, T>>();

  public get(namespace: string, key: string): Promise<T | undefined> {
    validateNamespaceAndKey(namespace, key);
    const nsMap = this.data.get(namespace);
    if (!nsMap) {
      return Promise.resolve(undefined);
    }
    const value = nsMap.get(key);
    return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }

  public set(namespace: string, key: string, value: T): Promise<void> {
    validateNamespaceAndKey(namespace, key);
    let nsMap = this.data.get(namespace);
    if (!nsMap) {
      nsMap = new Map<string, T>();
      this.data.set(namespace, nsMap);
    }
    nsMap.set(key, structuredClone(value));
    return Promise.resolve();
  }

  public delete(namespace: string, key: string): Promise<boolean> {
    validateNamespaceAndKey(namespace, key);
    const nsMap = this.data.get(namespace);
    if (!nsMap) {
      return Promise.resolve(false);
    }
    const existed = nsMap.delete(key);
    if (nsMap.size === 0) {
      this.data.delete(namespace);
    }
    return Promise.resolve(existed);
  }

  public exists(namespace: string, key: string): Promise<boolean> {
    validateNamespaceAndKey(namespace, key);
    const nsMap = this.data.get(namespace);
    return Promise.resolve(nsMap !== undefined && nsMap.has(key));
  }

  public list(namespace: string): Promise<string[]> {
    validateNamespace(namespace);
    const nsMap = this.data.get(namespace);
    if (!nsMap) {
      return Promise.resolve([]);
    }
    return Promise.resolve([...nsMap.keys()]);
  }

  public clear(namespace: string): Promise<void> {
    validateNamespace(namespace);
    this.data.delete(namespace);
    return Promise.resolve();
  }
}

import type { NamespacedSessionStore, SessionStore } from "./types.js";
import { validateNamespace } from "./validation.js";

export class DefaultNamespacedSessionStore<T> implements NamespacedSessionStore<T> {
  public readonly namespace: string;

  constructor(
    private readonly store: SessionStore<T>,
    namespace: string,
  ) {
    validateNamespace(namespace);
    this.namespace = namespace;
  }

  public get(key: string): Promise<T | undefined> {
    return this.store.get(this.namespace, key);
  }

  public set(key: string, value: T): Promise<void> {
    return this.store.set(this.namespace, key, value);
  }

  public delete(key: string): Promise<boolean> {
    return this.store.delete(this.namespace, key);
  }

  public exists(key: string): Promise<boolean> {
    return this.store.exists(this.namespace, key);
  }

  public list(): Promise<string[]> {
    return this.store.list(this.namespace);
  }

  public clear(): Promise<void> {
    return this.store.clear(this.namespace);
  }
}

export function createNamespacedStore<T>(
  store: SessionStore<T>,
  namespace: string,
): NamespacedSessionStore<T> {
  return new DefaultNamespacedSessionStore(store, namespace);
}

export interface SessionStore<T> {
  get(namespace: string, key: string): Promise<T | undefined>;
  set(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  exists(namespace: string, key: string): Promise<boolean>;
  list(namespace: string): Promise<string[]>;
  clear(namespace: string): Promise<void>;
}

export interface NamespacedSessionStore<T> {
  readonly namespace: string;
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface FilesystemSessionStoreOptions {
  readonly rootDir: string;
  readonly fileMode?: number;
  readonly dirMode?: number;
}

export interface Model {
  id: string;
  name?: string;
}

export interface ProviderCredential {
  readonly type: string;
  readonly value: string;
}

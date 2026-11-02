declare global {
  interface Window {
    __SMOKE_RESULT?: {
      ok: boolean;
      state?: string;
      ids?: Array<string | number>;
      capabilities?: Record<string, boolean>;
      error?: string;
    };
  }
}

export {};

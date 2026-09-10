interface PakoDeflateOptions {
  chunkSize: number;
  level: number;
  raw: boolean;
}

interface PakoModule {
  readonly Deflate?: new (options: PakoDeflateOptions) => unknown;
}

declare const pako: PakoModule;

export default pako;

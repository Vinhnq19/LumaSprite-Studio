export type StudioErrorCode =
  | 'PXL_UNDECLARED_IDENTIFIER' | 'PXL_MODULE_UNSUPPORTED' | 'RENDER_FAILED'
  | 'INVALID_ASSET_PAYLOAD' | 'STALE_REVISION' | 'JOB_CANCELED' | 'UNSUPPORTED_PRODUCTION_VERSION'
  | 'ASSET_NOT_FOUND' | 'INVALID_PALETTE' | 'INVALID_ALPHA' | 'EXPORT_FAILED';

export interface StudioDiagnostic {
  code: StudioErrorCode;
  message: string;
  location?: { file: string; line: number; column: number };
  identifier?: string;
  evidence?: string;
}

export function diagnosticOf(error: unknown): StudioDiagnostic | undefined {
  return error instanceof Error ? (error as Error & { diagnostic?: StudioDiagnostic }).diagnostic : undefined;
}

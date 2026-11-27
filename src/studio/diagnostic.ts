export type StudioErrorCode =
  | 'PXL_UNDECLARED_IDENTIFIER' | 'PXL_MODULE_UNSUPPORTED' | 'RENDER_FAILED'
  | 'INVALID_ASSET_PAYLOAD' | 'STALE_REVISION' | 'JOB_CANCELED' | 'UNSUPPORTED_PRODUCTION_VERSION'
  | 'ASSET_NOT_FOUND' | 'INVALID_PALETTE' | 'INVALID_ALPHA' | 'EXPORT_FAILED'
  | 'INVALID_REFERENCE' | 'BROKEN_REFERENCE' | 'MISSING_FILE' | 'CORRUPTED_JSON' | 'INVALID_PNG'
  | 'SOURCE_NOT_FOUND' | 'SOURCE_NOT_DIR' | 'INVALID_WALKABLE' | 'STALE_HASH' | 'UNKNOWN_PACKAGE_FORMAT'
  | 'UNSUPPORTED_SCHEMA_VERSION' | 'MISSING_METADATA' | 'REVISION_MISMATCH' | 'INVALID_DIMENSIONS'
  | 'MISSING_TILEMAP' | 'INVALID_TILEMAP' | 'MISSING_TILE_ID' | 'INVALID_ATLAS' | 'INVALID_FOREGROUND'
  | 'INVALID_CORRECTION' | 'MISSING_COLLISION' | 'INVALID_COLLISION' | 'INVALID_CLEARANCE' | 'INVALID_SPAWN'
  | 'INVALID_LAYER_METADATA' | 'MISSING_ACTOR' | 'INVALID_INTERACTION_ANCHOR' | 'UNITY_CONTRACT_INVALID'
  | 'UNAPPROVED_SCENE' | 'ROUTE_BLOCKED' | 'PROTECTED_ENGINE_SOURCE';

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

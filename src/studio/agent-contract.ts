export const agentVersion = 1;
export const agentPath = '/api/studio/agent/v1';
export const agentInputBytes = 1024 * 1024;
export const agentResultBytes = 32 * 1024 * 1024;

export const agentOperations = {
  capabilities: { access: 'read', fields: [] },
  'projects.list': { access: 'read', fields: [] },
  'project.get': { access: 'read', fields: [] },
  'assets.list': { access: 'read', fields: [] },
  'collections.list': { access: 'read', fields: [] },
  'profiles.list': { access: 'read', fields: [] },
  'style.check': { access: 'read', fields: ['assetId', 'collectionId'] },
  'scenes.list': { access: 'read', fields: [] },
  'animations.list': { access: 'read', fields: [] },
  'tilemaps.list': { access: 'read', fields: [] },
  'history.list': { access: 'read', fields: [] },
  'package.plan': { access: 'read', fields: ['collectionId', 'sceneId'] },
  'package.start': { access: 'local-job', fields: ['collectionId', 'sceneId'] },
  'jobs.status': { access: 'read', fields: ['jobId'] },
  'jobs.result': { access: 'read', fields: ['jobId'] },
  'jobs.cancel': { access: 'local-job', fields: ['jobId'] },
  'engine.capabilities': { access: 'read', fields: [] },
  'engine.submit': { access: 'external-cost', fields: [] },
  'project.create': { access: 'mutation', fields: ['name', 'width', 'height'] },
  'asset.create': { access: 'mutation', fields: ['name', 'width', 'height', 'rgba'] },
  'asset.rename': { access: 'mutation', fields: ['assetId', 'name'] },
  'collection.membership': { access: 'mutation', fields: ['collectionId', 'assetId', 'include'] },
  'collection.selectVersion': { access: 'mutation', fields: ['collectionId', 'assetId', 'replacementId'] },
  'asset.assignProfile': { access: 'mutation', fields: ['assetId', 'profileId'] },
  'scene.place': { access: 'mutation', fields: ['sceneId', 'placementId', 'assetId', 'tagId', 'x', 'y'] },
  'project.rollback': { access: 'mutation', fields: ['snapshotId'] },
} as const;
export type AgentOperation = keyof typeof agentOperations;
export type AgentCode = 'INVALID_REQUEST' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_OPERATION' | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED' | 'NOT_FOUND' | 'STALE_REVISION' | 'STALE_SOURCE' | 'NOT_READY' | 'LIMIT_EXCEEDED'
  | 'INCOMPATIBLE_PROJECT' | 'ENGINE_UNAVAILABLE' | 'OPERATION_FAILED' | 'STUDIO_UNAVAILABLE';
export interface AgentDiagnostic { code: AgentCode; message: string; targetId?: string }
export interface AgentRequest {
  version: 1;
  operation: AgentOperation;
  projectId?: string;
  expectedRevision?: number;
  input: Record<string, unknown>;
}

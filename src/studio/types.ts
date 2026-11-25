export interface AssetMetadata {
  pivot?: { x: number; y: number };
  hitbox?: { x: number; y: number; w: number; h: number };
  events?: { frame: number; name: string }[];
}

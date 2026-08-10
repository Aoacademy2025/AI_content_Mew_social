import type { VisualFormatId } from "@/lib/brand-visual-system";
import type {
  BrandProfileSeed,
  CurrentBrandDefaults,
} from "@/lib/brand-profile-seed";

export type { VisualFormatId };
export type BrandPayload = BrandProfileSeed;
export type BrandDefaults = CurrentBrandDefaults;

export type VisualFormat = {
  id: VisualFormatId;
  label: string;
  description: string;
  recipeVersion: string;
  previewUrl: string;
};

export type Revision = {
  id: string;
  version: number;
  payload: BrandPayload | null;
  createdAt: string;
};

export type BrandProfile = {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  bannedWords: string[];
  ctaStyle: string;
  language: string;
  analysisNotes: string | null;
  sampleText: string | null;
  activeRevisionNumber: number;
  frozen: boolean;
  updatedAt: string;
  draft: { baseRevisionNumber: number; payload: BrandPayload | null } | null;
  revisions: Revision[];
};

export type SubtitlePresetOption = {
  id: string;
  name: string;
  config: Record<string, string | number | boolean | null>;
};

export type LibraryResponse = {
  profiles: BrandProfile[];
  cap: number | null;
  canCreate: boolean;
  creationRequiresResult: boolean;
  availabilitySelectionRequired: boolean;
  canRestoreAll: boolean;
  visualFormats: VisualFormat[];
  subtitlePresets: SubtitlePresetOption[];
  brandAssets: Array<{ id: string; name: string }>;
  defaults: BrandDefaults;
};

export type PreviewItem = {
  id: string;
  phase: string;
  status: string;
  outputUrl: string | null;
  sourceType: string;
  errorCode: string | null;
};

export type PreviewBatch = {
  id: string;
  requestId: string;
  status: string;
  items: PreviewItem[];
};

export type ProjectVisualSeed = {
  preflightId?: string | null;
  contentDomain?: string | null;
  context?: {
    visualFormatId?: VisualFormatId;
    treatment?: string;
    brandVisualLanguage?: Partial<BrandPayload["visual"]> | null;
  };
};

/** The visual helper returns a proposal only; the creator applies it by hand. */
export type VisualProposal = BrandPayload["visual"] & { rationale?: string };

export type Notice = { tone: "ok" | "error"; text: string };

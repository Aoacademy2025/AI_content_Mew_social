import type { VisualFormatId } from "@/lib/brand-visual-system";
import type {
  BrandProfileSeed,
  CurrentBrandDefaults,
} from "@/lib/brand-profile-seed";
import type { TreatmentPresetId } from "@/lib/brand-treatment-catalog";

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
  legacyVisualFormat: boolean;
  updatedAt: string;
  draft: { baseRevisionNumber: number; payload: BrandPayload | null } | null;
  revisions: Revision[];
};

export type SubtitlePresetOption = {
  id: string;
  name: string;
  config: Record<string, string | number | boolean | null>;
};

/** ADR 0059: the library itself is open to every plan; this is the gate on the
 * AI-image actions inside it. */
export type BrandImageAccess = {
  canUse: boolean;
  reason: "eligible" | "feature_off" | "payment_required" | "rollout_wait" | "suspended";
  upgradeUrl: string;
};

export type LibraryResponse = {
  profiles: BrandProfile[];
  cap: number | null;
  canCreate: boolean;
  imageAccess: BrandImageAccess;
  availabilitySelectionRequired: boolean;
  visualFormats: VisualFormat[];
  treatmentPresets: Array<{ id: TreatmentPresetId; label: string }>;
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

/** The helper shapes stable brand rendering only; per-video storytelling is
 * selected from the reviewed catalog separately. */
export type VisualProposal = Pick<BrandPayload["visual"],
  "primaryVisualFormatId" | "palette" | "personality" | "visualNotes"
> & { rationale?: string };

export type Notice = { tone: "ok" | "error"; text: string };

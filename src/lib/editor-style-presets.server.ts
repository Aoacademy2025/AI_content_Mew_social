import {
  MAX_EDITOR_STYLE_PRESETS_PER_KIND,
  normalizeEditorStylePresetConfig,
  normalizeEditorStylePresetName,
  type EditorStylePreset,
  type EditorStylePresetKind,
  type HeadlineEditorStylePreset,
  type HeadlineStylePresetConfig,
  type LogoEditorStylePreset,
  type SubtitleStylePresetConfig,
  type SubtitleEditorStylePreset,
} from "@/lib/editor-style-preset-contract";
import { canUseLogoOverlay } from "@/lib/brand-assets.server";
import type { LogoOverlayConfig } from "@/lib/logo-overlay";
import { prisma } from "@/lib/prisma";

export type EditorStylePresetErrorCode =
  | "invalid_kind"
  | "invalid_name"
  | "invalid_config"
  | "plan_required"
  | "asset_not_found"
  | "limit_reached";

export class EditorStylePresetError extends Error {
  code: EditorStylePresetErrorCode;
  status: number;

  constructor(code: EditorStylePresetErrorCode, status: number) {
    super(code);
    this.name = "EditorStylePresetError";
    this.code = code;
    this.status = status;
  }
}

type PresetRow = {
  id: string;
  userId: string;
  kind: string;
  name: string;
  configJson: string;
  brandAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  brandAsset?: {
    userId: string;
    retiredAt: Date | null;
  } | null;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function serializePreset(row: PresetRow): EditorStylePreset | null {
  const timestamps = {
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.kind === "subtitle") {
    const config = normalizeEditorStylePresetConfig("subtitle", parseJson(row.configJson));
    if (!config || row.brandAssetId) return null;
    return {
      id: row.id,
      kind: "subtitle",
      name: row.name,
      config,
      ...timestamps,
    };
  }
  if (row.kind === "logo") {
    const config = normalizeEditorStylePresetConfig("logo", parseJson(row.configJson));
    if (
      !config
      || !row.brandAssetId
      || config.assetId !== row.brandAssetId
      || !row.brandAsset
      || row.brandAsset.userId !== row.userId
      || row.brandAsset.retiredAt
    ) {
      return null;
    }
    return {
      id: row.id,
      kind: "logo",
      name: row.name,
      config,
      ...timestamps,
    };
  }
  if (row.kind === "headline") {
    const config = normalizeEditorStylePresetConfig("headline", parseJson(row.configJson));
    if (!config || row.brandAssetId) return null;
    return {
      id: row.id,
      kind: "headline",
      name: row.name,
      config,
      ...timestamps,
    };
  }
  return null;
}

export async function listEditorStylePresets(userId: string): Promise<EditorStylePreset[]> {
  const rows = await prisma.editorStylePreset.findMany({
    where: { userId },
    include: {
      brandAsset: {
        select: { userId: true, retiredAt: true },
      },
    },
    orderBy: [{ kind: "asc" }, { updatedAt: "desc" }],
  });
  return rows
    .map((row) => serializePreset(row))
    .filter((preset): preset is EditorStylePreset => Boolean(preset));
}

type SaveEditorStylePresetInput = {
  userId: string;
  plan: string;
  name: unknown;
} & (
  | { kind: "subtitle"; config: unknown }
  | { kind: "headline"; config: unknown }
  | { kind: "logo"; config: unknown }
);

export async function saveEditorStylePreset(
  input: SaveEditorStylePresetInput & { kind: "subtitle" },
): Promise<SubtitleEditorStylePreset>;
export async function saveEditorStylePreset(
  input: SaveEditorStylePresetInput & { kind: "headline" },
): Promise<HeadlineEditorStylePreset>;
export async function saveEditorStylePreset(
  input: SaveEditorStylePresetInput & { kind: "logo" },
): Promise<LogoEditorStylePreset>;
export async function saveEditorStylePreset(
  input: SaveEditorStylePresetInput,
): Promise<EditorStylePreset>;
export async function saveEditorStylePreset(
  input: SaveEditorStylePresetInput,
): Promise<EditorStylePreset> {
  const normalizedName = normalizeEditorStylePresetName(input.name);
  if (!normalizedName) throw new EditorStylePresetError("invalid_name", 400);

  let config: SubtitleStylePresetConfig | HeadlineStylePresetConfig | LogoOverlayConfig;
  let requestedBrandAssetId: string | null = null;
  if (input.kind === "subtitle") {
    const normalized = normalizeEditorStylePresetConfig("subtitle", input.config);
    if (!normalized) throw new EditorStylePresetError("invalid_config", 400);
    config = normalized;
  } else if (input.kind === "headline") {
    const normalized = normalizeEditorStylePresetConfig("headline", input.config);
    if (!normalized) throw new EditorStylePresetError("invalid_config", 400);
    config = normalized;
  } else {
    const normalized = normalizeEditorStylePresetConfig("logo", input.config);
    if (!normalized) throw new EditorStylePresetError("invalid_config", 400);
    if (!canUseLogoOverlay(input.plan)) {
      throw new EditorStylePresetError("plan_required", 403);
    }
    config = normalized;
    requestedBrandAssetId = normalized.assetId;
  }

  const row = await prisma.$transaction(async (tx) => {
    let brandAssetId: string | null = null;
    if (input.kind === "logo") {
      if (!requestedBrandAssetId) {
        throw new EditorStylePresetError("invalid_config", 400);
      }
      const asset = await tx.brandAsset.findFirst({
        where: {
          id: requestedBrandAssetId,
          userId: input.userId,
          retiredAt: null,
        },
        select: { id: true },
      });
      if (!asset) throw new EditorStylePresetError("asset_not_found", 404);
      brandAssetId = asset.id;
    }

    const uniqueKey = {
      userId: input.userId,
      kind: input.kind,
      nameKey: normalizedName.nameKey,
    };
    const existing = await tx.editorStylePreset.findUnique({
      where: { userId_kind_nameKey: uniqueKey },
      select: { id: true },
    });
    if (!existing) {
      const count = await tx.editorStylePreset.count({
        where: { userId: input.userId, kind: input.kind },
      });
      if (count >= MAX_EDITOR_STYLE_PRESETS_PER_KIND) {
        throw new EditorStylePresetError("limit_reached", 409);
      }
    }

    return tx.editorStylePreset.upsert({
      where: { userId_kind_nameKey: uniqueKey },
      create: {
        ...uniqueKey,
        name: normalizedName.name,
        configJson: JSON.stringify(config),
        brandAssetId,
      },
      update: {
        name: normalizedName.name,
        configJson: JSON.stringify(config),
        brandAssetId,
      },
      include: {
        brandAsset: {
          select: { userId: true, retiredAt: true },
        },
      },
    });
  });

  const preset = serializePreset(row);
  if (!preset) throw new EditorStylePresetError("invalid_config", 500);
  return preset;
}

export async function deleteEditorStylePreset(
  userId: string,
  presetId: string,
): Promise<boolean> {
  if (!presetId) return false;
  const result = await prisma.editorStylePreset.deleteMany({
    where: { id: presetId, userId },
  });
  return result.count === 1;
}

export function isEditorStylePresetKind(value: unknown): value is EditorStylePresetKind {
  return value === "subtitle" || value === "headline" || value === "logo";
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  contentAddressedMediaIdentity,
  mediaObjectKey,
} from "../src/lib/media-storage";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const logical = {
  area: "renders" as const,
  filename: "reused-render.mp4",
};
const firstPhysical = contentAddressedMediaIdentity(
  logical,
  sha256("first render payload"),
);
const replacementPhysical = contentAddressedMediaIdentity(
  logical,
  sha256("replacement render payload"),
);

assert.notEqual(
  mediaObjectKey(firstPhysical),
  mediaObjectKey(replacementPhysical),
  "the same logical render filename with different bytes needs distinct immutable keys",
);

console.log("PASS media render content-addressed versioning");

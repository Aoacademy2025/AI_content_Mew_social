import { BrandLibraryClient } from "./_components/BrandLibraryClient";

/** Route shell only. Auth + Brand Visual rollout gating live in layout.tsx;
 * every interactive surface is a client island under ./_components. */
export default function BrandLibraryPage() {
  return <BrandLibraryClient />;
}

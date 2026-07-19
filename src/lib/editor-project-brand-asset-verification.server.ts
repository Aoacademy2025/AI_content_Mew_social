import { AsyncLocalStorage } from "node:async_hooks";

export type EditorProjectBrandAssetVerificationStep =
  | "after-asset-prepare"
  | "after-project-cas";

type EditorProjectBrandAssetVerificationObserver = (
  step: EditorProjectBrandAssetVerificationStep,
) => void | Promise<void>;

const verificationObserver = new AsyncLocalStorage<EditorProjectBrandAssetVerificationObserver>();

export function runWithEditorProjectBrandAssetVerificationBarrier<T>(
  observer: EditorProjectBrandAssetVerificationObserver,
  task: () => Promise<T>,
): Promise<T> {
  return verificationObserver.run(observer, task);
}

export async function observeEditorProjectBrandAssetVerificationStep(
  step: EditorProjectBrandAssetVerificationStep,
): Promise<void> {
  const observer = verificationObserver.getStore();
  if (observer) await observer(step);
}

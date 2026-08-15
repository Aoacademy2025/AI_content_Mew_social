/**
 * Durable-provider jobs re-enter the orchestrator once per poll while keeping their
 * persisted currentStep. That is a resume of the same phase, not a new lifecycle start.
 */
export function shouldEmitPipelineStepStarted(
  persistedCurrentStep: string | null | undefined,
  nextStep: string,
): boolean {
  return persistedCurrentStep !== nextStep;
}

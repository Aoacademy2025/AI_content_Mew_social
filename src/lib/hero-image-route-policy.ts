export type HeroRunpodRoute = "runpod-custom" | "runpod-public";

/** Hero AI Image stays inside the customer-selected RunPod AI engine while an
 * operator may move traffic between the private worker and RunPod's fixed-price
 * public endpoint during an incident. Cloud/KIE routes are never admitted. */
export function isHeroRunpodRoute(route: unknown): route is HeroRunpodRoute {
  return route === "runpod-custom" || route === "runpod-public";
}

/** Live worker health and serverless GPU-ledger guards exist only for our
 * private endpoint. The public endpoint has fixed per-image pricing and does
 * not expose the custom `/health` contract to account API keys. */
export function usesCustomRunpodEndpoint(route: unknown): route is "runpod-custom" {
  return route === "runpod-custom";
}

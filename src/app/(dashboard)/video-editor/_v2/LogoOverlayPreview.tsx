"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  logoOverlayFrame,
  normalizeLogoOverlayConfig,
  type BrandAssetView,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";

export function LogoOverlayPreview({
  value,
  asset,
}: {
  value: LogoOverlayConfig | undefined;
  asset: BrandAssetView | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const config = useMemo(() => normalizeLogoOverlayConfig(value), [value]);
  const visible = !!(
    config?.enabled
    && asset
    && asset.id === config.assetId
    && asset.imageUrl
  );

  useEffect(() => {
    if (!visible) return;
    const element = containerRef.current;
    if (!element) return;

    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setFrameSize((current) => {
        if (current.width === bounds.width && current.height === bounds.height) {
          return current;
        }
        return { width: bounds.width, height: bounds.height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  if (!visible || !config || !asset) return null;

  const box = logoOverlayFrame({
    position: config.position,
    sizePct: config.sizePct,
    intrinsic: { width: asset.width, height: asset.height },
    frameWidth: frameSize.width,
    frameHeight: frameSize.height,
  });

  return (
    <div
      ref={containerRef}
      data-logo-overlay-preview="true"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        aspectRatio: "9 / 16",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      {frameSize.width > 0 && frameSize.height > 0 && (
        // This owner-checked metadata URL is intentionally the only preview source.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.imageUrl}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            objectFit: "contain",
            opacity: config.opacity,
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      )}
    </div>
  );
}

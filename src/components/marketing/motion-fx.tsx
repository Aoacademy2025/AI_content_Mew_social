"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/**
 * Editorial rise-and-resolve entrance. Reduced-motion visitors get the same
 * content and hierarchy with no spatial movement.
 */
export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (reduceMotion || !ref.current) return;
    const element = ref.current;
    const rect = element.getBoundingClientRect();
    const initiallyVisible = rect.bottom >= 80 && rect.top <= window.innerHeight - 80;

    // Keep above-the-fold SSR content visible. Only elements that start outside
    // the viewport are hidden, then revealed once when they enter.
    if (initiallyVisible) return;
    setWaiting(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setWaiting(false);
        observer.disconnect();
      },
      { rootMargin: "-80px 0px", threshold: 0.08 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduceMotion]);

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={false}
      animate={reduceMotion || !waiting
        ? { opacity: 1, y: 0, filter: "blur(0px)" }
        : { opacity: 0, y, filter: "blur(8px)" }}
      data-reveal-y={y}
      data-reveal-state={waiting ? "waiting" : "visible"}
      transition={waiting
        ? { duration: 0 }
        : { duration: 0.72, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Hero product card 3D scroll tilt: the card starts tilted back + scaled down
 * and flattens / scales to full as it scrolls toward the viewport center.
 */
export function ContainerScroll({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [18, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setIsCompactViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return (
    <div ref={ref} className={cn("[perspective:1400px]", className)}>
      <motion.div style={reduceMotion || isCompactViewport ? undefined : { rotateX, scale, transformOrigin: "center 30%" }} className="will-change-transform">
        {children}
      </motion.div>
    </div>
  );
}

/**
 * Card with a violet spotlight that follows the cursor on hover.
 */
export function SpotlightCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [show, setShow] = useState(false);
  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      className={cn("relative overflow-hidden", className)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: show ? 1 : 0,
          background: `radial-gradient(260px circle at ${pos.x}px ${pos.y}px, rgba(139,92,246,.18), transparent 70%)`,
        }}
      />
      {children}
    </div>
  );
}

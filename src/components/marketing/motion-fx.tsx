"use client";

import { useRef, useState, type ReactNode } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

const EASE: [number, number, number, number] = [0.21, 0.6, 0.35, 1];

/**
 * Content stays visible in the server-rendered first paint. Motion only settles
 * an element into its natural position when it enters the viewport, so a
 * stalled observer or disabled JavaScript never hides marketing content.
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
  return (
    <motion.div
      className={className}
      initial={false}
      whileInView={{ opacity: 1, y: 0 }}
      data-reveal-y={y}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.65, delay, ease: EASE }}
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
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [18, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);
  return (
    <div ref={ref} className={cn("[perspective:1400px]", className)}>
      <motion.div style={{ rotateX, scale, transformOrigin: "center 30%" }} className="will-change-transform">
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

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "featured" | "glass" | "elevated";

interface PremiumCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  interactive?: boolean;
  as?: keyof React.JSX.IntrinsicElements;
}

const variantClass: Record<Variant, string> = {
  default:
    "bg-[var(--ui-card-bg)] border border-[var(--ui-card-border)] " +
    "shadow-[var(--shadow-md)] " +
    "hover:border-white/10 hover:shadow-[var(--shadow-lg)]",
  elevated:
    "bg-[var(--ui-card-bg)] border border-[var(--ui-card-border)] " +
    "shadow-[var(--shadow-lg)] " +
    "hover:border-white/12 hover:shadow-[var(--shadow-xl)]",
  glass: "premium-glass",
  featured: "premium-card-featured",
};

export const PremiumCard = React.forwardRef<HTMLDivElement, PremiumCardProps>(
  ({ variant = "default", interactive, className, children, as = "div", ...props }, ref) => {
    const Element = as as React.ElementType;
    return (
      <Element
        ref={ref}
        className={cn(
          "relative rounded-2xl transition-[box-shadow,border-color,transform] duration-300 ease-out",
          interactive && "cursor-pointer hover:-translate-y-0.5 active:translate-y-0",
          variantClass[variant],
          className,
        )}
        {...props}
      >
        {children}
      </Element>
    );
  }
);
PremiumCard.displayName = "PremiumCard";

// ── Card sub-components for consistency ─────────────────────────────────────

export function PremiumCardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pb-4", className)} {...props} />;
}

export function PremiumCardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 py-4", className)} {...props} />;
}

export function PremiumCardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pt-4 border-t border-white/5", className)} {...props} />;
}

interface PremiumCardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  eyebrow?: string;
  description?: string;
}

export function PremiumCardTitle({ eyebrow, description, className, children, ...props }: PremiumCardTitleProps) {
  return (
    <div className="space-y-1.5">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h3 className={cn("text-lg font-semibold tracking-tight text-[var(--ui-text-primary)]", className)} {...props}>
        {children}
      </h3>
      {description && <p className="text-sm text-[var(--ui-text-muted)]">{description}</p>}
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface PremiumButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const sizeMap: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-md",
  md: "h-10 px-4 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-sm gap-2 rounded-lg",
};

const variantMap: Record<Variant, string> = {
  primary:
    "text-white bg-gradient-to-br from-[hsl(var(--accent-primary))] to-[hsl(var(--accent-secondary))] " +
    "border border-[hsl(var(--accent-primary)/0.4)] " +
    "shadow-[var(--shadow-glow-primary),0_1px_0_hsl(0_0%_100%/0.12)_inset] " +
    "hover:brightness-110 hover:shadow-[0_12px_32px_hsl(var(--accent-primary)/0.35),0_1px_0_hsl(0_0%_100%/0.15)_inset] " +
    "active:scale-[0.98]",
  secondary:
    "text-[var(--ui-text-secondary)] bg-white/4 border border-white/8 " +
    "hover:bg-white/7 hover:border-white/14 hover:text-[var(--ui-text-primary)] " +
    "active:scale-[0.98]",
  ghost:
    "text-[var(--ui-text-secondary)] bg-transparent border border-transparent " +
    "hover:bg-white/5 hover:text-[var(--ui-text-primary)] " +
    "active:scale-[0.98]",
  danger:
    "text-white bg-gradient-to-br from-red-500 to-red-600 " +
    "border border-red-500/40 shadow-[0_8px_24px_rgba(239,68,68,0.25),0_1px_0_hsl(0_0%_100%/0.12)_inset] " +
    "hover:brightness-110 active:scale-[0.98]",
};

export const PremiumButton = React.forwardRef<HTMLButtonElement, PremiumButtonProps>(
  ({ variant = "primary", size = "md", loading, disabled, icon, iconRight, className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center font-semibold tracking-tight",
          "transition-[transform,box-shadow,background,border-color,color,filter] duration-200 ease-out",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(240_10%_4%)] focus-visible:ring-[hsl(var(--accent-primary)/0.6)]",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:hover:scale-100",
          sizeMap[size],
          variantMap[variant],
          className,
        )}
        {...props}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
        {children}
        {!loading && iconRight}
      </button>
    );
  }
);
PremiumButton.displayName = "PremiumButton";

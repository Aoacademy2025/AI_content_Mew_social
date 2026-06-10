"use client"

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none select-none items-center", className)}
    {...props}
  >
    <SliderPrimitive.Track
      className="relative h-1 w-full grow overflow-hidden rounded-full"
      style={{ background: "hsl(220 30% 18%)" }}
    >
      <SliderPrimitive.Range
        className="absolute h-full rounded-full"
        style={{ background: "linear-gradient(90deg, hsl(190 100% 42%), hsl(230 100% 55%))" }}
      />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className="block h-3.5 w-3.5 rounded-full shadow-lg transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 hover:scale-110"
      style={{
        background: "hsl(0 0% 100%)",
        border: "2px solid hsl(190 100% 50%)",
        boxShadow: "0 0 0 3px hsl(190 100% 50% / 0.15)",
      }}
    />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }

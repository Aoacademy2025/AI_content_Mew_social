"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Inline Brand Name header — always visible at the top of Brand Kit Studio,
 *  never buried inside an accordion and never requiring typed input before save. */
export function BrandBasicsForm({
  name,
  onNameChange,
  disabled,
  statusBadge,
}: {
  name: string;
  onNameChange: (value: string) => void;
  disabled?: boolean;
  statusBadge?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="brand-name" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          ชื่อแบรนด์
        </Label>
        {statusBadge ? (
          <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {statusBadge}
          </span>
        ) : null}
      </div>
      <Input
        id="brand-name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="เช่น Mew Social"
        maxLength={80}
        disabled={disabled}
        autoComplete="off"
        className="h-12 text-base font-semibold tracking-tight"
      />
    </div>
  );
}

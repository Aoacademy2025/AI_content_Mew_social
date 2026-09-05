"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Optional rename. The setup flow supplies a valid name before this is opened. */
export function BrandBasicsForm({
  name,
  onNameChange,
  disabled,
}: {
  name: string;
  onNameChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="max-w-md">
      <Label htmlFor="brand-name" className="text-sm font-semibold">
        ชื่อแบรนด์
      </Label>
      <Input
        id="brand-name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="เช่น Mew Social"
        maxLength={80}
        disabled={disabled}
        autoComplete="off"
        className="mt-2 h-11"
      />
    </div>
  );
}

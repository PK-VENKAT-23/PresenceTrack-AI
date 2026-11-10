import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrandMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-xl bg-gradient-to-br from-success to-primary text-primary-foreground shadow-lg",
        size === "lg" ? "h-12 w-12" : "h-9 w-9",
      )}
    >
      <ShieldCheck className={size === "lg" ? "h-6 w-6" : "h-5 w-5"} strokeWidth={2} />
    </div>
  );
}

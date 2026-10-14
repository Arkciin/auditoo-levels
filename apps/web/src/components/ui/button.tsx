import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Touch-first: 44 px minimum targets, a pressed state (hover does not exist on touch screens),
// no shadows. Keyboard focus uses the global :focus-visible ring from styles.css.
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
        outline: "border border-input bg-card text-foreground hover:bg-muted active:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
        ghost: "text-foreground hover:bg-muted active:bg-muted",
        link: "text-primary underline-offset-4 hover:underline active:underline",
      },
      size: {
        default: "h-11 px-4 text-base has-[>svg]:px-3.5",
        // Compact look (36 px) with an invisible 44 px hit area.
        sm: "h-9 gap-1.5 px-3 text-sm after:absolute after:inset-x-0 after:-inset-y-1 has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-12 px-6 text-lg has-[>svg]:px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

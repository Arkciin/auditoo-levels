import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge, taught the custom theme values of styles.css so they override correctly. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      container: ["app"],
      shadow: ["drag"],
      spacing: ["action-bar"],
    },
    classGroups: {
      pt: [{ pt: ["safe"] }],
      pb: [{ pb: ["safe"] }],
      px: [{ px: ["safe"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

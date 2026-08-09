import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a number as GBP currency. */
export function formatGBP(value: number, options?: { decimals?: boolean }) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: options?.decimals ? 2 : 0,
    maximumFractionDigits: options?.decimals ? 2 : 0,
  }).format(value)
}

/** Format a number with thousands separators. */
export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-GB").format(value)
}

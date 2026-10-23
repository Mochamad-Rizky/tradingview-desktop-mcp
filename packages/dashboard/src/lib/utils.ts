import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Joins class names, and lets a later Tailwind class win over an earlier one it conflicts with.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import { listCategories } from "./db.js";
import type { CategoryConfig } from "./types.js";

export function getCategory(categoryId: string): CategoryConfig {
  const categories = listCategories();
  const found = categories.find((c) => c.id === categoryId);
  if (found) return found;
  const fallback = categories.find((c) => c.id === "autre");
  if (fallback) return fallback;
  throw new Error(`Categorie inconnue: ${categoryId}, et aucune categorie "autre" de repli.`);
}

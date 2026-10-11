/** Resource sorting shared by native tables and preview fixtures. Unknown values stay last. */
export type SortDirection = "asc" | "desc";
export interface ResourceSort<Id extends string> { id: Id; direction: SortDirection }
export function nextResourceSort<Id extends string>(current: ResourceSort<Id>, id: Id): ResourceSort<Id> {
  return { id, direction: current.id === id ? (current.direction === "desc" ? "asc" : "desc") : id === "name" ? "asc" : "desc" };
}
export function compareResource(a: number | string | null, b: number | string | null, direction: SortDirection): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const value = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
  return direction === "asc" ? value : -value;
}
export const matchesResource = (query: string, values: readonly (string | null | undefined)[]) => {
  const needle = query.trim().toLowerCase().slice(0, 120);
  return !needle || values.some((value) => value?.toLowerCase().includes(needle));
};

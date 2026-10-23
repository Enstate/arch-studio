import { Button } from "@arch/ui/components/button";
import { Input } from "@arch/ui/components/input";
import { Spinner } from "@arch/ui/components/spinner";
import { useMutation } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { useStudioLocale } from "../lib/locale";
import type { studioText } from "../lib/messages";
import { pastedLocation, type ProjectLocation } from "../lib/project-location";
import { findLocation } from "../lib/server";
import { StudioFailure } from "./studio-failure";

type Copy = typeof studioText.en;

/**
 * Finds places only when asked, with Enter or the Search button, never while typing, as
 * OpenStreetMap's policy requires. Pasted coordinates and map links never leave the computer.
 */
export function useLocationSearch() {
  const {locale} = useStudioLocale();
  const [query, setQuery] = useState("");
  const places = useMutation({mutationFn: async (text: string): Promise<ProjectLocation[]> => {
    const pasted = pastedLocation(text);
    return pasted ? [pasted] : findLocation({data: {query: text, locale}});
  }});
  const search = () => {const text = query.trim(); if (text.length >= 2 && !places.isPending) places.mutate(text);};
  return {query, setQuery, search, places};
}
export type LocationSearch = ReturnType<typeof useLocationSearch>;

/** The search field and its outcome. Each caller lists the places it found its own way. */
export function LocationSearchBar({id, search, disabled, t}: {id: string; search: LocationSearch; disabled?: boolean; t: Copy}) {
  const {places} = search;
  return <div className="grid gap-2">
    <div className="flex gap-2">
      <Input id={id} type="search" aria-label={t.locationLabel} value={search.query} onChange={event => search.setQuery(event.target.value)} onKeyDown={event => {if (event.key === "Enter" && !event.nativeEvent.isComposing) {event.preventDefault(); search.search();}}} placeholder={t.locationPlaceholder} autoComplete="off" maxLength={240} disabled={disabled} className="min-w-0 flex-1" />
      <Button type="button" variant="outline" disabled={disabled || places.isPending || search.query.trim().length < 2} onClick={search.search}>{places.isPending ? <Spinner /> : <SearchIcon />}{places.isPending ? t.locationSearching : t.locationFind}</Button>
    </div>
    {places.error && <StudioFailure className="text-xs text-destructive" error={places.error} />}
    {places.data?.length === 0 && <p role="status" className="text-xs text-muted-foreground">{t.locationNotFound}</p>}
  </div>;
}

/** The shape of a German message object with every text widened, so a translation must have the same keys and arguments. */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R extends string ? string : R
      : T[K] extends readonly (infer U)[]
        ? readonly (U extends string ? string : Translation<U>)[]
        : Translation<T[K]>;
};

export type ViewerProject = {
  id: string;
  artifactId?: string;
  publishedVersionId?: string;
  assetBase?: string;
  outputs?: { id: string; kind: string; label: string; url: string }[];
  name: string;
  planUrl: string | null;
  posterUrl?: string | null;
  status: "processing" | "ready";
};

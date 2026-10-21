const agents = new Set<() => Promise<void>>();
let stopping: Promise<void> | undefined;

export function ownAgent(stop: () => Promise<void>): () => void {
  if (stopping) throw new Error("Agent shutdown is in progress.");
  agents.add(stop);
  return () => {
    agents.delete(stop);
  };
}

export function stopAgents(): Promise<void> {
  if (stopping) return stopping;
  stopping = Promise.allSettled([...agents].map((stop) => stop()))
    .then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Failed to stop agent processes.");
    })
    .finally(() => {
      stopping = undefined;
    });
  return stopping;
}

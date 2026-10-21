import type { DesignOption, Furniture, Plan } from './schema.ts';

/** The option a viewer opens with: the one marked default, else the first; none for a plan without options. */
export function defaultDesignOption(plan: Plan): DesignOption | undefined {
  return plan.designOptions?.find((o) => o.default) ?? plan.designOptions?.[0];
}

/** Whether a piece is part of an option's look: shared pieces are in every option. */
export function shownInOption(piece: Pick<Furniture, 'designOptions'>, option: string | null) {
  return !piece.designOptions || (option !== null && piece.designOptions.includes(option));
}

import * as Context from "effect/Context";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@t3tools/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

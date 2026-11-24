// Paper bot for the Pump.fun Replay Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`: hello arrives first, then one batch per
// slot, and this process answers each batch with its orders. The strategy is in
// strategy.ts; the protocol shim is vendored in vendor/makefun-bot.ts.

import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy, DEFAULT_PARAMS } from "./strategy.ts";

// Revision: keep the entrypoint a thin shell so every trading decision stays
// in strategy.ts, where the transcript checks can follow it.
await runBot(createStrategy(DEFAULT_PARAMS));

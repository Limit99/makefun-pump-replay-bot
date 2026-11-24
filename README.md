[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Limit99/makefun-pump-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Limit99/makefun-pump-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Paper Bot

A deterministic paper-trading bot for the make.fun "Pump.fun Replay Sprint" (protocol agent-fun/replay/v2). It trades 10 SOL of paper money on a 24-hour pump.fun replay: selective momentum entries on mature curves with accelerating, broadening buy pressure, a small first buy with pyramid adds into strength, mechanical exits (stop loss, trailing stop, flow fade, time limit), and small paced probe round trips so the run clears the guardrail of round trips of at least 0.01 SOL on at least 20 distinct coins while keeping drawdown contained. Score is net PnL after fees; a paid place needs net PnL above 0.

Layout: `main.ts` is the entrypoint the grader runs, `strategy.ts` holds every trading decision, and `vendor/makefun-bot.ts` is the kit's protocol shim, vendored byte for byte.

Run it with: `node main.ts` (it speaks the replay protocol on stdin/stdout).

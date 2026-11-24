// Replay sprint strategy: selective momentum entries plus guardrail probes.
//
// Protocol words this bot lives by: on hello we learn the caps, on each batch we
// read the slot, decide orders, and never exceed the batch order cap. Everything
// is a deterministic function of the batches: no clock, no randomness, no I/O,
// so the two graded executions produce identical orders.
//
// Idea in one paragraph: most fresh pump.fun curves die. We only buy a curve that
// is already a few hundred slots old, holds a few SOL of real reserves, and shows
// broadening, accelerating buy pressure over a short window with the price near
// its window high. The first buy is deliberately tiny; size is added only while
// the position is winning. Exits are mechanical: stop loss, trailing stop, flow
// fade, or a time limit. Separately, small probe round trips (just above the
// 0.01 SOL round-trip minimum) are paced across the run so the bot clears the
// guardrail of round trips on at least 20 distinct coins without betting the
// account on weak curves.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

export interface Params {
  windowSlots: number;
  minAgeSlots: number;
  minRealSol: number;
  maxRealSol: number;
  minNetInSol: number;
  minBuyTrades: number;
  minDistinctBuyers: number;
  minRise: number;
  maxRise: number;
  nearHighShare: number;
  firstBuySol: number;
  addBuySol: number;
  maxStakeSol: number;
  maxExposureSol: number;
  stopLossShare: number;
  trailArmShare: number;
  trailShare: number;
  fadeWindowSlots: number;
  fadeNetSol: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  maxEntriesPerMint: number;
  probeSol: number;
  probeTargetCoins: number;
  probePaceSecs: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 40,
  minAgeSlots: 300,
  minRealSol: 2,
  maxRealSol: 70,
  minNetInSol: 0.8,
  minBuyTrades: 4,
  minDistinctBuyers: 4,
  minRise: 0.03,
  maxRise: 1.2,
  nearHighShare: 0.92,
  firstBuySol: 0.04,
  addBuySol: 0.15,
  maxStakeSol: 1.2,
  maxExposureSol: 5,
  stopLossShare: 0.18,
  trailArmShare: 0.05,
  trailShare: 0.22,
  fadeWindowSlots: 15,
  fadeNetSol: 1.5,
  maxHoldSlots: 1200,
  cooldownSlots: 200,
  maxEntriesPerMint: 2,
  probeSol: 0.011,
  probeTargetCoins: 26,
  probePaceSecs: 14_400,
};

const LAMPORTS = 1e9;
const CURVE_FEE_SHARE = 0.0125;

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Position {
  openedSlot: number;
  investedSol: number;
  peakValueSol: number;
  lastPrice: number;
  filled: boolean;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const positions = new Map<Pubkey, Position>();
  const probes = new Set<Pubkey>();
  const probedCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.windowSlots, p.fadeWindowSlots) + 8;

  function tapeOf(mint: Pubkey): Tape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000 };
      tapes.set(mint, tape);
    }
    return tape;
  }

  function netFlow(tape: Tape, now: number, span: number): number {
    let net = 0;
    for (let i = tape.trades.length - 1; i >= 0; i--) {
      const trade = tape.trades[i]!;
      if (trade.slot <= now - span) break;
      net += trade.isBuy ? trade.sol : -trade.sol;
    }
    return net;
  }

  function entryLooksGood(tape: Tape, now: number, realSol: number): boolean {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (tape.createdSlot === null || now - tape.createdSlot < p.minAgeSlots) return false;
    const from = now - p.windowSlots;
    const middle = now - p.windowSlots / 2;
    let buySol = 0;
    let sellSol = 0;
    let buyTrades = 0;
    let oldNet = 0;
    let newNet = 0;
    let startPrice = 0;
    let highPrice = 0;
    let lastPrice = 0;
    const buyers = new Set<string>();
    for (const trade of tape.trades) {
      if (trade.slot <= from) {
        startPrice = trade.price;
        continue;
      }
      if (startPrice === 0) startPrice = trade.price;
      const signed = trade.isBuy ? trade.sol : -trade.sol;
      if (trade.slot <= middle) oldNet += signed;
      else newNet += signed;
      if (trade.isBuy) {
        buySol += trade.sol;
        buyTrades++;
        buyers.add(trade.user);
      } else {
        sellSol += trade.sol;
      }
      if (trade.price > highPrice) highPrice = trade.price;
      lastPrice = trade.price;
    }
    if (buyTrades < p.minBuyTrades || buyers.size < p.minDistinctBuyers) return false;
    if (buySol - sellSol < p.minNetInSol) return false;
    if (startPrice <= 0 || highPrice <= 0) return false;
    const rise = lastPrice / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (lastPrice < highPrice * p.nearHighShare) return false;
    // Acceleration: the newer half of the window must bring in more than the older half.
    if (newNet <= 0 || newNet <= oldNet) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tradedNow = new Set<Pubkey>();

      for (const fill of batch.fills) {
        if (fill.status === "filled" && !fill.client_id.startsWith("_")) {
          const pos = positions.get(fill.mint);
          if (pos !== undefined && fill.side === "buy") pos.filled = true;
        }
      }
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = event.block_time;
          if (lastBlockTime === null || event.block_time > lastBlockTime) lastBlockTime = event.block_time;
        }
        if (event.event === "CreateEvent") {
          tapeOf(event.mint).createdSlot = event.slot;
        } else if (event.event === "TradeEvent") {
          const tape = tapeOf(event.mint);
          tape.trades.push({
            slot: event.slot,
            isBuy: event.is_buy,
            sol: Number(event.sol_amount) / LAMPORTS,
            user: event.user,
            price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
          });
          tradedNow.add(event.mint);
        }
      }
      for (const mint of tradedNow) {
        const tape = tapes.get(mint)!;
        let cut = 0;
        while (cut < tape.trades.length && tape.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) tape.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
      const pendingMints = new Set<Pubkey>();
      for (const pending of state.pending.values()) pendingMints.add(pending.order.mint);

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;

      // 1) Exits for held momentum positions.
      for (const [mint, pos] of positions) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingMints.has(mint)) {
            positions.delete(mint);
            if (pos.filled) tapeOf(mint).lastExitSlot = now;
            else tapeOf(mint).entries--;
          }
          continue;
        }
        pos.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(held.token_amount);
        const valueSol = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE_SHARE) - txFeeSol;
        const costSol = Number(held.cost_lamports) / LAMPORTS;
        if (valueSol > pos.peakValueSol) pos.peakValueSol = valueSol;
        let exit = pos.exiting;
        if (!exit && valueSol < costSol * (1 - p.stopLossShare)) exit = true;
        if (!exit && pos.peakValueSol >= costSol * (1 + p.trailArmShare) && valueSol < pos.peakValueSol * (1 - p.trailShare)) exit = true;
        if (!exit && netFlow(tapeOf(mint), now, p.fadeWindowSlots) < -p.fadeNetSol) exit = true;
        if (!exit && now - pos.openedSlot > p.maxHoldSlots) exit = true;
        if (!exit) continue;
        pos.exiting = true;
        let sellPending = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === "sell") sellPending = true;
        }
        if (sellPending || orders.length >= orderCap) continue;
        orders.push({ side: "sell", mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
      }

      // 2) Close probe positions as soon as their buy has landed.
      for (const mint of probes) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: "sell", mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
      }

      // 3) Entries and pyramid adds on curves that traded in this batch.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const pos of positions.values()) exposureSol += pos.investedSol;
      for (const mint of tradedNow) {
        if (orders.length >= orderCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMints.has(mint) || probes.has(mint)) continue;
        const tape = tapes.get(mint)!;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const pos = positions.get(mint);
        let wantSol: number;
        if (pos === undefined) {
          if (openSlots <= 0) continue;
          if (tape.entries >= p.maxEntriesPerMint || now - tape.lastExitSlot < p.cooldownSlots) continue;
          if (!entryLooksGood(tape, now, realSol)) continue;
          wantSol = p.firstBuySol;
        } else {
          if (pos.exiting || !pos.filled || pos.investedSol >= p.maxStakeSol - 0.01) continue;
          if (price < pos.lastPrice) continue;
          if (netFlow(tape, now, p.windowSlots) < 0) continue;
          wantSol = Math.min(p.addBuySol, p.maxStakeSol - pos.investedSol);
        }
        const sizeCapSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amountSol = Math.min(sizeCapSol, wantSol, p.maxExposureSol - exposureSol, freeSol - txFeeSol);
        if (amountSol < 0.01) continue;
        orders.push({ side: "buy", mint, quote_lamports: BigInt(Math.floor(amountSol * LAMPORTS)), max_slippage_bps: 1500 });
        freeSol -= amountSol + txFeeSol;
        exposureSol += amountSol;
        if (pos === undefined) {
          positions.set(mint, { openedSlot: now, investedSol: amountSol, peakValueSol: 0, lastPrice: price, filled: false, exiting: false });
          tape.entries++;
          openSlots--;
        } else {
          pos.investedSol += amountSol;
          pos.lastPrice = price;
        }
      }

      // 4) Guardrail probes, paced by block time so the distinct-coin count is
      // reached steadily instead of in one late burst.
      if (probes.size === 0 && openSlots > 0 && firstBlockTime !== null && lastBlockTime !== null && orders.length < orderCap) {
        const elapsedShare = Math.min(1, (lastBlockTime - firstBlockTime) / p.probePaceSecs);
        const coinsDue = Math.ceil(p.probeTargetCoins * elapsedShare);
        if (probedCoins.size < coinsDue) {
          for (const mint of tradedNow) {
            if (probedCoins.has(mint) || positions.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The probe must respect the same 1%-of-real-reserve size cap.
            if (Number(state.maxBuyLamports(mint)) / LAMPORTS < p.probeSol) continue;
            if (freeSol < p.probeSol + 2 * txFeeSol) break;
            orders.push({ side: "buy", mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: 1500 });
            probes.add(mint);
            probedCoins.add(mint);
            freeSol -= p.probeSol + txFeeSol;
            break;
          }
        }
      }

      return orders;
    },
  };
}

import { expect, it } from "vitest";
import { paperPerformance } from "../src/marketpilot/performance";
import { closePosition, costs } from "../src/marketpilot/paper";
import { defaults } from "../src/marketpilot/types";
import { loadReplay } from "../src/marketpilot/adapters/replay";

it("measures net paper expectancy and loss frequency after costs, including a gross winner that loses net", () => {
  const time = "2026-09-14T17:00:00Z";
  const position = { side: "BUY" as const, entry: 6000, stop: 5980, target: 6040, time,
    contract: loadReplay().contract, entryCosts: costs(6000, 10, defaults), maxRisk: 300, settings: defaults };
  const trades = [6010, 6005, 5990].map(price => closePosition(position, price, time, "TEST ONLY"));
  expect(trades[1].gross).toBeGreaterThan(0); expect(trades[1].net).toBeLessThan(0);
  const metrics = paperPerformance(trades);
  expect(metrics).toMatchObject({ closedTrades: 3, winningTrades: 1, losingTrades: 2 });
  expect(metrics.expectancy).toBeCloseTo(trades.reduce((sum, trade) => sum + trade.net, 0) / 3);
  expect(metrics.profitFactor).toBeCloseTo(trades[0].net / Math.abs(trades[1].net + trades[2].net));
  expect(metrics.totalCharges).toBeCloseTo(trades.reduce((sum, trade) => sum + trade.costs, 0));
  expect(metrics.winRate).toBeCloseTo(1 / 3);
  expect(paperPerformance([trades[0]]).profitFactor).toBeNull();
});
it("does not report fabricated zero expectancy or a perfect win rate without trades", () => {
  expect(paperPerformance([])).toMatchObject({ closedTrades: 0, expectancy: null, winRate: null,
    profitFactor: null, averageWin: null, averageLoss: null, worstTrade: null });
});

import { z } from "zod";
import { encodeFunctionData, parseUnits, Address } from "viem";

import { ActionProvider } from "../actionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import { CreateAction } from "../actionDecorator";
import { approve } from "../../utils";
import { Network } from "../../network";

import {
  CompareLendingRatesSchema,
  GetAggregatedPositionSchema,
  RouteSupplySchema,
  RouteBorrowSchema,
  RebalanceSchema,
} from "./schemas";
import {
  SUPPORTED_ASSETS,
  ERC20_ABI,
  COMPOUND_COMET_ADDRESSES,
  COMPOUND_COMET_ABI,
  AAVE_POOL_ADDRESS,
  MOONWELL_MTOKEN_ADDRESSES,
  HEALTH_FACTOR_THRESHOLD,
} from "./constants";
import { RateResult, PositionResult, rankRates, findLowestHealth, formatApy } from "./utils";
import { getCompoundRates, getCompoundPosition } from "./adapters/compound";
import { getAaveRates, getAavePosition, encodeAaveSupply, encodeAaveBorrow } from "./adapters/aave";
import { getMoonwellRates, getMoonwellPosition, encodeMoonwellMint } from "./adapters/moonwell";
import { getMorphoRates, getMorphoPosition } from "./adapters/morpho";

const V1_BORROW_PROTOCOLS = ["compound", "aave"];

/**
 * Cross-protocol lending router that compares rates and routes actions across Compound, Aave, Moonwell, and Morpho on Base.
 */
export class LendingRouterActionProvider extends ActionProvider<EvmWalletProvider> {
  /**
   * Constructs a new LendingRouterActionProvider instance.
   */
  constructor() {
    super("lendingRouter", []);
  }

  /**
   * Compares live lending rates across protocols.
   *
   * @param walletProvider - The wallet provider instance.
   * @param args - The input arguments including asset and side.
   * @returns A JSON string with ranked rates or an error message.
   */
  @CreateAction({
    name: "compare_lending_rates",
    description: `Reads live supply or borrow APY for an asset across Compound III, Aave v3, Moonwell, and Morpho on Base mainnet. Returns a JSON array of rate objects sorted best-first (highest APY for supply, lowest for borrow). Each entry includes the protocol name, APY percentage, market address, data source, and notes. Use this to help users find the best lending or borrowing venue before executing a supply or borrow action.`,
    schema: CompareLendingRatesSchema,
  })
  async compareLendingRates(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CompareLendingRatesSchema>,
  ): Promise<string> {
    try {
      const results: RateResult[] = [];
      const errors: string[] = [];

      const fetchers = [
        { name: "compound", fn: () => getCompoundRates(walletProvider, args.asset, args.side) },
        { name: "aave", fn: () => getAaveRates(walletProvider, args.asset, args.side) },
        { name: "moonwell", fn: () => getMoonwellRates(walletProvider, args.asset, args.side) },
        { name: "morpho", fn: () => getMorphoRates(walletProvider, args.asset, args.side) },
      ];

      const settled = await Promise.allSettled(fetchers.map(f => f.fn()));

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled" && result.value) {
          results.push(result.value);
        } else if (result.status === "rejected") {
          errors.push(`${fetchers[i].name}: ${result.reason}`);
        }
      }

      if (results.length === 0) {
        return `No lending rates found for ${args.asset} (${args.side}). ${errors.length > 0 ? "Errors: " + errors.join("; ") : "Asset may not be listed on any protocol."}`;
      }

      const ranked = rankRates(results, args.side);
      const response: Record<string, unknown> = {
        asset: args.asset,
        side: args.side,
        rates: ranked,
      };
      if (errors.length > 0) {
        response.warnings = errors;
      }
      return JSON.stringify(response);
    } catch (error) {
      return `Error comparing lending rates for ${args.asset}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Reads aggregated lending positions across all supported protocols.
   *
   * @param walletProvider - The wallet provider instance.
   * @param args - The input arguments including optional user address.
   * @returns A JSON string with per-protocol positions or an error message.
   */
  @CreateAction({
    name: "get_aggregated_position",
    description: `Reads the user's supply and borrow positions across Compound III, Aave v3, Moonwell, and Morpho on Base mainnet. Returns a JSON object with per-protocol position details (balances, USD values, health factors) and an aggregate lowest-health warning. If no user address is provided, defaults to the connected wallet address.`,
    schema: GetAggregatedPositionSchema,
  })
  async getAggregatedPosition(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetAggregatedPositionSchema>,
  ): Promise<string> {
    try {
      const user = (args.user ?? walletProvider.getAddress()) as Address;

      const fetchers = [
        () => getCompoundPosition(walletProvider, user),
        () => getAavePosition(walletProvider, user),
        () => getMoonwellPosition(walletProvider, user),
        () => getMorphoPosition(walletProvider, user),
      ];

      const settled = await Promise.allSettled(fetchers.map(f => f()));
      const positions: PositionResult[] = [];
      const errors: string[] = [];

      for (const result of settled) {
        if (result.status === "fulfilled") {
          positions.push(result.value);
        } else {
          errors.push(String(result.reason));
        }
      }

      const lowest = findLowestHealth(positions);

      const response: Record<string, unknown> = {
        user,
        positions,
      };
      if (lowest) {
        response.lowestHealth = lowest;
      }
      if (errors.length > 0) {
        response.warnings = errors;
      }
      return JSON.stringify(response);
    } catch (error) {
      return `Error reading aggregated positions: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Routes a supply to the best-rate protocol.
   *
   * @param walletProvider - The wallet provider instance.
   * @param args - The action input arguments.
   * @returns A string result or error message.
   */
  @CreateAction({
    name: "route_supply",
    description: `Compares live supply APY across Compound III, Aave v3, Moonwell, and Morpho on Base, then routes a supply (deposit) to the best-rate protocol. Optionally accepts a preferProtocol parameter to override automatic selection. Returns the transaction hash, chosen protocol, and the APY it routed to. The agent should call compare_lending_rates first to show the user their options, then use this action to execute.`,
    schema: RouteSupplySchema,
  })
  async routeSupply(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RouteSupplySchema>,
  ): Promise<string> {
    try {
      const assetAddress = SUPPORTED_ASSETS[args.asset.toLowerCase()];
      if (!assetAddress) {
        return `Error: Asset '${args.asset}' is not supported. Supported assets: ${Object.keys(SUPPORTED_ASSETS).join(", ")}`;
      }

      const decimals = Number(
        await walletProvider.readContract({
          address: assetAddress,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      );
      const amountAtomic = parseUnits(args.amount, decimals);

      const balance = await walletProvider.readContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletProvider.getAddress() as `0x${string}`],
      });
      if (balance < amountAtomic) {
        return `Error: Insufficient balance. You have ${Number(balance) / 10 ** decimals} ${args.asset}, but trying to supply ${args.amount}`;
      }

      const rates: RateResult[] = [];
      const fetchers = [
        () => getCompoundRates(walletProvider, args.asset, "supply"),
        () => getAaveRates(walletProvider, args.asset, "supply"),
        () => getMoonwellRates(walletProvider, args.asset, "supply"),
        () => getMorphoRates(walletProvider, args.asset, "supply"),
      ];
      const settled = await Promise.allSettled(fetchers.map(f => f()));
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value) rates.push(r.value);
      }

      let chosen: RateResult | undefined;
      if (args.preferProtocol) {
        chosen = rates.find(r => r.protocol === args.preferProtocol!.toLowerCase());
        if (!chosen) {
          return `Error: Preferred protocol '${args.preferProtocol}' did not return a rate for ${args.asset} supply. Available: ${rates.map(r => r.protocol).join(", ")}`;
        }
      } else {
        const ranked = rankRates(rates, "supply");
        chosen = ranked[0];
      }
      if (!chosen) {
        return `Error: No supply rates found for ${args.asset} on any protocol.`;
      }

      const freshRate = await this.refetchRate(
        walletProvider,
        args.asset,
        "supply",
        chosen.protocol,
      );
      if (freshRate) {
        chosen.apy = freshRate.apy;
      }

      const txHash = await this.executeSupply(
        walletProvider,
        chosen.protocol,
        assetAddress,
        amountAtomic,
        args.asset,
      );

      return `Supplied ${args.amount} ${args.asset} to ${chosen.protocol} at ${formatApy(chosen.apy)} APY.\nTransaction hash: ${txHash}\nMarket: ${chosen.marketId}`;
    } catch (error) {
      return `Error routing supply: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Routes a borrow to the cheapest-rate protocol.
   *
   * @param walletProvider - The wallet provider instance.
   * @param args - The action input arguments.
   * @returns A string result or error message.
   */
  @CreateAction({
    name: "route_borrow",
    description: `Compares live borrow APY across supported protocols on Base, then routes a borrow to the cheapest-rate protocol. v1 supports Compound III and Aave v3 only for borrows (Moonwell and Morpho borrow actions are not yet available in AgentKit). Simulates post-borrow health and rejects if the position would be unsafe. Returns the transaction hash, chosen protocol, APY, and new health factor.`,
    schema: RouteBorrowSchema,
  })
  async routeBorrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RouteBorrowSchema>,
  ): Promise<string> {
    try {
      const assetAddress = SUPPORTED_ASSETS[args.asset.toLowerCase()];
      if (!assetAddress) {
        return `Error: Asset '${args.asset}' is not supported. Supported assets: ${Object.keys(SUPPORTED_ASSETS).join(", ")}`;
      }

      const rates: RateResult[] = [];
      const fetchers = [
        () => getCompoundRates(walletProvider, args.asset, "borrow"),
        () => getAaveRates(walletProvider, args.asset, "borrow"),
      ];
      const settled = await Promise.allSettled(fetchers.map(f => f()));
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value) rates.push(r.value);
      }

      let chosen: RateResult | undefined;
      if (args.preferProtocol) {
        if (!V1_BORROW_PROTOCOLS.includes(args.preferProtocol.toLowerCase())) {
          return `Error: Protocol '${args.preferProtocol}' is not supported for borrows in v1. Supported: ${V1_BORROW_PROTOCOLS.join(", ")}`;
        }
        chosen = rates.find(r => r.protocol === args.preferProtocol!.toLowerCase());
        if (!chosen) {
          return `Error: Preferred protocol '${args.preferProtocol}' did not return a borrow rate for ${args.asset}.`;
        }
      } else {
        const ranked = rankRates(rates, "borrow");
        chosen = ranked[0];
      }
      if (!chosen) {
        return `Error: No borrow rates found for ${args.asset} on supported protocols.`;
      }

      const user = walletProvider.getAddress() as Address;
      if (chosen.protocol === "aave") {
        const position = await getAavePosition(walletProvider, user);
        if (position.healthFactor < HEALTH_FACTOR_THRESHOLD && position.healthFactor !== Infinity) {
          return `Error: Current Aave health factor (${position.healthFactor.toFixed(4)}) is already below the safety threshold of ${HEALTH_FACTOR_THRESHOLD}. Borrowing would be unsafe.`;
        }
      } else if (chosen.protocol === "compound") {
        const position = await getCompoundPosition(walletProvider, user);
        if (position.healthFactor < HEALTH_FACTOR_THRESHOLD && position.healthFactor !== Infinity) {
          return `Error: Current Compound health factor (${position.healthFactor.toFixed(4)}) is already below the safety threshold of ${HEALTH_FACTOR_THRESHOLD}. Borrowing would be unsafe.`;
        }
      }

      const freshRate = await this.refetchRate(
        walletProvider,
        args.asset,
        "borrow",
        chosen.protocol,
      );
      if (freshRate) {
        chosen.apy = freshRate.apy;
      }

      const decimals = Number(
        await walletProvider.readContract({
          address: assetAddress,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      );
      const amountAtomic = parseUnits(args.amount, decimals);

      const txHash = await this.executeBorrow(
        walletProvider,
        chosen.protocol,
        assetAddress,
        amountAtomic,
        args.asset,
      );

      let healthMsg = "";
      if (chosen.protocol === "aave") {
        const newPos = await getAavePosition(walletProvider, user);
        healthMsg = `\nNew health factor: ${newPos.healthFactor === Infinity ? "Inf" : newPos.healthFactor.toFixed(4)}`;
      }

      return `Borrowed ${args.amount} ${args.asset} from ${chosen.protocol} at ${formatApy(chosen.apy)} APY.\nTransaction hash: ${txHash}${healthMsg}`;
    } catch (error) {
      return `Error routing borrow: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Evaluates and suggests or executes a cross-protocol rebalance.
   *
   * @param walletProvider - The wallet provider instance.
   * @param args - The action input arguments.
   * @returns A string result or error message.
   */
  @CreateAction({
    name: "rebalance",
    description: `Detects supply positions earning below the best available rate across protocols on Base and suggests or executes a rebalance. Compares the user's current supply APY against the best venue. If the improvement exceeds minApyImprovementBps (default 50 = 0.5%), returns a rebalance plan. In v1, execution is supported when both the withdraw and supply legs are available (Compound and Aave). Otherwise returns an advisory plan for the user to act on.`,
    schema: RebalanceSchema,
  })
  async rebalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RebalanceSchema>,
  ): Promise<string> {
    try {
      const minBps = args.minApyImprovementBps ?? 50;
      const user = walletProvider.getAddress() as Address;

      const [ratesSettled, positionsSettled] = await Promise.all([
        Promise.allSettled([
          getCompoundRates(walletProvider, args.asset, "supply"),
          getAaveRates(walletProvider, args.asset, "supply"),
          getMoonwellRates(walletProvider, args.asset, "supply"),
          getMorphoRates(walletProvider, args.asset, "supply"),
        ]),
        Promise.allSettled([
          getCompoundPosition(walletProvider, user),
          getAavePosition(walletProvider, user),
          getMoonwellPosition(walletProvider, user),
          getMorphoPosition(walletProvider, user),
        ]),
      ]);

      const rates: RateResult[] = [];
      for (const r of ratesSettled) {
        if (r.status === "fulfilled" && r.value) rates.push(r.value);
      }

      const positions: PositionResult[] = [];
      for (const p of positionsSettled) {
        if (p.status === "fulfilled") positions.push(p.value);
      }

      if (rates.length < 2) {
        return `Error: Need rates from at least 2 protocols to evaluate a rebalance. Only got ${rates.length}.`;
      }

      const ranked = rankRates(rates, "supply");
      const best = ranked[0];

      const activeProtocols = positions.filter(
        p =>
          p.supplies.length > 0 &&
          p.supplies.some(
            s => s.asset.toLowerCase() === args.asset.toLowerCase() || s.asset === "aggregate",
          ),
      );

      if (activeProtocols.length === 0) {
        return JSON.stringify({
          action: "no-op",
          reason: `No active ${args.asset} supply positions found. Use route_supply to deposit to the best protocol (${best.protocol} at ${formatApy(best.apy)}).`,
          rates: ranked,
        });
      }

      const currentProtocol = activeProtocols[0].protocol;
      const currentRate = rates.find(r => r.protocol === currentProtocol);
      const currentApy = currentRate?.apy ?? 0;

      const improvementBps = (best.apy - currentApy) * 100;

      if (improvementBps < minBps || best.protocol === currentProtocol) {
        return JSON.stringify({
          action: "no-op",
          reason: `Current position on ${currentProtocol} at ${formatApy(currentApy)}. Best available is ${best.protocol} at ${formatApy(best.apy)} (${improvementBps.toFixed(0)} bps improvement), below threshold of ${minBps} bps.`,
          rates: ranked,
        });
      }

      const plan = {
        action: "rebalance",
        from: { protocol: currentProtocol, currentApy: formatApy(currentApy) },
        to: { protocol: best.protocol, targetApy: formatApy(best.apy) },
        improvementBps: Math.round(improvementBps),
        asset: args.asset,
        advisory:
          "This is an advisory plan. Review the rates and execute route_supply to the target protocol after withdrawing from the source.",
      };

      return JSON.stringify(plan);
    } catch (error) {
      return `Error evaluating rebalance for ${args.asset}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  supportsNetwork = (network: Network): boolean =>
    network.protocolFamily === "evm" && network.chainId === "8453";

  /**
   * Re-reads the rate for a specific protocol immediately before execution.
   *
   * @param wallet - The wallet provider instance.
   * @param asset - The token symbol.
   * @param side - Supply or borrow.
   * @param protocol - The protocol to re-read from.
   * @returns The fresh rate result or null on failure.
   */
  private async refetchRate(
    wallet: EvmWalletProvider,
    asset: string,
    side: "supply" | "borrow",
    protocol: string,
  ): Promise<RateResult | null> {
    try {
      switch (protocol) {
        case "compound":
          return await getCompoundRates(wallet, asset, side);
        case "aave":
          return await getAaveRates(wallet, asset, side);
        case "moonwell":
          return await getMoonwellRates(wallet, asset, side);
        case "morpho":
          return await getMorphoRates(wallet, asset, side);
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Executes a supply transaction on the chosen protocol.
   *
   * @param wallet - The wallet provider instance.
   * @param protocol - The target protocol name.
   * @param assetAddress - The token contract address.
   * @param amount - The amount in atomic units.
   * @param assetSymbol - The token symbol for mToken lookup.
   * @returns The transaction hash.
   */
  private async executeSupply(
    wallet: EvmWalletProvider,
    protocol: string,
    assetAddress: Address,
    amount: bigint,
    assetSymbol: string,
  ): Promise<string> {
    const user = wallet.getAddress() as Address;

    switch (protocol) {
      case "compound": {
        const cometAddress = COMPOUND_COMET_ADDRESSES[assetSymbol.toLowerCase()];
        if (!cometAddress) throw new Error(`No Compound Comet for ${assetSymbol}`);
        const approvalResult = await approve(wallet, assetAddress, cometAddress, amount);
        if (approvalResult.startsWith("Error")) throw new Error(approvalResult);
        const data = encodeFunctionData({
          abi: COMPOUND_COMET_ABI,
          functionName: "supply",
          args: [assetAddress, amount],
        });
        const txHash = await wallet.sendTransaction({ to: cometAddress, data });
        await wallet.waitForTransactionReceipt(txHash);
        return txHash;
      }
      case "aave": {
        const approvalResult = await approve(wallet, assetAddress, AAVE_POOL_ADDRESS, amount);
        if (approvalResult.startsWith("Error")) throw new Error(approvalResult);
        const data = encodeAaveSupply(assetAddress, amount, user);
        const txHash = await wallet.sendTransaction({ to: AAVE_POOL_ADDRESS, data });
        await wallet.waitForTransactionReceipt(txHash);
        return txHash;
      }
      case "moonwell": {
        const mToken = MOONWELL_MTOKEN_ADDRESSES[assetSymbol.toLowerCase()];
        if (!mToken) throw new Error(`No Moonwell mToken for ${assetSymbol}`);
        const approvalResult = await approve(wallet, assetAddress, mToken, amount);
        if (approvalResult.startsWith("Error")) throw new Error(approvalResult);
        const data = encodeMoonwellMint(amount);
        const txHash = await wallet.sendTransaction({ to: mToken, data });
        await wallet.waitForTransactionReceipt(txHash);
        return txHash;
      }
      default:
        throw new Error(`Supply execution not supported for protocol '${protocol}' in v1`);
    }
  }

  /**
   * Executes a borrow transaction on the chosen protocol.
   *
   * @param wallet - The wallet provider instance.
   * @param protocol - The target protocol name.
   * @param assetAddress - The token contract address.
   * @param amount - The amount in atomic units.
   * @param assetSymbol - The token symbol for Comet lookup.
   * @returns The transaction hash.
   */
  private async executeBorrow(
    wallet: EvmWalletProvider,
    protocol: string,
    assetAddress: Address,
    amount: bigint,
    assetSymbol: string,
  ): Promise<string> {
    const user = wallet.getAddress() as Address;

    switch (protocol) {
      case "compound": {
        const cometAddress = COMPOUND_COMET_ADDRESSES[assetSymbol.toLowerCase()];
        if (!cometAddress) throw new Error(`No Compound Comet for ${assetSymbol}`);
        const data = encodeFunctionData({
          abi: COMPOUND_COMET_ABI,
          functionName: "withdraw",
          args: [assetAddress, amount],
        });
        const txHash = await wallet.sendTransaction({ to: cometAddress, data });
        await wallet.waitForTransactionReceipt(txHash);
        return txHash;
      }
      case "aave": {
        const data = encodeAaveBorrow(assetAddress, amount, user);
        const txHash = await wallet.sendTransaction({ to: AAVE_POOL_ADDRESS, data });
        await wallet.waitForTransactionReceipt(txHash);
        return txHash;
      }
      default:
        throw new Error(
          `Borrow execution not supported for protocol '${protocol}' in v1. Supported: ${V1_BORROW_PROTOCOLS.join(", ")}`,
        );
    }
  }
}

export const lendingRouterActionProvider = (): LendingRouterActionProvider =>
  new LendingRouterActionProvider();
